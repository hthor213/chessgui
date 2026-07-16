#!/usr/bin/env python3
"""error_model.py — spec 214 contract step 5: corpus-derived error model.

Learns P(mistake | eval, phase, clock, Elo band) by streaming the filtered
corpus months (output of run_month.py) and classifying EVERY move that has an
[%eval] tag before and after it:

    eval bucket   mover-POV eval BEFORE the move, 0.5-pawn (50 cp) buckets,
                  clamped to [-5.0, +5.0) (mate tags land in the end buckets)
    phase         persona.rs formula (persona_sim.phase_weight semantics):
                  knights+bishops x1, rooks x2, queens x4, BOTH sides
                  (24 at the start); endgame if <= 8, else opening while
                  ply < 16, else middlegame. Endgame wins over the ply test.
    clock bucket  mover's remaining clock from [%clk] after the move:
                  600plus / 300-600 / 120-300 / 60-120 / 30-60 / lt30 / none
    band          the MOVER's 100-Elo band (mine_cliffs.py convention for
                  attributing a mistake to who made it — NOT pgnstream's
                  lower-of-two filter band)
    mistake       mover-POV eval drop >= 1.0 pawn (100 cp), [%eval] tags only

NO ENGINE RE-VERIFICATION — deliberate, and the opposite of spec 211 puzzle
mining. There every candidate is individually load-bearing (one bad tag = one
bad puzzle), so Stockfish re-checks each one. Here the model is DISTRIBUTIONAL:
rates over millions of moves per cell, where lichess [%eval] tag noise (shallow
server analysis) is unbiased enough to average out, and re-verifying ~10^9
moves would cost months of engine time for a correction the aggregate doesn't
need. Documented per spec 214 step 5 ("this is never random noise-weakening" —
the model conditions WHEN mistakes happen; it does not inject noise).

Output: one <month>.errmodel.json per input (counts per cell + meta), with a
<month>.errmodel.done.json marker (run_month.py convention, idempotent). Then
`--merge` sums all months in --out-dir into error_model.json with rates.

Requires python-chess (same deviation as mine_cliffs.py, same reason: SAN
replay). Streaming: one game buffered at a time.

Homeserver invocation (batch policy spec 217: 2 cores, self-niced — the
script nices itself to 19 by default):
    python3 scripts/mining/error_model.py ~/chess-corpus/months/*.pgn \\
        --out-dir ~/chess-corpus/error-model --workers 2 --merge
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import pgnstream
from pgnstream import band_of, iter_games, pgn_lines

try:
    import chess
except ImportError:
    sys.exit("[error_model] python-chess is required for SAN replay:\n"
             "  python3 -m pip install --user python-chess")

GENERATOR = "error_model.py v1"

# Mistake threshold: mover-POV eval drop >= 1.0 pawn (spec 214 step 5).
MISTAKE_DROP_CP = 100

# Eval buckets: 50 cp (0.5 pawn), clamped to [-500, +500).
EVAL_BUCKET_CP = 50
EVAL_CLAMP_CP = 500

# persona.rs / persona_sim.py phase constants (calibration.rs formula).
ENDGAME_PHASE_MAX = 8
OPENING_MAX_PLY = 16

# Clock buckets: (lower-edge seconds, label), checked top-down; None-clk -> "none".
CLOCK_BUCKETS = [(600, "600plus"), (300, "300-600"), (120, "120-300"),
                 (60, "60-120"), (30, "30-60"), (0, "lt30")]

# Movetext tokens — same grammar as mine_cliffs.py.
TOKEN_RE = re.compile(r"\{([^}]*)\}|[()]|\$\d+|[^\s{}()]+")
EVAL_RE = re.compile(r"\[%eval\s+([#0-9.+-]+)")
CLK_RE = re.compile(r"\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)")
MOVENUM_RE = re.compile(r"\d+\.*$")
RESULTS = {"1-0", "0-1", "1/2-1/2", "*"}

MATE_CP = 10_000  # uciengine.MATE_CP convention (kept inline: no engine here)


def eval_tag_to_cp(s):
    """'0.17' | '-1.5' | '#3' | '#-2' -> white-perspective cp int, or None."""
    try:
        if s.startswith("#"):
            n = int(s[1:])
            return (MATE_CP - n) if n > 0 else (-MATE_CP - n)
        return round(float(s) * 100)
    except ValueError:
        return None


def clk_to_seconds(comment):
    """'[%clk 0:09:50]' payload -> 590 (int seconds), or None."""
    m = CLK_RE.search(comment)
    if not m:
        return None
    h, mi, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
    return int(h * 3600 + mi * 60 + s)


def parse_movetext(text):
    """Movetext str -> (sans, evals_cp, clks_sec) parallel lists, or None on
    variations. evals_cp[i]/clks_sec[i] annotate move i (the tag in its
    trailing comment), each None when absent."""
    sans, evals, clks = [], [], []
    for m in TOKEN_RE.finditer(text):
        tok = m.group(0)
        if tok.startswith("{"):
            if sans:
                body = m.group(1)
                ev = EVAL_RE.search(body)
                if ev:
                    evals[-1] = eval_tag_to_cp(ev.group(1))
                ck = clk_to_seconds(body)
                if ck is not None:
                    clks[-1] = ck
            continue
        if tok in "()":
            return None  # variations unsupported (never in lichess dumps)
        if tok in RESULTS:
            break
        if tok.startswith("$") or MOVENUM_RE.fullmatch(tok):
            continue
        sans.append(tok.rstrip("!?"))
        evals.append(None)
        clks.append(None)
    return sans, evals, clks


def eval_bucket(cp):
    """Mover-POV cp -> '+0.0' style lower-edge label, 50 cp wide, clamped."""
    cp = max(-EVAL_CLAMP_CP, min(EVAL_CLAMP_CP - 1, cp))
    lower = (cp // EVAL_BUCKET_CP) * EVAL_BUCKET_CP
    return f"{lower / 100:+.1f}"


def clock_bucket(seconds):
    if seconds is None:
        return "none"
    for lo, label in CLOCK_BUCKETS:
        if seconds >= lo:
            return label
    return "lt30"  # negative seconds shouldn't happen; bucket defensively


def phase_weight(board):
    """persona.rs phase_weight_of: N+B x1, R x2, Q x4, both sides (24 start)."""
    return (
        chess.popcount(board.knights)
        + chess.popcount(board.bishops)
        + 2 * chess.popcount(board.rooks)
        + 4 * chess.popcount(board.queens)
    )


def phase_for(pw, ply):
    """persona.rs phase_for: endgame (material) wins over the ply test."""
    if pw <= ENDGAME_PHASE_MAX:
        return "endgame"
    if ply < OPENING_MAX_PLY:
        return "opening"
    return "middlegame"


def int_header(headers, key):
    v = headers.get(key.encode())
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def classify_game(headers, text, cells, stats):
    """Replay one game, adding [moves, mistakes] into `cells` keyed
    'band|phase|eval|clock'. Returns nothing; mutates cells/stats."""
    movetext = " ".join(
        ln for ln in text.decode("utf-8", "replace").splitlines()
        if not ln.startswith("["))
    parsed = parse_movetext(movetext)
    if parsed is None:
        stats["parse_skipped"] += 1
        return
    sans, evals, clks = parsed
    if not any(e is not None for e in evals):
        return
    stats["games_used"] += 1

    welo = int_header(headers, "WhiteElo")
    belo = int_header(headers, "BlackElo")

    board = chess.Board()
    try:
        # Move 0 has no eval-before; it seeds the replay only.
        for i, san in enumerate(sans):
            pw = phase_weight(board)
            if i >= 1 and evals[i - 1] is not None and evals[i] is not None:
                mover_white = (i % 2 == 0)
                elo = welo if mover_white else belo
                if elo is not None:
                    sign = 1 if mover_white else -1
                    before = sign * evals[i - 1]
                    after = sign * evals[i]
                    key = "|".join((
                        band_of(elo),
                        phase_for(pw, i),
                        eval_bucket(before),
                        clock_bucket(clks[i]),
                    ))
                    cell = cells.get(key)
                    if cell is None:
                        cell = cells[key] = [0, 0]
                    cell[0] += 1
                    if before - after >= MISTAKE_DROP_CP:
                        cell[1] += 1
                    stats["moves_classified"] += 1
                    stats["mistakes"] += (before - after >= MISTAKE_DROP_CP)
            board.push_san(san)
    except ValueError:
        stats["parse_skipped"] += 1


def process_file(path, out_dir, progress_every=50000):
    stem = re.sub(r"\.pgn(\.zst)?$", "", os.path.basename(path))
    out_path = os.path.join(out_dir, f"{stem}.errmodel.json")
    done_path = os.path.join(out_dir, f"{stem}.errmodel.done.json")
    if os.path.exists(done_path):
        print(f"[error_model] {stem} already done; skipping.", file=sys.stderr)
        return
    cells = {}
    stats = {"games_seen": 0, "games_used": 0, "moves_classified": 0,
             "mistakes": 0, "parse_skipped": 0}
    started = time.time()

    for headers, text, _reject, has_eval in iter_games(pgn_lines(path)):
        stats["games_seen"] += 1
        if progress_every and stats["games_seen"] % progress_every == 0:
            el = time.time() - started
            print(f"  [error_model {stem}] games {stats['games_seen']:,}"
                  f" | moves {stats['moves_classified']:,}"
                  f" | mistakes {stats['mistakes']:,}"
                  f" | {stats['games_seen'] / el:,.0f} games/s | {el:.0f}s",
                  file=sys.stderr, flush=True)
        if not has_eval or text is None:
            continue
        classify_game(headers, text, cells, stats)

    doc = {
        "meta": {
            "input": os.path.abspath(path),
            "generator": GENERATOR,
            "spec": "214 contract step 5",
            "engine_verification": ("none — distributional model over "
                                    "[%eval] tags (see module docstring)"),
            "mistake_drop_cp": MISTAKE_DROP_CP,
            "eval_bucket_cp": EVAL_BUCKET_CP,
            "cell_key": "band|phase|eval_bucket_lower|clock_bucket",
            "elapsed_seconds": round(time.time() - started, 1),
            "finished_at": datetime.now(timezone.utc).isoformat(),
            **stats,
        },
        "cells": {k: {"moves": v[0], "mistakes": v[1]}
                  for k, v in sorted(cells.items())},
    }
    tmp = out_path + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1)
    os.replace(tmp, out_path)
    with open(done_path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(doc["meta"], f, indent=2)
    os.replace(done_path + ".tmp", done_path)  # marker lands last
    print(f"[error_model] {stem} done: {stats['games_seen']:,} games, "
          f"{stats['moves_classified']:,} moves, {stats['mistakes']:,} "
          f"mistakes, {len(cells):,} cells "
          f"({time.time() - started:.0f}s)", file=sys.stderr)


def merge(out_dir):
    """Sum every <month>.errmodel.json in out_dir -> error_model.json w/ rates."""
    months, cells = [], {}
    for name in sorted(os.listdir(out_dir)):
        if not name.endswith(".errmodel.json"):
            continue
        with open(os.path.join(out_dir, name), encoding="utf-8") as f:
            doc = json.load(f)
        months.append(name)
        for k, v in doc["cells"].items():
            cell = cells.setdefault(k, [0, 0])
            cell[0] += v["moves"]
            cell[1] += v["mistakes"]
    merged = {
        "meta": {
            "generator": GENERATOR,
            "spec": "214 contract step 5",
            "months": months,
            "cell_key": "band|phase|eval_bucket_lower|clock_bucket",
            "mistake_drop_cp": MISTAKE_DROP_CP,
            "total_moves": sum(v[0] for v in cells.values()),
            "total_mistakes": sum(v[1] for v in cells.values()),
            "merged_at": datetime.now(timezone.utc).isoformat(),
        },
        "cells": {k: {"moves": v[0], "mistakes": v[1],
                      "rate": round(v[1] / v[0], 6) if v[0] else None}
                  for k, v in sorted(cells.items())},
    }
    path = os.path.join(out_dir, "error_model.json")
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=1)
    os.replace(tmp, path)
    print(f"[error_model] merged {len(months)} months -> {path} "
          f"({merged['meta']['total_moves']:,} moves, "
          f"{merged['meta']['total_mistakes']:,} mistakes, "
          f"{len(cells):,} cells)", file=sys.stderr)


def parse_args():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("months", nargs="*",
                   help="Corpus month PGNs (.pgn or .pgn.zst).")
    p.add_argument("--out-dir", default="error-model",
                   help="Output dir for per-month JSON + done markers.")
    p.add_argument("--workers", type=int, default=1,
                   help="Parallel month processes (spec 217 batch cap: 2).")
    p.add_argument("--merge", action="store_true",
                   help="After processing (or alone), merge all months in "
                        "--out-dir into error_model.json with rates.")
    p.add_argument("--progress-every", type=int, default=50000,
                   help="stderr progress line every N games (0 = off).")
    p.add_argument("--no-nice", action="store_true",
                   help="Don't renice to 19 (default: self-nice, pipeline "
                        "convention / spec 217 policy).")
    return p.parse_args()


def main():
    args = parse_args()
    if not args.no_nice:
        try:
            os.nice(19)  # workers inherit it
        except OSError:
            pass
    os.makedirs(args.out_dir, exist_ok=True)
    if args.months:
        if args.workers > 1 and len(args.months) > 1:
            import multiprocessing as mp
            with mp.Pool(args.workers) as pool:
                pool.starmap(process_file,
                             [(m, args.out_dir, args.progress_every)
                              for m in args.months])
        else:
            for m in args.months:
                process_file(m, args.out_dir, args.progress_every)
    if args.merge:
        merge(args.out_dir)
    if not args.months and not args.merge:
        print("[error_model] nothing to do (no months, no --merge).",
              file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        pgnstream.exit_on_broken_pipe()

#!/usr/bin/env python3
"""mine_cliffs.py — spec 211 Tier-1 eval-cliff puzzle generator.

Scans eval-tagged corpus months (output of run_month.py) for single-move
eval cliffs per specs/211-avoidance-puzzles.md:45-51:

    position eval within ±1.0 (side-to-move perspective, from [%eval])
    -> the human plays move M
    -> eval after M ≤ -1.5 for the mover, or mate against the mover.

The position before M is the puzzle; M is the trap move. Every candidate is
RE-VERIFIED with local Stockfish at fixed depth (spec: "don't trust [%eval]
alone"): the refutation must confirm at ≥ the cliff threshold, the
pre-position must not already be lost, and the pre-position must offer
≥ 3 reasonable alternative moves (within --safe-window cp of best AND above
--lost-threshold), else the candidate is dropped.

Output: one JSONL file per input month (spec 211 names the `puzzles` table
columns but no interchange format and the app DB has no puzzles table yet,
so this emits JSONL; scripts/mining/import_puzzles.py loads it into a
SQLite `puzzles` table with the spec's columns). Row schema is documented
in ROW_SCHEMA below. Idempotent per input file via <stem>.cliffs.done.json
markers, run_month.py-style. Streaming: one game buffered at a time.

Requires `python-chess` (the one deviation from the pipeline's stdlib-only
rule — SAN replay/legality is exactly the hand-rolled chess math to avoid):
    python3 -m pip install --user python-chess

Homeserver invocation (engine verification dominates runtime; use --limit
for a bounded first batch and check the candidate stats before a full run):
    python3 scripts/mining/mine_cliffs.py ~/chess-corpus/months/*.pgn \\
        --engine ~/engines/sf_18 --depth 16 \\
        --out-dir ~/chess-corpus/puzzles --threads 2
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
from uciengine import MATE_CP, UciEngine

try:
    import chess
except ImportError:
    sys.exit("[mine_cliffs] python-chess is required for SAN replay:\n"
             "  python3 -m pip install --user python-chess")

GENERATOR = "mine_cliffs.py v1"

ROW_SCHEMA = """Each JSONL row (all evals in centipawns, MOVER's perspective):
  fen               pre-cliff position, side to move = the puzzle's player
  trap_uci/trap_san the human-played losing move
  refutation_line   engine PV after the trap (list of UCI), the rake itself
  played_reply_san  what the opponent actually played in the game (may be null)
  eval_before_cp    [%eval] before the trap (tag data, not engine)
  eval_after_cp     [%eval] after the trap (tag data, not engine)
  verified_pre_best_cp / verified_after_cp   Stockfish re-verification evals
  n_alternatives    reasonable non-trap moves found in MultiPV (>= 3)
  safe_threshold_cp the "within X of best" window used (grading threshold)
  mate              true if the verified refutation is a forced mate
  engine_verify_depth, mover, ply, move_number
  white_elo/black_elo/band   band = MOVER's 100-Elo band (who stepped on it)
  source_game_id/site/date/time_control/source_file, generator, created_at"""

# Movetext tokens: {comment} | variation parens | $NAG | anything else (SAN,
# move numbers, results). Lichess dumps have no variations; '(' aborts a game.
TOKEN_RE = re.compile(r"\{([^}]*)\}|[()]|\$\d+|[^\s{}()]+")
EVAL_RE = re.compile(r"\[%eval\s+([#0-9.+-]+)")
MOVENUM_RE = re.compile(r"\d+\.*$")
RESULTS = {"1-0", "0-1", "1/2-1/2", "*"}


def eval_tag_to_cp(s):
    """'0.17' | '-1.5' | '#3' | '#-2' -> white-perspective cp int, or None."""
    try:
        if s.startswith("#"):
            n = int(s[1:])
            return (MATE_CP - n) if n > 0 else (-MATE_CP - n)
        return round(float(s) * 100)
    except ValueError:
        return None


def parse_movetext(text):
    """Movetext str -> (sans, evals_cp) parallel lists, or None on variations.

    evals_cp[i] is the white-perspective [%eval] after move i, or None.
    """
    sans, evals = [], []
    for m in TOKEN_RE.finditer(text):
        tok = m.group(0)
        if tok.startswith("{"):
            ev = EVAL_RE.search(m.group(1))
            if ev and sans:
                evals[-1] = eval_tag_to_cp(ev.group(1))
            continue
        if tok in "()":
            return None  # variations unsupported (never in lichess dumps)
        if tok in RESULTS:
            break
        if tok.startswith("$") or MOVENUM_RE.fullmatch(tok):
            continue
        sans.append(tok.rstrip("!?"))
        evals.append(None)
    return sans, evals


def find_candidates(evals, pre_window, cliff):
    """Cheap [%eval]-only scan. Yields ply indices where the mover stepped
    off a cliff: |eval_before| <= pre_window and eval_after <= -cliff, both
    from the mover's perspective. Runs before any board replay."""
    for i in range(1, len(evals)):
        eb_w, ea_w = evals[i - 1], evals[i]
        if eb_w is None or ea_w is None:
            continue
        sign = 1 if i % 2 == 0 else -1  # mover is white on even plies
        if abs(sign * eb_w) <= pre_window and sign * ea_w <= -cliff:
            yield i


def header(headers, key):
    v = headers.get(key.encode())
    return v.decode("utf-8", "replace") if v is not None else None


def int_header(headers, key):
    v = header(headers, key)
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


class Verifier:
    """Engine re-verification of one candidate (spec 211:50-51)."""

    def __init__(self, engine, args):
        self.engine = engine
        self.a = args

    def verify(self, fen, trap_uci):
        """Returns (row_fields dict) or (None, reject_reason)."""
        a = self.a
        # Refutation first: it is the cheapest search (MultiPV=1) and kills
        # most false-positive [%eval] tags before the MultiPV search runs.
        post = self.engine.search(fen, a.depth, moves=[trap_uci], multipv=1)
        if post is None or 1 not in post:
            return None, "terminal_after_trap"
        refut = post[1]
        if refut.cp < a.cliff:  # opponent (stm) perspective
            return None, "verify_eval"

        pre = self.engine.search(fen, a.depth, multipv=a.multipv)
        if pre is None or 1 not in pre:
            return None, "terminal_pre"
        best = pre[1].cp  # mover (stm) perspective
        if not (-a.pre_window <= best <= a.verify_pre_max):
            return None, "verify_pre_window"
        floor = max(best - a.safe_window, -a.lost_threshold)
        n_alt = sum(1 for ln in pre.values()
                    if ln.move != trap_uci and ln.cp >= floor)
        if n_alt < a.min_alternatives:
            return None, "few_alternatives"

        return {
            "refutation_line": refut.pv[:a.refutation_plies],
            "verified_after_cp": -refut.cp,     # mover's perspective
            "verified_pre_best_cp": best,
            "n_alternatives": n_alt,
            "mate": refut.mate is not None,
        }, None


def mine_file(path, engine, args, out_dir):
    stem = re.sub(r"\.pgn(\.zst)?$", "", os.path.basename(path))
    out_path = os.path.join(out_dir, f"{stem}.cliffs.jsonl")
    done_path = os.path.join(out_dir, f"{stem}.cliffs.done.json")
    if os.path.exists(done_path):
        print(f"[mine_cliffs] {stem} already done ({done_path}); skipping.",
              file=sys.stderr)
        return
    part = out_path + ".part"

    verifier = Verifier(engine, args)
    stats = {"games_seen": 0, "games_with_eval": 0, "games_with_candidates": 0,
             "candidates": 0, "puzzles": 0, "rejected": {}, "by_band": {},
             "parse_skipped": 0}
    started = time.time()
    limit_hit = False

    def reject(reason):
        stats["rejected"][reason] = stats["rejected"].get(reason, 0) + 1

    with open(part, "w", encoding="utf-8") as out:
        for headers, text, _reject, has_eval in iter_games(pgn_lines(path)):
            stats["games_seen"] += 1
            if args.progress_every and \
                    stats["games_seen"] % args.progress_every == 0:
                el = time.time() - started
                print(f"  [mine_cliffs {stem}] games {stats['games_seen']:,}"
                      f" | candidates {stats['candidates']:,}"
                      f" | puzzles {stats['puzzles']:,}"
                      f" | {stats['games_seen'] / el:,.0f} games/s | {el:.0f}s",
                      file=sys.stderr, flush=True)
            if not has_eval:
                continue
            stats["games_with_eval"] += 1

            movetext = " ".join(
                ln for ln in text.decode("utf-8", "replace").splitlines()
                if not ln.startswith("["))
            parsed = parse_movetext(movetext)
            if parsed is None:
                stats["parse_skipped"] += 1
                continue
            sans, evals = parsed
            cand_plies = list(find_candidates(evals, args.pre_window,
                                              args.cliff))
            if not cand_plies:
                continue
            stats["games_with_candidates"] += 1
            if args.max_per_game:
                cand_plies = cand_plies[:args.max_per_game]

            # One replay per game, stopped after the last candidate ply.
            board = chess.Board()
            cands = []
            try:
                for i, san in enumerate(sans[:cand_plies[-1] + 1]):
                    if i in cand_plies:
                        cands.append((i, board.fen(), san))
                    board.push_san(san)
            except ValueError:
                stats["parse_skipped"] += 1
                continue

            for ply, fen, san in cands:
                stats["candidates"] += 1
                b = chess.Board(fen)
                trap = b.parse_san(san)
                b.push(trap)
                if b.is_game_over():
                    reject("terminal_after_trap")
                    continue
                fields, why = verifier.verify(fen, trap.uci())
                if why:
                    reject(why)
                    continue

                mover = "white" if ply % 2 == 0 else "black"
                sign = 1 if mover == "white" else -1
                welo = int_header(headers, "WhiteElo")
                belo = int_header(headers, "BlackElo")
                mover_elo = welo if mover == "white" else belo
                band = band_of(mover_elo) if mover_elo is not None else "?"
                site = header(headers, "Site") or ""
                row = {
                    "fen": fen,
                    "trap_uci": trap.uci(),
                    "trap_san": san,
                    "played_reply_san": (sans[ply + 1]
                                         if ply + 1 < len(sans) else None),
                    "eval_before_cp": sign * evals[ply - 1],
                    "eval_after_cp": sign * evals[ply],
                    "safe_threshold_cp": args.safe_window,
                    "engine_verify_depth": args.depth,
                    "mover": mover,
                    "ply": ply,
                    "move_number": ply // 2 + 1,
                    "white_elo": welo,
                    "black_elo": belo,
                    "band": band,
                    "source_game_id": site.rstrip("/").rsplit("/", 1)[-1],
                    "site": site,
                    "date": header(headers, "UTCDate") or header(headers,
                                                                 "Date"),
                    "time_control": header(headers, "TimeControl"),
                    "source_file": os.path.basename(path),
                    "generator": GENERATOR,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                }
                row.update(fields)
                out.write(json.dumps(row) + "\n")
                stats["puzzles"] += 1
                stats["by_band"][band] = stats["by_band"].get(band, 0) + 1
                if args.limit and stats["puzzles"] >= args.limit:
                    limit_hit = True
                    break
            if limit_hit:
                break

    os.replace(part, out_path)
    stats.update({
        "input": os.path.abspath(path),
        "output": os.path.abspath(out_path),
        "limit_hit": limit_hit,
        "params": {k: getattr(args, k) for k in
                   ("depth", "multipv", "pre_window", "cliff", "safe_window",
                    "lost_threshold", "verify_pre_max", "min_alternatives",
                    "max_per_game", "refutation_plies")},
        "engine": args.engine,
        "generator": GENERATOR,
        "elapsed_seconds": round(time.time() - started, 1),
        "finished_at": datetime.now(timezone.utc).isoformat(),
    })
    stats["rejected"] = dict(sorted(stats["rejected"].items()))
    stats["by_band"] = dict(sorted(stats["by_band"].items()))
    if limit_hit:
        # A capped run is a sample, not the month: no done-marker, so a
        # future uncapped run redoes it. The JSONL + stats still land.
        with open(out_path.replace(".jsonl", ".stats.json"), "w",
                  encoding="utf-8") as f:
            json.dump(stats, f, indent=2)
        print(f"[mine_cliffs] {stem}: LIMIT HIT at {stats['puzzles']} puzzles "
              f"— no done-marker written (partial month).", file=sys.stderr)
    else:
        tmp = done_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(stats, f, indent=2)
        os.replace(tmp, done_path)  # marker lands last, atomically
    print(f"[mine_cliffs] {stem} done: {stats['games_seen']:,} games, "
          f"{stats['candidates']:,} candidates -> {stats['puzzles']:,} "
          f"puzzles ({stats['elapsed_seconds']:.0f}s)", file=sys.stderr)
    print("[mine_cliffs] " + json.dumps(stats), file=sys.stderr)


def parse_args():
    p = argparse.ArgumentParser(
        description=__doc__ + "\n\n" + ROW_SCHEMA,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("months", nargs="+",
                   help="Corpus month PGNs (.pgn or .pgn.zst), e.g. "
                        "~/chess-corpus/months/2026-05.pgn")
    p.add_argument("--engine", required=True,
                   help="Path to a UCI engine (local Stockfish) for the "
                        "mandatory re-verification pass.")
    p.add_argument("--depth", type=int, default=16,
                   help="Fixed verification depth (default 16; spec pins "
                        "'fixed depth' but not a number).")
    p.add_argument("--out-dir", default="puzzles",
                   help="Output dir for <month>.cliffs.jsonl + done markers "
                        "(default ./puzzles).")
    p.add_argument("--threads", type=int, default=1,
                   help="Engine Threads (default 1).")
    p.add_argument("--hash-mb", type=int, default=128,
                   help="Engine Hash in MB (default 128).")
    p.add_argument("--pre-window", type=int, default=100,
                   help="[%%eval] gate: |eval before trap| <= this cp "
                        "(default 100 = spec's ±1.0).")
    p.add_argument("--cliff", type=int, default=150,
                   help="Cliff threshold cp: eval after trap <= -this for "
                        "the mover, tag AND engine (default 150 = spec's "
                        "-1.5).")
    p.add_argument("--safe-window", type=int, default=50,
                   help="A move is 'reasonable' within this cp of best "
                        "(default 50 = spec's grading example -0.5).")
    p.add_argument("--lost-threshold", type=int, default=100,
                   help="...AND not below -this cp ('not crossing into "
                        "lost', default 100).")
    p.add_argument("--verify-pre-max", type=int, default=150,
                   help="Reject if the engine says the pre-position was "
                        "already better than this cp for the mover — the "
                        "[%%eval] ±1.0 premise was false (default 150; the "
                        "low side reuses --pre-window).")
    p.add_argument("--min-alternatives", type=int, default=3,
                   help="Reasonable non-trap moves required (default 3, "
                        "spec 211:51).")
    p.add_argument("--multipv", type=int, default=4,
                   help="MultiPV for the alternatives search (default 4 = "
                        "3 alternatives + room for the trap in the list).")
    p.add_argument("--max-per-game", type=int, default=2,
                   help="Max candidates taken per game, earliest first "
                        "(default 2; 0 = all).")
    p.add_argument("--refutation-plies", type=int, default=10,
                   help="Max plies of refutation PV stored (default 10).")
    p.add_argument("--limit", type=int, default=0,
                   help="Stop a month after N verified puzzles (0 = off). "
                        "A limited month gets NO done-marker.")
    p.add_argument("--progress-every", type=int, default=10000,
                   help="stderr progress line every N games (0 = off).")
    p.add_argument("--no-nice", action="store_true",
                   help="Don't renice to 19 (default: self-nice like the "
                        "rest of the pipeline).")
    return p.parse_args()


def main():
    args = parse_args()
    if not args.no_nice:
        try:
            os.nice(19)  # engine inherits it; pipeline convention
        except OSError:
            pass
    os.makedirs(args.out_dir, exist_ok=True)
    engine = UciEngine(args.engine, threads=args.threads,
                       hash_mb=args.hash_mb)
    try:
        for path in args.months:
            mine_file(path, engine, args, args.out_dir)
    finally:
        engine.close()


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        pgnstream.exit_on_broken_pipe()

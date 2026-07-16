#!/usr/bin/env python3
"""sample_calm.py — spec 211 calm-position sampler (the generator's negative path).

Mixed decks need ~30% positions with NO rake ("the player must NOT learn
'there's always a trap'", specs/211-avoidance-puzzles.md:39-41). A calm
position is exactly what mine_cliffs.py rejects: an eval-tagged game whose
[%eval] track never produces a cliff candidate at all. This script walks the
same corpus files with the same parser, keeps only zero-candidate games, and
samples one mid-game position per game where the eval sits inside a narrow
window across the surrounding plies.

Every sample is then engine-verified as genuinely calm (same discipline as
the cliff generator — don't trust [%eval] alone): MultiPV search at fixed
depth must show best within ±--calm-window cp AND ≥ --min-safe-moves moves
within --safe-window of best (and above the lost bar). "Many moves are fine"
is the property being sold to the solver, so it is the property verified.

Output: JSONL, one calm row per line (schema below). The app bundles a
curated batch as lib/calm-positions.ts — regenerate with:

    python3 scripts/mining/sample_calm.py data/reference/pack_2024-01_partial.pgn \\
        --engine /opt/homebrew/bin/stockfish --limit 24 --out calm.jsonl

Row schema (evals in centipawns, MOVER's perspective):
  id                     stable key: "calm:<game_id>:<ply>"
  fen                    the calm position, side to move = the player
  verified_pre_best_cp   Stockfish best at --depth (grading baseline)
  n_safe_moves           MultiPV moves within the safe window (>= min)
  safe_threshold_cp / engine_verify_depth   grading params, as in cliffs
  mover, ply, band, white_elo, black_elo, source_game_id, site, date,
  time_control, source_file, generator, created_at
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

from mine_cliffs import find_candidates, header, int_header, parse_movetext
from pgnstream import band_of, iter_games, pgn_lines
from uciengine import UciEngine

try:
    import chess
except ImportError:
    sys.exit("[sample_calm] python-chess is required (same as mine_cliffs.py)")

GENERATOR = "sample_calm.py v1"


def calm_plies(evals, window, lo, hi):
    """Ply indices i where [%eval] exists and stays within ±window across
    plies i-1, i, i+1 — the flattest stretch of an already candidate-free
    game. White-perspective cp; |.| makes the mover irrelevant."""
    for i in range(max(lo, 1), min(hi, len(evals) - 1)):
        trio = evals[i - 1 : i + 2]
        if all(e is not None and abs(e) <= window for e in trio):
            yield i


def verify_calm(engine, fen, a):
    """Engine gate: best near equality AND many reasonable moves. Returns
    (verified_pre_best_cp, n_safe_moves) or None."""
    pre = engine.search(fen, a.depth, multipv=a.multipv)
    if pre is None or 1 not in pre:
        return None
    best = pre[1].cp  # mover (stm) perspective
    if abs(best) > a.calm_window:
        return None
    floor = max(best - a.safe_window, -a.lost_threshold)
    n_safe = sum(1 for ln in pre.values() if ln.cp >= floor)
    if n_safe < a.min_safe_moves:
        return None
    return best, n_safe


def sample_file(path, engine, args, out, stats):
    for headers, text, _reject, has_eval in iter_games(pgn_lines(path)):
        if stats["sampled"] >= args.limit:
            return
        stats["games_seen"] += 1
        if not has_eval:
            continue
        movetext = " ".join(
            ln for ln in text.decode("utf-8", "replace").splitlines()
            if not ln.startswith("["))
        parsed = parse_movetext(movetext)
        if parsed is None:
            continue
        sans, evals = parsed
        # The negative path: any cliff candidate anywhere disqualifies the
        # whole game — these are the games mine_cliffs.py yields nothing from.
        if any(True for _ in find_candidates(evals, args.pre_window, args.cliff)):
            continue
        picks = list(calm_plies(evals, args.calm_window, args.min_ply, args.max_ply))
        if not picks:
            continue
        ply = picks[len(picks) // 2]  # middle of the calm stretch

        board = chess.Board()
        try:
            for san in sans[:ply]:
                board.push_san(san)
        except ValueError:
            continue
        fen = board.fen()
        stats["candidates"] += 1
        verified = verify_calm(engine, fen, args)
        if verified is None:
            stats["engine_rejected"] += 1
            continue
        best, n_safe = verified

        mover = "white" if ply % 2 == 0 else "black"
        welo = int_header(headers, "WhiteElo")
        belo = int_header(headers, "BlackElo")
        mover_elo = welo if mover == "white" else belo
        band = band_of(mover_elo) if mover_elo is not None else "?"
        site = header(headers, "Site") or ""
        game_id = site.rstrip("/").rsplit("/", 1)[-1]
        out.write(json.dumps({
            "id": f"calm:{game_id}:{ply}",
            "fen": fen,
            "verified_pre_best_cp": best,
            "n_safe_moves": n_safe,
            "safe_threshold_cp": args.safe_window,
            "engine_verify_depth": args.depth,
            "mover": mover,
            "ply": ply,
            "band": band,
            "white_elo": welo,
            "black_elo": belo,
            "source_game_id": game_id,
            "site": site,
            "date": header(headers, "UTCDate") or header(headers, "Date"),
            "time_control": header(headers, "TimeControl"),
            "source_file": os.path.basename(path),
            "generator": GENERATOR,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }) + "\n")
        stats["sampled"] += 1


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("pgns", nargs="+", help="Eval-tagged PGNs (.pgn or .pgn.zst)")
    p.add_argument("--engine", required=True, help="UCI engine for calm verification")
    p.add_argument("--out", default="calm.jsonl")
    p.add_argument("--limit", type=int, default=24, help="Calm rows to sample")
    p.add_argument("--depth", type=int, default=16, help="Verify depth (as cliffs)")
    p.add_argument("--multipv", type=int, default=4)
    p.add_argument("--calm-window", type=int, default=60,
                   help="Engine best must be within ±this cp (default 60)")
    p.add_argument("--safe-window", type=int, default=50,
                   help="'Reasonable move' window vs best, as mine_cliffs")
    p.add_argument("--lost-threshold", type=int, default=100)
    p.add_argument("--min-safe-moves", type=int, default=3,
                   help="MultiPV moves that must be reasonable (default 3)")
    p.add_argument("--pre-window", type=int, default=100,
                   help="Cliff-candidate params for the negative gate —")
    p.add_argument("--cliff", type=int, default=150, help="— keep = mine_cliffs defaults")
    p.add_argument("--min-ply", type=int, default=16, help="Skip book moves")
    p.add_argument("--max-ply", type=int, default=80, help="Skip trivial endings")
    args = p.parse_args()

    engine = UciEngine(args.engine)
    stats = {"games_seen": 0, "candidates": 0, "engine_rejected": 0, "sampled": 0}
    try:
        with open(args.out, "w", encoding="utf-8") as out:
            for path in args.pgns:
                sample_file(path, engine, args, out, stats)
                if stats["sampled"] >= args.limit:
                    break
    finally:
        engine.close()
    print(f"[sample_calm] {json.dumps(stats)}", file=sys.stderr)
    if stats["sampled"] == 0:
        sys.exit("[sample_calm] no calm rows sampled — widen windows or add input")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Move-quality / ACPL report — spec 214 realism audit, Lens 4.

The realism question this lens answers: does the persona simulator play at a
move-quality *texture* that resembles elite classical chess, or does the
`nodes=1` policy produce engine-uncharacteristic play — low background noise
punctuated by rare, huge single-ply cliffs? We measure it directly.

For every position of every game we get one Stockfish evaluation at a FIXED
node budget (`go nodes 250000`, NOT movetime — node-based analysis is immune to
machine contention, so the numbers are reproducible from the PGN alone). From
the White-POV eval of consecutive positions we derive each mover's centipawn
loss (CPL) per move, then aggregate per player:

  * average CPL overall and per phase (book / middlegame / endgame),
  * blunder counts (CPL >= 100 and >= 300 against the mover),
  * distribution shape (median vs mean — engine-like play is low-median with
    rare cliffs, so a mean far above the median is the tell).

Eval magnitudes are capped at +/-1000cp BEFORE differencing so resignations and
forced mates don't dominate the averages.

Phase boundaries follow the audit brief by ply of the move being made:
plies 1-24 = book, 25-80 = middlegame, 81+ = endgame.

Usage:
    python acpl_report.py                 # full run (all 24 games)
    python acpl_report.py --limit 2       # smoke test (first 2 games)
    python acpl_report.py --selftest      # pure-function unit tests
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional

import chess
import chess.engine
import chess.pgn

# ---------------------------------------------------------------------------
# Paths / config
# ---------------------------------------------------------------------------

REPO = Path(__file__).resolve().parents[2]
DATA_DIR = REPO / "data" / "personas"
CACHE_DIR = DATA_DIR / "_cache"
PGN_PATH = DATA_DIR / "match1_fischer_kasparov.pgn"
OUT_JSON = DATA_DIR / "match1_acpl.json"
CACHE_PATH = CACHE_DIR / "acpl_eval_cache.json"

STOCKFISH = "/opt/homebrew/bin/stockfish"
NODES = 250_000            # fixed node budget per position (contention-immune)
EVAL_CAP = 1000           # clamp |eval| to this (cp) before differencing
MATE_SCORE = 100_000      # python-chess mate->cp surrogate, clamped by EVAL_CAP
SF_THREADS = 1            # single-threaded => node budget is deterministic

# Phase boundaries by ply of the move being made (audit brief).
BOOK_MAX_PLY = 24         # plies 1-24
MIDDLE_MAX_PLY = 80       # plies 25-80; 81+ is endgame

BLUNDER_CP = 100
BIG_BLUNDER_CP = 300


def phase_for_ply(ply: int) -> str:
    """Bucket a move by its half-move number (1 = White's first move)."""
    if ply <= BOOK_MAX_PLY:
        return "book"
    if ply <= MIDDLE_MAX_PLY:
        return "middlegame"
    return "endgame"


def surname(header_name: str) -> str:
    """'Fischer (persona)' -> 'Fischer'. First whitespace-delimited token."""
    return header_name.strip().split()[0] if header_name.strip() else header_name


# ---------------------------------------------------------------------------
# Eval cache (resumable): fen -> White-POV centipawns (uncapped)
# ---------------------------------------------------------------------------

class EvalCache:
    """Per-FEN White-POV eval cache, so a crashed run resumes for free."""

    def __init__(self) -> None:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        self.data: Dict[str, int] = {}
        if CACHE_PATH.exists():
            try:
                self.data = json.loads(CACHE_PATH.read_text())
            except json.JSONDecodeError:
                self.data = {}
        self._dirty = 0

    def get(self, fen: str) -> Optional[int]:
        return self.data.get(fen)

    def put(self, fen: str, cp: int) -> None:
        self.data[fen] = cp
        self._dirty += 1
        if self._dirty >= 50:
            self.flush()

    def flush(self) -> None:
        tmp = CACHE_PATH.with_suffix(".json.part")
        tmp.write_text(json.dumps(self.data))
        tmp.replace(CACHE_PATH)
        self._dirty = 0


def eval_white_cp(engine: chess.engine.SimpleEngine, board: chess.Board,
                  cache: EvalCache) -> int:
    """White-POV eval in cp at NODES nodes. Cached by FEN. Uncapped mate surrogate.

    Terminal positions are scored directly (no engine call): checkmate is a loss
    for the side to move, stalemate/insufficient/etc. is 0.
    """
    fen = board.fen()
    hit = cache.get(fen)
    if hit is not None:
        return hit
    if board.is_game_over(claim_draw=False):
        if board.is_checkmate():
            # Side to move is mated: bad for them, so White-POV sign flips.
            cp = -MATE_SCORE if board.turn == chess.WHITE else MATE_SCORE
        else:
            cp = 0
    else:
        info = engine.analyse(board, chess.engine.Limit(nodes=NODES))
        cp = info["score"].white().score(mate_score=MATE_SCORE)
    cache.put(fen, cp)
    return cp


def clamp(cp: int) -> int:
    return max(-EVAL_CAP, min(EVAL_CAP, cp))


def move_cpl(mover: chess.Color, before_white: int, after_white: int) -> float:
    """CPL for one move, from capped consecutive White-POV evals.

    White wants White-POV eval high; Black wants it low. Loss is how much the
    played move gave up versus holding the pre-move eval, floored at 0 (the
    engine's shallow read can make a move look better than the deeper pre-eval;
    that is noise, not a gain, so we don't credit it).
    """
    b, a = clamp(before_white), clamp(after_white)
    drop = (b - a) if mover == chess.WHITE else (a - b)
    return float(max(0, drop))


# ---------------------------------------------------------------------------
# Per-game analysis
# ---------------------------------------------------------------------------

def analyse_game(game: chess.pgn.Game,
                 engine: Optional[chess.engine.SimpleEngine],
                 cache: EvalCache) -> dict:
    """Walk one game, producing per-player per-move CPL records."""
    white = surname(game.headers.get("White", "White"))
    black = surname(game.headers.get("Black", "Black"))
    names = {chess.WHITE: white, chess.BLACK: black}

    board = game.board()
    before = eval_white_cp(engine, board, cache)
    per_player: Dict[str, List[dict]] = {white: [], black: []}
    ply = 1
    for move in game.mainline_moves():
        mover = board.turn
        board.push(move)
        after = eval_white_cp(engine, board, cache)
        cpl = move_cpl(mover, before, after)
        per_player[names[mover]].append({
            "ply": ply,
            "phase": phase_for_ply(ply),
            "cpl": round(cpl, 1),
        })
        before = after
        ply += 1

    return {
        "round": game.headers.get("Round", "?"),
        "white": white,
        "black": black,
        "result": game.headers.get("Result", "*"),
        "plies": ply - 1,
        "moves": per_player,
    }


# ---------------------------------------------------------------------------
# Aggregation (pure)
# ---------------------------------------------------------------------------

def _summary(cpls: List[float]) -> dict:
    if not cpls:
        return {"n": 0}
    return {
        "n": len(cpls),
        "mean_cpl": round(statistics.fmean(cpls), 1),
        "median_cpl": round(statistics.median(cpls), 1),
        "blunders_100": sum(1 for c in cpls if c >= BLUNDER_CP),
        "blunders_300": sum(1 for c in cpls if c >= BIG_BLUNDER_CP),
    }


def aggregate(games: List[dict], players: List[str]) -> dict:
    """Per-player overall + per-phase CPL summaries across all games."""
    # player -> "overall"/phase -> list of cpl
    pool: Dict[str, Dict[str, List[float]]] = {
        p: defaultdict(list) for p in players
    }
    for g in games:
        for player, moves in g["moves"].items():
            for m in moves:
                pool[player]["overall"].append(m["cpl"])
                pool[player][m["phase"]].append(m["cpl"])

    out: Dict[str, dict] = {}
    for p in players:
        buckets = ("overall", "book", "middlegame", "endgame")
        out[p] = {b: _summary(pool[p][b]) for b in buckets}
    return out


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def run(limit: Optional[int]) -> dict:
    cache = EvalCache()
    engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH)
    engine.configure({"Threads": SF_THREADS})
    games: List[dict] = []
    t0 = time.time()
    try:
        with PGN_PATH.open() as fh:
            idx = 0
            while True:
                game = chess.pgn.read_game(fh)
                if game is None:
                    break
                idx += 1
                if limit and idx > limit:
                    break
                g = analyse_game(game, engine, cache)
                games.append(g)
                print(f"[game {idx}] {g['white']} vs {g['black']} "
                      f"{g['result']}  {g['plies']} plies  "
                      f"{time.time() - t0:.1f}s elapsed", flush=True)
    finally:
        cache.flush()
        engine.quit()

    players = sorted({g["white"] for g in games} | {g["black"] for g in games})
    agg = aggregate(games, players)
    return {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "config": {
            "engine": "Stockfish 18",
            "limit_nodes": NODES,
            "threads": SF_THREADS,
            "eval_cap_cp": EVAL_CAP,
            "phase_plies": {"book": [1, BOOK_MAX_PLY],
                            "middlegame": [BOOK_MAX_PLY + 1, MIDDLE_MAX_PLY],
                            "endgame": [MIDDLE_MAX_PLY + 1, None]},
            "blunder_thresholds_cp": [BLUNDER_CP, BIG_BLUNDER_CP],
            "pgn": PGN_PATH.name,
        },
        "aggregate": agg,
        "games": games,
    }


def print_report(out: dict) -> None:
    print("\n===== ACPL summary (capped +/-{}cp, {} nodes/move) ====="
          .format(EVAL_CAP, NODES))
    for player, buckets in out["aggregate"].items():
        o = buckets["overall"]
        print(f"\n{player}: n={o['n']} moves  "
              f"mean {o['mean_cpl']}cp  median {o['median_cpl']}cp  "
              f"blunders>=100: {o['blunders_100']}  >=300: {o['blunders_300']}")
        for ph in ("book", "middlegame", "endgame"):
            b = buckets[ph]
            if b["n"]:
                print(f"    {ph:11s} n={b['n']:3d}  mean {b['mean_cpl']:6.1f}  "
                      f"median {b['median_cpl']:5.1f}  "
                      f"bl>=100 {b['blunders_100']}  bl>=300 {b['blunders_300']}")


# ---------------------------------------------------------------------------
# Self-test (pure functions)
# ---------------------------------------------------------------------------

def selftest() -> int:
    import unittest

    class T(unittest.TestCase):
        def test_phase(self):
            self.assertEqual(phase_for_ply(1), "book")
            self.assertEqual(phase_for_ply(24), "book")
            self.assertEqual(phase_for_ply(25), "middlegame")
            self.assertEqual(phase_for_ply(80), "middlegame")
            self.assertEqual(phase_for_ply(81), "endgame")

        def test_surname(self):
            self.assertEqual(surname("Fischer (persona)"), "Fischer")
            self.assertEqual(surname("Kasparov (persona)"), "Kasparov")

        def test_clamp(self):
            self.assertEqual(clamp(5000), EVAL_CAP)
            self.assertEqual(clamp(-5000), -EVAL_CAP)
            self.assertEqual(clamp(37), 37)

        def test_white_best_move_zero_loss(self):
            # White holds eval: +50 -> +50 (White POV) => no loss.
            self.assertEqual(move_cpl(chess.WHITE, 50, 50), 0.0)
            # White blunders: +50 -> -200 => 250 loss.
            self.assertEqual(move_cpl(chess.WHITE, 50, -200), 250.0)
            # White "improves" per shallow eval: floored at 0.
            self.assertEqual(move_cpl(chess.WHITE, 50, 120), 0.0)

        def test_black_loss(self):
            # Black wants White-POV low. -50 -> -50 => no loss.
            self.assertEqual(move_cpl(chess.BLACK, -50, -50), 0.0)
            # Black blunders: -50 -> +200 => 250 loss.
            self.assertEqual(move_cpl(chess.BLACK, -50, 200), 250.0)

        def test_cap_applied_before_diff(self):
            # +5000 clamps to +1000; -5000 clamps to -1000; White loss = 2000.
            self.assertEqual(move_cpl(chess.WHITE, 5000, -5000), 2000.0)

        def test_summary(self):
            s = _summary([0, 0, 10, 400])
            self.assertEqual(s["n"], 4)
            self.assertEqual(s["median_cpl"], 5.0)
            self.assertEqual(s["blunders_100"], 1)
            self.assertEqual(s["blunders_300"], 1)

    suite = unittest.TestLoader().loadTestsFromTestCase(T)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None,
                    help="analyse only the first N games (smoke test)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    out = run(args.limit)
    OUT_JSON.write_text(json.dumps(out, indent=2))
    print_report(out)
    print(f"\nWrote {OUT_JSON}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

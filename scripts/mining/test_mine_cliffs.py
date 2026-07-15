#!/usr/bin/env python3
"""Fixture tests for mine_cliffs.py (spec 211 Tier-1 generator).

fixtures/cliffs.pgn holds five hand-built games:
  cliff001  POSITIVE, White mover — the Elephant Trap (6.Nxd5?? loses a
            piece to 6...Nxd5! 7.Bxd8 Bb4+). Real cliff, engine confirms.
  cliff002  NEGATIVE — calm Najdorf, honest evals, no cliff anywhere.
  cliff003  FALSE-POSITIVE [%eval] — a quiet 2...Nc6 carries a fabricated
            [%eval 2.5]; the tag-scan flags it, Stockfish re-verification
            must REJECT it (spec: never trust [%eval] alone).
  cliff004  PRE-WINDOW GATE — a big drop from an already-lost position
            (-1.2 -> -4.0); must never become a candidate.
  cliff005  POSITIVE, Black mover — 4...Nxe4?? in the Italian hangs a
            knight to 5.dxe4 (tests the sign convention end to end).

Expected end-to-end result: exactly 2 puzzles, 3 candidates, 1 rejected
as verify_eval. Engine tests use $STOCKFISH, else `stockfish` on PATH,
else the homebrew path; they skip (loudly) if none exists.

Run:  python3 scripts/mining/test_mine_cliffs.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from mine_cliffs import (Verifier, eval_tag_to_cp, find_candidates,
                         parse_movetext)
from uciengine import SearchLine

FIXTURE = os.path.join(HERE, "fixtures", "cliffs.pgn")
STOCKFISH = (os.environ.get("STOCKFISH") or shutil.which("stockfish")
             or "/opt/homebrew/bin/stockfish")
HAVE_ENGINE = os.path.exists(STOCKFISH)
DEPTH = "16"


class TestEvalTags(unittest.TestCase):
    def test_cp(self):
        self.assertEqual(eval_tag_to_cp("0.17"), 17)
        self.assertEqual(eval_tag_to_cp("-1.5"), -150)

    def test_mate(self):
        self.assertEqual(eval_tag_to_cp("#3"), 9997)
        self.assertEqual(eval_tag_to_cp("#-2"), -9998)

    def test_garbage(self):
        self.assertIsNone(eval_tag_to_cp("#"))
        self.assertIsNone(eval_tag_to_cp("oops"))


class TestParseMovetext(unittest.TestCase):
    def test_lichess_style(self):
        sans, evals = parse_movetext(
            "1. e4 { [%eval 0.2] [%clk 0:10:00] } 1... e5?! { [%eval 0.3] } "
            "2. Nf3 $2 Nc6?? { [%eval #1] } 1-0")
        self.assertEqual(sans, ["e4", "e5", "Nf3", "Nc6"])
        self.assertEqual(evals, [20, 30, None, 9999])

    def test_result_stops(self):
        sans, _ = parse_movetext("1. e4 1/2-1/2 e5")
        self.assertEqual(sans, ["e4"])

    def test_variations_bail(self):
        self.assertIsNone(parse_movetext("1. e4 (1. d4) e5 *"))


class TestFindCandidates(unittest.TestCase):
    """Signs: evals are white-perspective; the gate is mover-perspective."""

    def test_black_cliff(self):
        # +2.5 white-persp after Black's move = -2.5 for the mover.
        self.assertEqual(list(find_candidates([30, 30, 20, 250], 100, 150)),
                         [3])

    def test_white_cliff(self):
        self.assertEqual(list(find_candidates([30, 30, -240], 100, 150)), [2])

    def test_not_a_cliff_for_the_mover(self):
        # White-persp drop after a BLACK move is a gain for Black: no cliff.
        self.assertEqual(list(find_candidates([30, -240], 100, 150)), [])

    def test_pre_window_gate(self):
        # Already lost (-1.8) before the drop: outside the ±1.0 window.
        self.assertEqual(list(find_candidates([30, -180, -500], 100, 150)),
                         [])

    def test_missing_evals_skipped(self):
        self.assertEqual(list(find_candidates([None, -240, None], 100, 150)),
                         [])


def _args(**over):
    d = dict(depth=16, multipv=4, pre_window=100, cliff=150, safe_window=50,
             lost_threshold=100, verify_pre_max=150, min_alternatives=3,
             refutation_plies=10)
    d.update(over)
    return types.SimpleNamespace(**d)


class FakeEngine:
    """Scripted search results: first call = post-trap, second = pre."""

    def __init__(self, post, pre):
        self.results = [post, pre]

    def search(self, fen, depth, moves=None, multipv=1):
        return self.results.pop(0)


def lines(*cp_move_pairs, mate_ranks=()):
    return {i + 1: SearchLine(cp, (1 if i + 1 in mate_ranks else None),
                              [mv, "e7e5"])
            for i, (cp, mv) in enumerate(cp_move_pairs)}


class TestVerifier(unittest.TestCase):
    PRE_OK = lines((30, "d2d4"), (20, "g1f3"), (5, "e2e3"), (-90, "a2a3"))

    def test_false_eval_rejected(self):
        v = Verifier(FakeEngine(lines((40, "f6d5")), self.PRE_OK), _args())
        _, why = v.verify("fen", "c3d5")
        self.assertEqual(why, "verify_eval")

    def test_pre_position_not_calm_rejected(self):
        pre = lines((400, "d2d4"), (30, "g1f3"), (5, "e2e3"), (-90, "a2a3"))
        v = Verifier(FakeEngine(lines((372, "f6d5")), pre), _args())
        _, why = v.verify("fen", "c3d5")
        self.assertEqual(why, "verify_pre_window")

    def test_few_alternatives_rejected(self):
        # best 30; floor = max(30-50, -100) = -20: only g1f3 qualifies
        # besides best; the trap (c3d5) never counts even if it ranks.
        pre = lines((30, "d2d4"), (20, "g1f3"), (-30, "c3d5"), (-90, "a2a3"))
        v = Verifier(FakeEngine(lines((372, "f6d5")), pre), _args())
        _, why = v.verify("fen", "c3d5")
        self.assertEqual(why, "few_alternatives")

    def test_pass_and_fields(self):
        v = Verifier(FakeEngine(lines((372, "f6d5")), self.PRE_OK),
                     _args(refutation_plies=1))
        fields, why = v.verify("fen", "c3d5")
        self.assertIsNone(why)
        self.assertEqual(fields["verified_after_cp"], -372)  # mover persp
        self.assertEqual(fields["verified_pre_best_cp"], 30)
        self.assertEqual(fields["refutation_line"], ["f6d5"])  # truncated
        self.assertEqual(fields["n_alternatives"], 3)  # a2a3 below floor
        self.assertFalse(fields["mate"])

    def test_mate_flag(self):
        v = Verifier(FakeEngine(lines((9999, "d1f7"), mate_ranks=(1,)),
                                self.PRE_OK), _args())
        fields, why = v.verify("fen", "g8f6")
        self.assertIsNone(why)
        self.assertTrue(fields["mate"])

    def test_terminal_after_trap(self):
        v = Verifier(FakeEngine(None, self.PRE_OK), _args())
        _, why = v.verify("fen", "c3d5")
        self.assertEqual(why, "terminal_after_trap")


@unittest.skipUnless(HAVE_ENGINE, f"no stockfish at {STOCKFISH}")
class TestEndToEnd(unittest.TestCase):
    """Full run over fixtures/cliffs.pgn with real Stockfish."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="cliffs_test_")
        cls.run1 = cls._mine()
        out = os.path.join(cls.tmp, "cliffs.cliffs.jsonl")
        with open(out) as f:
            cls.rows = [json.loads(ln) for ln in f if ln.strip()]
        with open(os.path.join(cls.tmp, "cliffs.cliffs.done.json")) as f:
            cls.stats = json.load(f)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def _mine(cls):
        return subprocess.run(
            [sys.executable, os.path.join(HERE, "mine_cliffs.py"), FIXTURE,
             "--engine", STOCKFISH, "--depth", DEPTH, "--out-dir", cls.tmp,
             "--progress-every", "0"],
            capture_output=True, text=True, check=True)

    def test_exactly_the_two_real_cliffs(self):
        self.assertEqual([r["source_game_id"] for r in self.rows],
                         ["cliff001", "cliff005"])

    def test_elephant_trap_row(self):
        import chess
        r = self.rows[0]
        b = chess.Board()
        for san in ("d4 d5 c4 e6 Nc3 Nf6 Bg5 Nbd7 cxd5 exd5".split()):
            b.push_san(san)
        self.assertEqual(r["fen"], b.fen())
        self.assertEqual(r["trap_uci"], "c3d5")
        self.assertEqual(r["trap_san"], "Nxd5")
        self.assertEqual(r["refutation_line"][0], "f6d5")  # ...Nxd5!
        self.assertEqual(r["played_reply_san"], "Nxd5")
        self.assertEqual(r["mover"], "white")
        self.assertEqual((r["ply"], r["move_number"]), (10, 6))
        self.assertEqual(r["eval_before_cp"], 40)    # mover perspective
        self.assertEqual(r["eval_after_cp"], -240)
        self.assertLessEqual(r["verified_after_cp"], -150)
        self.assertGreaterEqual(r["n_alternatives"], 3)
        self.assertFalse(r["mate"])
        self.assertEqual(r["band"], "1700")           # mover's (White's) band
        self.assertEqual(r["engine_verify_depth"], int(DEPTH))

    def test_black_mover_signs(self):
        r = self.rows[1]
        self.assertEqual(r["trap_uci"], "f6e4")
        self.assertEqual(r["mover"], "black")
        self.assertEqual(r["refutation_line"][0], "d3e4")
        self.assertEqual(r["eval_before_cp"], -20)    # -(+0.2 white persp)
        self.assertEqual(r["eval_after_cp"], -430)
        self.assertEqual(r["band"], "1800")           # BlackElo 1893
        self.assertLessEqual(r["verified_after_cp"], -150)

    def test_stats_prove_the_negatives(self):
        s = self.stats
        self.assertEqual(s["games_seen"], 5)
        # cliff002 (calm) and cliff004 (pre-window) yield no candidates;
        # cliff003's fabricated tag becomes the third candidate...
        self.assertEqual(s["candidates"], 3)
        self.assertEqual(s["games_with_candidates"], 3)
        # ...and engine re-verification kills it (spec 211:50-51).
        self.assertEqual(s["rejected"], {"verify_eval": 1})
        self.assertEqual(s["puzzles"], 2)

    def test_idempotent_rerun(self):
        out = os.path.join(self.tmp, "cliffs.cliffs.jsonl")
        with open(out) as f:
            before = f.read()
        run2 = self._mine()
        self.assertIn("already done", run2.stderr)
        with open(out) as f:
            self.assertEqual(before, f.read())

    def test_importer_dedup(self):
        import sqlite3
        db = os.path.join(self.tmp, "puzzles.sqlite")
        jsonl = os.path.join(self.tmp, "cliffs.cliffs.jsonl")
        for _ in range(2):  # double import must not double rows
            subprocess.run([sys.executable,
                            os.path.join(HERE, "import_puzzles.py"),
                            db, jsonl], capture_output=True, check=True)
        con = sqlite3.connect(db)
        self.assertEqual(
            con.execute("SELECT COUNT(*) FROM puzzles").fetchone()[0], 2)
        band, = con.execute("SELECT band FROM puzzles WHERE mover='black'"
                            ).fetchone()
        self.assertEqual(band, "1800")


if __name__ == "__main__":
    if not HAVE_ENGINE:
        print(f"WARNING: no stockfish found (set $STOCKFISH); "
              "end-to-end tests will be skipped", file=sys.stderr)
    unittest.main(verbosity=2)

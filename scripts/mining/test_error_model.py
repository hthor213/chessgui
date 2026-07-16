#!/usr/bin/env python3
"""Fixture tests for error_model.py (spec 214 contract step 5).

End-to-end fixtures:
  fixtures/errmodel.pgn  one hand-built game: five classifiable moves, one
                         mistake (3...Nd4, mover-POV drop -0.25 -> -1.5 =
                         1.25 pawns) made at [%clk 0:00:25] -> the lt30
                         clock bucket. Exercises band-of-mover, mover-POV
                         sign flip, clock + eval bucketing.
  fixtures/sample.pgn    the shared pipeline fixture: 17 classifiable moves
                         across 8 eval-tagged games, zero mistakes; games
                         with missing/malformed Elo contribute only the
                         opponent's moves; the eval-less game is skipped.

Run:  python3 scripts/mining/test_error_model.py
"""

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import chess

from error_model import (clk_to_seconds, clock_bucket, eval_bucket,
                         parse_movetext, phase_for, phase_weight,
                         process_file)

ERRMODEL_PGN = os.path.join(HERE, "fixtures", "errmodel.pgn")
SAMPLE_PGN = os.path.join(HERE, "fixtures", "sample.pgn")


class TestClk(unittest.TestCase):
    def test_hms(self):
        self.assertEqual(clk_to_seconds("[%clk 0:09:50]"), 590)
        self.assertEqual(clk_to_seconds("[%clk 1:00:03]"), 3603)
        self.assertEqual(clk_to_seconds("[%clk 0:00:25]"), 25)

    def test_fractional_and_absent(self):
        self.assertEqual(clk_to_seconds("[%clk 0:00:09.7]"), 9)
        self.assertIsNone(clk_to_seconds("[%eval 0.2]"))

    def test_buckets(self):
        self.assertEqual(clock_bucket(None), "none")
        self.assertEqual(clock_bucket(600), "600plus")
        self.assertEqual(clock_bucket(599), "300-600")
        self.assertEqual(clock_bucket(29), "lt30")
        self.assertEqual(clock_bucket(0), "lt30")


class TestEvalBucket(unittest.TestCase):
    def test_edges(self):
        self.assertEqual(eval_bucket(0), "+0.0")
        self.assertEqual(eval_bucket(49), "+0.0")
        self.assertEqual(eval_bucket(50), "+0.5")
        self.assertEqual(eval_bucket(-1), "-0.5")
        self.assertEqual(eval_bucket(-50), "-0.5")
        self.assertEqual(eval_bucket(-51), "-1.0")

    def test_clamp_and_mate(self):
        self.assertEqual(eval_bucket(9997), "+4.5")   # mate tag -> end bucket
        self.assertEqual(eval_bucket(-9997), "-5.0")
        self.assertEqual(eval_bucket(500), "+4.5")
        self.assertEqual(eval_bucket(-500), "-5.0")


class TestPhase(unittest.TestCase):
    def test_start_is_24_and_opening(self):
        b = chess.Board()
        self.assertEqual(phase_weight(b), 24)
        self.assertEqual(phase_for(24, 0), "opening")
        self.assertEqual(phase_for(24, 16), "middlegame")

    def test_endgame_wins_over_ply(self):
        # K+R vs K+R: pw = 2*2 = 4 <= 8 -> endgame even at ply 5.
        b = chess.Board("4k2r/8/8/8/8/8/8/R3K3 w Qk - 0 1")
        self.assertEqual(phase_weight(b), 4)
        self.assertEqual(phase_for(4, 5), "endgame")
        self.assertEqual(phase_for(9, 40), "middlegame")


class TestParseMovetext(unittest.TestCase):
    def test_parallel_lists(self):
        sans, evals, clks = parse_movetext(
            "1. e4 { [%eval 0.2] [%clk 0:10:00] } 1... e5 { [%eval -0.3] } "
            "2. Nf3 1-0")
        self.assertEqual(sans, ["e4", "e5", "Nf3"])
        self.assertEqual(evals, [20, -30, None])
        self.assertEqual(clks, [600, None, None])

    def test_variations_abort(self):
        self.assertIsNone(parse_movetext("1. e4 (1. d4) e5 1-0"))


def run_e2e(pgn_path):
    """process_file into a temp dir; return (meta, cells)."""
    with tempfile.TemporaryDirectory() as td:
        process_file(pgn_path, td, progress_every=0)
        stem = os.path.basename(pgn_path)[:-len(".pgn")]
        with open(os.path.join(td, f"{stem}.errmodel.json")) as f:
            doc = json.load(f)
        self_done = os.path.exists(
            os.path.join(td, f"{stem}.errmodel.done.json"))
    return doc["meta"], doc["cells"], self_done


class TestEndToEnd(unittest.TestCase):
    def test_errmodel_fixture(self):
        meta, cells, done = run_e2e(ERRMODEL_PGN)
        self.assertTrue(done)
        self.assertEqual(meta["games_seen"], 1)
        self.assertEqual(meta["games_used"], 1)
        self.assertEqual(meta["moves_classified"], 5)
        self.assertEqual(meta["mistakes"], 1)
        # The blunder: black (1542 -> band 1500), opening, mover-POV eval
        # before -0.25 -> bucket -0.5, clock 25s -> lt30.
        self.assertEqual(cells["1500|opening|-0.5|lt30"],
                         {"moves": 1, "mistakes": 1})
        # Her two calm moves at healthy clock:
        self.assertEqual(cells["1500|opening|-0.5|300-600"],
                         {"moves": 2, "mistakes": 0})
        # White's two classified moves (i=2 Nf3, i=4 Bc4):
        self.assertEqual(cells["1600|opening|+0.0|300-600"],
                         {"moves": 2, "mistakes": 0})
        self.assertEqual(len(cells), 3)

    def test_sample_fixture(self):
        meta, cells, done = run_e2e(SAMPLE_PGN)
        self.assertTrue(done)
        self.assertEqual(meta["games_seen"], 9)
        self.assertEqual(meta["games_used"], 8)   # aaaa0006 has no evals
        self.assertEqual(meta["moves_classified"], 17)
        self.assertEqual(meta["mistakes"], 0)
        # aaaa0003's 1380-rated white contributes the only 1300-band move.
        self.assertEqual(sum(v["moves"] for k, v in cells.items()
                             if k.startswith("1300|")), 1)
        # 1600 band: aaaa0001's 1650 white (2) + 1642 black (2), aaaa0007's
        # 1620 white (1) + 1688 black (2), plus the 1600-rated blacks of
        # aaaa0008/9 (1 each) whose opponents' Elos are missing/malformed —
        # their own replies still count.
        self.assertEqual(sum(v["moves"] for k, v in cells.items()
                             if k.startswith("1600|")), 9)


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""Fixture tests for leak_report.py (spec 211 opening-leak report).

fixtures/leaks.pgn holds seven hand-built games for user "testuser":
  leak game 1  TAGGED, user White, B30 — 2.Qh5 drops 0.3 -> -1.7 (a 200 cp
               leak) plus a 20 cp dribble on 3.Nf3: bled 220, 1 leak.
  leak game 2  TAGGED, user Black, B30 — the OPPONENT leaks 130 cp on 2.Na3;
               the user bleeds only 10 cp on 1...c5. Opponent drops must
               never count against the user.
  leak game 3  TAGGED, user White, C50 — calm Italian, nothing bled.
  leak game 4  Result "*" (active daily game) — must be skipped outright,
               never analyzed (spec 219 active-game guard).
  leak game 5  UNTAGGED, user White, C20 — 3.Qxf7+?? hangs the queen; only
               analyzable via the engine pass (lichess-style Opening header).
  leak game 6  UNTAGGED, user Black, D30 — calm; engine-pass filler.
  leak game 7  neither player is testuser — skipped not_user.

Tag-only run (no --engine): 3 games analyzed, 2 untagged skipped.
Engine run (--limit 5): 5 analyzed, C20 gets its Qxf7+ leak.
Engine tests use $STOCKFISH, else `stockfish` on PATH, else the homebrew
path; they skip (loudly) if none exists.

Run:  python3 scripts/mining/test_leak_report.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from leak_report import (collect_games, game_drops, opening_name,
                         user_color)

FIXTURE = os.path.join(HERE, "fixtures", "leaks.pgn")
STOCKFISH = (os.environ.get("STOCKFISH") or shutil.which("stockfish")
             or "/opt/homebrew/bin/stockfish")
HAVE_ENGINE = os.path.exists(STOCKFISH)


def hdr(**kw):
    return {k.encode(): v.encode() for k, v in kw.items()}


class TestOpeningName(unittest.TestCase):
    def test_ecourl_slug_trims_move_detail(self):
        h = hdr(ECOUrl="https://www.chess.com/openings/"
                       "Sicilian-Defense-Old-Sicilian-Variation-3.d3-d6")
        self.assertEqual(opening_name(h),
                         "Sicilian Defense Old Sicilian Variation")

    def test_lichess_opening_header_wins(self):
        h = hdr(Opening="King's Pawn Game: Wayward Queen Attack",
                ECOUrl="https://www.chess.com/openings/whatever")
        self.assertEqual(opening_name(h),
                         "King's Pawn Game: Wayward Queen Attack")

    def test_no_name(self):
        self.assertIsNone(opening_name(hdr(ECO="A00")))


class TestUserColor(unittest.TestCase):
    def test_case_insensitive(self):
        h = hdr(White="TestUser", Black="rival")
        self.assertEqual(user_color(h, "testuser"), "white")
        self.assertEqual(user_color(hdr(White="a", Black="TESTUSER"),
                                    "testuser"), "black")
        self.assertIsNone(user_color(h, "nobody"))


class TestGameDrops(unittest.TestCase):
    # evals are white-perspective cp AFTER each ply (parse_movetext order).
    EVALS = [30, 30, -170, -170, -190, -180]

    def test_white_mover(self):
        drops, end = game_drops(self.EVALS, "white", 20)
        self.assertEqual(drops, [(2, 200), (4, 20)])  # Qh5 + the dribble
        self.assertEqual(end, -180)

    def test_black_mover_ignores_opponent_leak(self):
        drops, end = game_drops([30, 40, -90, -90], "black", 20)
        self.assertEqual(drops, [(1, 10)])  # 2.Na3's 130 cp is not ours
        self.assertEqual(end, 90)

    def test_window_cap(self):
        drops, _ = game_drops(self.EVALS, "white", 2)
        self.assertEqual(drops, [])  # ply 2 is outside a 2-ply window

    def test_missing_evals_skip_the_move(self):
        drops, _ = game_drops([30, None, -170, -170], "white", 20)
        self.assertEqual(drops, [])

    def test_drop_capped(self):
        drops, _ = game_drops([0, 0, -9997], "white", 20)  # allowed mate
        self.assertEqual(drops, [(2, 1000)])


class TestCollectGames(unittest.TestCase):
    def test_fixture_selection_and_order(self):
        records, skipped = collect_games(FIXTURE, "testuser", 20)
        self.assertEqual(len(records), 5)          # games 1,2,3,5,6
        self.assertEqual(skipped["unfinished"], 1)  # the "*" daily game
        self.assertEqual(skipped["not_user"], 1)
        # Newest first: engine budget spends on recent games.
        self.assertEqual([r["date"] for r in records],
                         sorted((r["date"] for r in records), reverse=True))
        self.assertEqual([r["tagged"] for r in records],
                         [True, True, True, False, False])


def run_report(*extra):
    out_dir = tempfile.mkdtemp(prefix="leaks_")
    cmd = [sys.executable, os.path.join(HERE, "leak_report.py"),
           "--pgn", FIXTURE, "--user", "testuser", "--out-dir", out_dir,
           "--min-games", "1", *extra]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise AssertionError(f"leak_report failed:\n{proc.stderr}")
    with open(os.path.join(out_dir, "testuser.leaks.json")) as f:
        data = json.load(f)
    with open(os.path.join(out_dir, "testuser.leaks.md")) as f:
        md = f.read()
    return data, md


def by_key(data):
    return {f'{r["eco"]}|{r["color"]}': r for r in data["openings"]}


class TestEndToEndTagOnly(unittest.TestCase):
    """No --engine: only the three [%eval]-tagged games are analyzable."""

    @classmethod
    def setUpClass(cls):
        cls.data, cls.md = run_report()

    def test_meta(self):
        m = self.data["meta"]
        self.assertEqual(m["games_analyzed"], 3)
        self.assertEqual(m["games_tagged"], 3)
        self.assertEqual(m["games_engine"], 0)
        self.assertEqual(m["games_skipped_untagged"], 2)
        self.assertEqual(m["skipped"]["unfinished"], 1)

    def test_b30_white_leak(self):
        r = by_key(self.data)["B30|white"]
        self.assertEqual(r["bled_cp"], 220)
        self.assertEqual(r["leaks"], 1)
        self.assertEqual(r["moves"], 2)
        self.assertEqual(r["acpl_opening"], 110.0)
        self.assertEqual(r["avg_end_eval_cp"], -180)
        self.assertEqual(r["score_pct"], 100.0)
        self.assertEqual(r["worst"]["san"], "Qh5")
        self.assertEqual(r["worst"]["move_number"], 2)
        self.assertEqual(r["name"],
                         "Sicilian Defense Old Sicilian Variation")

    def test_opponent_leak_not_counted(self):
        r = by_key(self.data)["B30|black"]
        self.assertEqual(r["bled_cp"], 10)
        self.assertEqual(r["leaks"], 0)

    def test_calm_opening(self):
        r = by_key(self.data)["C50|white"]
        self.assertEqual(r["bled_cp"], 0)
        self.assertIsNone(r["worst"])

    def test_ranking_worst_first(self):
        rows = self.data["openings"]
        self.assertEqual(rows[0]["eco"], "B30")
        self.assertEqual(rows[0]["color"], "white")

    def test_markdown(self):
        self.assertIn("Sicilian Defense Old Sicilian Variation", self.md)
        self.assertIn("2.Qh5", self.md.replace("2.​", "2."))
        self.assertIn("spec-219", self.md)   # UI-deferral / gate note
        self.assertIn("Untagged games not analyzed", self.md)


@unittest.skipUnless(HAVE_ENGINE, f"no stockfish at {STOCKFISH} "
                     "(set $STOCKFISH)")
class TestEndToEndEngine(unittest.TestCase):
    """--engine: the two untagged games go through the quick pass."""

    @classmethod
    def setUpClass(cls):
        cls.data, cls.md = run_report("--engine", STOCKFISH,
                                      "--depth", "10", "--limit", "5")

    def test_meta(self):
        m = self.data["meta"]
        self.assertEqual(m["games_analyzed"], 5)
        self.assertEqual(m["games_engine"], 2)
        self.assertEqual(m["games_skipped_untagged"], 0)

    def test_hung_queen_is_a_leak(self):
        r = by_key(self.data)["C20|white"]
        self.assertGreaterEqual(r["leaks"], 1)
        self.assertEqual(r["worst"]["san"], "Qxf7+")
        self.assertGreater(r["worst"]["drop_cp"], 300)
        self.assertEqual(r["name"],
                         "King's Pawn Game: Wayward Queen Attack")

    def test_limit_binds(self):
        data, _ = run_report("--engine", STOCKFISH, "--depth", "10",
                             "--limit", "1")
        m = data["meta"]
        self.assertEqual(m["games_engine"], 1)
        self.assertEqual(m["games_skipped_untagged"], 1)


if __name__ == "__main__":
    if not HAVE_ENGINE:
        print(f"[test_leak_report] WARNING: no stockfish at {STOCKFISH}; "
              "engine tests SKIPPED (set $STOCKFISH).", file=sys.stderr)
    unittest.main(verbosity=2)

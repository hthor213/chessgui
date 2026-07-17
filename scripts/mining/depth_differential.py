#!/usr/bin/env python3
"""depth_differential.py — annotate puzzles with a depth-differential
difficulty prior (specs 211/224; spec 214 "Cognitive-gate pipeline proposal
— evaluated 2026-07-17", adopted item "depth-differential puzzle difficulty").

For every puzzle row (fen, trap_uci, ...) in an import_puzzles.py /
puzzles.rs-schema SQLite DB, determine `visible_from_depth`: the minimal
Stockfish search depth d, swept over DEPTH_SWEEP = (4, 6, 8, 10, 12, 14, 16),
at which playing trap_uci from fen already registers as clearly losing. A trap
that only shows at depth 14 demands far more lookahead than one visible at
depth 4 — the depth is a proxy for how much calculation the trap hides behind.

The rule, precisely (all centipawns, MOVER's point of view — the side that
plays trap_uci):

    pre   = eval_before_cp  if non-NULL else verified_pre_best_cp
    post  = eval_after_cp   if non-NULL else verified_after_cp
            (mate rows with neither: post = -CLAMP_CP)
    Both pre and post are clamped to [-CLAMP_CP, +CLAMP_CP] (CLAMP_CP = 1000)
    so mate-scale scores (±~10000 on the generator's cp scale) don't push the
    gate beyond what any non-mate search line can register.

    cliff     = pre - post          # the puzzle's own cliff size; rows with
                                    # cliff <= 0 or no pre are skipped (NULL)
    threshold = pre - 0.6 * cliff   # "clearly losing" = at least 60% of the
                                    # puzzle's own drop has become visible

    eval(d)   = Stockfish eval of the position AFTER trap_uci, searched to
                depth d, negated to the mover's POV (the opponent is the side
                to move). Engine mate scores map to ±(MATE_SCORE - plies), so
                a found mate against the mover always trips the gate.

    visible_from_depth = min { d in DEPTH_SWEEP : eval(d) <= threshold }
                         -1 if no depth in the sweep trips the gate
                            (deeper than the sweep — the hardest bucket)
                         NULL if the row was skipped (no usable pre/post)

The sweep runs shallow-to-deep and stops at the first depth that trips, so
easy traps cost one d=4 search. --movetime-cap bounds each single search's
wall time; if the cap fires before depth d completes, the deepest finished
iteration's score is used and still attributed to d (conservative: a starved
search can only under-report visibility, never fake it).

Engine access is python-chess when importable, else raw UCI via the sibling
uciengine.py (the repo's mining-script pattern). Both paths return
side-to-move scores that are negated to mover POV here.

HONESTY GATE (spec 214): visible_from_depth is a difficulty PRIOR, not a
measured human difficulty — "how deep must the engine look" approximates
"how hard to see" but nobody has validated the exchange rate. The
depth -> Elo mapping awaits Tier-2 band miss-rate calibration (spec 211);
until then, never present these depths as calibrated difficulty.

Usage:
    python3 scripts/mining/depth_differential.py puzzles.sqlite \\
        [--sample N] [--movetime-cap MS] [--stockfish PATH]

Only rows with visible_from_depth IS NULL are processed, so reruns resume.
The column is added via ALTER TABLE when missing (mirrored in
import_puzzles.py SCHEMA and puzzles.rs PUZZLES_SCHEMA for fresh DBs).
"""

import argparse
import sqlite3
import sys
import time

DEPTH_SWEEP = (4, 6, 8, 10, 12, 14, 16)
CLIFF_FRACTION = 0.6   # share of the puzzle's own cliff that must be visible
CLAMP_CP = 1000        # pre/post clamp: keeps mate-scale gates reachable
MATE_SCORE = 10000     # engine mate -> cp mapping (matches uciengine.MATE_CP)
DEFAULT_STOCKFISH = "/opt/homebrew/bin/stockfish"  # same as puzzles.rs
COMMIT_EVERY = 50

try:
    import chess
    import chess.engine
except ImportError:
    chess = None
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import uciengine


class ChessLibEval:
    """python-chess backend: one persistent engine, depth+time-capped analyse."""

    def __init__(self, path, movetime_cap_ms):
        self.engine = chess.engine.SimpleEngine.popen_uci(path)
        self.engine.configure({"Threads": 1, "Hash": 128})
        self.cap_s = movetime_cap_ms / 1000.0

    def eval_after(self, fen, trap_uci, depth):
        """cp eval (mover POV, mate mapped to ±MATE_SCORE scale) of the
        position after trap_uci, or None if the position is terminal."""
        board = chess.Board(fen)
        mover = board.turn
        board.push(chess.Move.from_uci(trap_uci))
        if board.is_game_over():
            return None
        info = self.engine.analyse(
            board, chess.engine.Limit(depth=depth, time=self.cap_s))
        score = info.get("score")
        if score is None:
            return None
        return score.pov(mover).score(mate_score=MATE_SCORE)

    def close(self):
        self.engine.quit()


class RawUciEval:
    """Stdlib fallback: uciengine.UciEngine with a movetime-capped `go`."""

    def __init__(self, path, movetime_cap_ms):
        self.eng = uciengine.UciEngine(path, threads=1, hash_mb=128)
        self.cap_ms = movetime_cap_ms

    def eval_after(self, fen, trap_uci, depth):
        # UciEngine.search has no movetime; drive `go` directly, same parse.
        self.eng._send(f"position fen {fen} moves {trap_uci}")
        self.eng._send(f"go depth {depth} movetime {self.cap_ms}")
        best = None
        for raw in self.eng.proc.stdout:
            tok = raw.split()
            if not tok:
                continue
            if tok[0] == "bestmove":
                break
            if tok[0] != "info" or "score" not in tok:
                continue
            if "lowerbound" in tok or "upperbound" in tok:
                continue
            si = tok.index("score")
            kind, val = tok[si + 1], int(tok[si + 2])
            best = uciengine.mate_to_cp(val) if kind == "mate" else val
        if best is None:
            return None
        return -best  # stm after the trap is the opponent -> negate to mover

    def close(self):
        self.eng.close()


def gate_threshold(row):
    """(threshold_cp, reason) — threshold is None when the row is unusable.
    Column order matches the SELECT in main()."""
    _id, _fen, _trap, eb, ea, vpre, vafter, mate = row
    pre = eb if eb is not None else vpre
    post = ea if ea is not None else vafter
    if post is None and mate:
        post = -CLAMP_CP
    if pre is None or post is None:
        return None, "no pre/post eval"
    pre = max(-CLAMP_CP, min(CLAMP_CP, pre))
    post = max(-CLAMP_CP, min(CLAMP_CP, post))
    cliff = pre - post
    if cliff <= 0:
        return None, "non-positive cliff"
    return pre - CLIFF_FRACTION * cliff, None


def ensure_column(con):
    cols = {r[1] for r in con.execute("PRAGMA table_info(puzzles)")}
    if "visible_from_depth" not in cols:
        con.execute("ALTER TABLE puzzles ADD COLUMN visible_from_depth INTEGER")
        con.commit()


def main():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("db", help="puzzles SQLite DB (import_puzzles.py schema)")
    p.add_argument("--sample", type=int, metavar="N",
                   help="annotate only N random un-annotated puzzles")
    p.add_argument("--movetime-cap", type=int, default=1000, metavar="MS",
                   help="wall-time cap per single search (default 1000)")
    p.add_argument("--stockfish", default=DEFAULT_STOCKFISH,
                   help=f"engine binary (default {DEFAULT_STOCKFISH})")
    args = p.parse_args()

    con = sqlite3.connect(args.db)
    ensure_column(con)

    sql = ("SELECT id, fen, trap_uci, eval_before_cp, eval_after_cp, "
           "verified_pre_best_cp, verified_after_cp, mate "
           "FROM puzzles WHERE visible_from_depth IS NULL")
    if args.sample:
        sql += f" ORDER BY RANDOM() LIMIT {int(args.sample)}"
    rows = con.execute(sql).fetchall()
    backend = "python-chess" if chess else "raw UCI (uciengine.py)"
    print(f"[depth_differential] {len(rows)} puzzles to annotate in {args.db} "
          f"via {backend}, cap {args.movetime_cap}ms/search", file=sys.stderr)

    ev = (ChessLibEval if chess else RawUciEval)(args.stockfish,
                                                 args.movetime_cap)
    done = skipped = 0
    t0 = time.monotonic()
    try:
        for row in rows:
            pid, fen, trap = row[0], row[1], row[2]
            threshold, why = gate_threshold(row)
            if threshold is None:
                skipped += 1  # stays NULL — unusable, distinct from -1
                continue
            result = -1  # swept without tripping = hardest bucket
            for d in DEPTH_SWEEP:
                try:
                    cp = ev.eval_after(fen, trap, d)
                except Exception as e:  # bad row must not kill the batch
                    print(f"  [depth_differential] id={pid} depth={d}: {e}",
                          file=sys.stderr)
                    cp = None
                if cp is None:
                    result = None  # engine couldn't score it; leave NULL
                    skipped += 1
                    break
                if cp <= threshold:
                    result = d
                    break
            if result is not None:
                con.execute("UPDATE puzzles SET visible_from_depth = ? "
                            "WHERE id = ?", (result, pid))
                done += 1
            if done and done % COMMIT_EVERY == 0:
                con.commit()
                rate = done / (time.monotonic() - t0)
                print(f"  [depth_differential] {done}/{len(rows)} "
                      f"({rate:.1f}/s)", file=sys.stderr)
        con.commit()
    finally:
        ev.close()

    dist = con.execute(
        "SELECT visible_from_depth, COUNT(*) FROM puzzles "
        "GROUP BY visible_from_depth ORDER BY visible_from_depth IS NULL, "
        "visible_from_depth").fetchall()
    print(f"[depth_differential] done: {done} annotated, {skipped} skipped "
          f"in {time.monotonic() - t0:.0f}s", file=sys.stderr)
    print("visible_from_depth distribution (-1 = beyond sweep, "
          "NULL = unusable/not annotated):", file=sys.stderr)
    for depth, n in dist:
        label = "NULL" if depth is None else str(depth)
        print(f"  {label:>4}  {n}", file=sys.stderr)
    # Difficulty PRIOR only — depth->Elo awaits Tier-2 miss-rate calibration.


if __name__ == "__main__":
    main()

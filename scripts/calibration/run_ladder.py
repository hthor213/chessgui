#!/usr/bin/env python3
"""run_ladder.py — time-compression ladder runner (spec 216, Tier 1).

Plays the time-odds ladder engine-vs-engine over direct UCI (python-chess):
each rung pits the engine against ITSELF where the SLOW side gets exactly 2x
the FAST side's base clock AND increment — one controlled doubling of compute.
The slow side's measured score therefore IS the Elo-per-doubling `b(t)` at
that rung's time control. Both sides are the same binary; the only asymmetry
is the clock.

Positions come from the tagged pool (data/tagged_positions.json) restricted
to a LOW imbalance band (|eval| < 0.3 pawns, near-equal starts), played
color-flipped in pairs so board-color advantage cancels.

Results are persisted resumably to data/calibration/ladder_<hostname>.json —
checkpoint per rung: each finished rung is written immediately and skipped on
restart unless --force. The JSON shape is exactly what fit_curve.py reads
(same keys as the Rust `time_odds_ladder` example writes): a top-level object
keyed by rung name, each rung carrying at least fast_ms / slow_ms /
elo_per_doubling / ci_lo / ci_hi plus the raw tallies.

Nice-friendly: the whole process (engines inherit) reniced to +19 by default.

    python3 scripts/calibration/run_ladder.py [--quick] [--rung NAME]
        [--games N] [--engine PATH] [--out PATH] [--concurrency N]
        [--force] [--nice N] [--selftest]

--quick is a smoke mode: cheapest rung only, 8 games, and (unless --out is
given) a separate ladder_<host>.quick.json so throwaway stats never mark a
real rung as done.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import chess
import chess.engine

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ENGINE = "/opt/homebrew/bin/stockfish"
TAGGED_POSITIONS = REPO_ROOT / "data" / "tagged_positions.json"
MAX_PLIES = 400
# Engines overshoot their budget by a few ms of IPC latency; symmetric on both
# sides, so a small grace avoids spurious flag-falls without biasing `b`.
CLOCK_GRACE_S = 0.1


@dataclass(frozen=True)
class Rung:
    """FAST side's clock; the slow side is implicitly 2x both terms. `name` is
    the canonical CLI/JSON key, NOT recomputed from the clocks."""

    name: str
    fast_base_ms: int
    fast_inc_ms: int
    games: int


# The default ladder, cheapest first (mirrors the Rust example's LADDER).
LADDER = [
    Rung("62ms", 500, 50, 1000),
    Rung("250ms", 2000, 200, 1000),
    Rung("1s", 8000, 800, 500),
    Rung("5.7s", 32000, 3200, 200),
]


def ms_per_move(base_ms: int, inc_ms: int) -> int:
    """Representative ms/move under the usual ~40-move convention."""
    return (base_ms + 40 * inc_ms) // 40


def to_elo(score: float) -> float:
    c = min(max(score, 1e-9), 1.0 - 1e-9)
    return -400.0 * math.log10(1.0 / c - 1.0)


def score_stats(w: int, d: int, l: int) -> tuple[float, float, float]:
    """(elo, ci_lo, ci_hi) from a W/D/L tally — same trinomial-variance
    normal-approx CI as the Rust runner, so records are comparable."""
    n = w + d + l
    m = (w + 0.5 * d) / n
    var = (w * (1.0 - m) ** 2 + d * (0.5 - m) ** 2 + l * m**2) / n
    se = math.sqrt(var / n)
    return (
        to_elo(m),
        to_elo(max(m - 1.96 * se, 0.0)),
        to_elo(min(m + 1.96 * se, 1.0)),
    )


def hostname() -> str:
    """Shell out to `hostname` first — fit_curve.py resolves the same way, and
    the two must agree on the ladder file name."""
    try:
        out = subprocess.check_output(["hostname"], text=True).strip()
        if out:
            return out
    except Exception:
        pass
    import socket

    return socket.gethostname() or "unknown"


def sample_positions(need: int, imb_lo: float = 0.0, imb_hi: float = 0.3) -> list[str]:
    """`need` near-equal start FENs, round-robin across |eval| bins within
    [imb_lo, imb_hi) — mirrors the Rust sampler (bin width 0.25, reuse when
    the pool is exhausted)."""
    pool = json.loads(TAGGED_POSITIONS.read_text())
    bin_w = 0.25
    nbins = max(round((imb_hi - imb_lo) / bin_w), 1)
    buckets: list[list[str]] = [[] for _ in range(nbins)]
    for p in pool:
        m = abs(p["eval_pawns"])
        if imb_lo <= m < imb_hi:
            buckets[min(int((m - imb_lo) / bin_w), nbins - 1)].append(p["fen"])
    active = [b for b in buckets if b]
    if not active:
        raise SystemExit(f"no positions with |eval| in [{imb_lo}, {imb_hi}) in {TAGGED_POSITIONS}")
    seeds: list[str] = []
    cur = [0] * len(active)
    while len(seeds) < need:
        progressed = False
        for i, b in enumerate(active):
            if len(seeds) >= need:
                break
            if cur[i] < len(b):
                seeds.append(b[cur[i]])
                cur[i] += 1
                progressed = True
        if not progressed:
            cur = [0] * len(active)  # exhausted distinct positions; reuse
    return seeds


@dataclass(frozen=True)
class GameSpec:
    fen: str
    slow_is_black: bool  # alternates across each flipped pair


def play_game(engine_path: str, spec: GameSpec, fast_clock: tuple[int, int], slow_clock: tuple[int, int]) -> str:
    """One game with per-side clocks managed here (python-chess does not run
    clocks). Returns 'slow' / 'fast' / 'draw'. Raises on engine failure."""
    if spec.slow_is_black:
        (wb, wi), (bb, bi) = fast_clock, slow_clock
    else:
        (wb, wi), (bb, bi) = slow_clock, fast_clock
    clocks = {chess.WHITE: wb / 1000.0, chess.BLACK: bb / 1000.0}
    incs = {chess.WHITE: wi / 1000.0, chess.BLACK: bi / 1000.0}

    board = chess.Board(spec.fen)
    slow_color = chess.BLACK if spec.slow_is_black else chess.WHITE

    def verdict_for(winner_color: chess.Color) -> str:
        return "slow" if winner_color == slow_color else "fast"

    white = chess.engine.SimpleEngine.popen_uci(engine_path)
    black = chess.engine.SimpleEngine.popen_uci(engine_path)
    try:
        for eng in (white, black):
            eng.configure({"Threads": 1})
        while True:
            if board.is_checkmate():
                return verdict_for(not board.turn)
            if board.is_game_over(claim_draw=True) or board.ply() >= MAX_PLIES:
                return "draw"
            side = board.turn
            eng = white if side == chess.WHITE else black
            limit = chess.engine.Limit(
                white_clock=clocks[chess.WHITE],
                black_clock=clocks[chess.BLACK],
                white_inc=incs[chess.WHITE],
                black_inc=incs[chess.BLACK],
            )
            t0 = time.monotonic()
            result = eng.play(board, limit)
            clocks[side] -= time.monotonic() - t0
            if clocks[side] + CLOCK_GRACE_S < 0.0:
                return verdict_for(not side)  # flag fall
            clocks[side] = max(clocks[side], 0.0) + incs[side]
            if result.move is None:
                return "draw"  # engine resigned/no move on a non-terminal board
            board.push(result.move)
    finally:
        for eng in (white, black):
            try:
                eng.quit()
            except Exception:
                eng.close()


@dataclass
class RungResult:
    slow_wins: int = 0
    draws: int = 0
    fast_wins: int = 0
    errs: int = 0
    elapsed_s: float = 0.0


def run_rung(engine_path: str, rung: Rung, games: int, concurrency: int) -> RungResult:
    fast = (rung.fast_base_ms, rung.fast_inc_ms)
    slow = (rung.fast_base_ms * 2, rung.fast_inc_ms * 2)
    seeds = sample_positions(-(-games // 2))
    specs = [
        GameSpec(fen, slow_is_black)
        for fen in seeds
        for slow_is_black in (False, True)
    ][:games]

    print(
        f"  rung {rung.name}: fast {fast[0] / 1000}+{fast[1] / 1000} vs "
        f"slow {slow[0] / 1000}+{slow[1] / 1000}  |  {len(specs)} games  |  "
        f"concurrency {concurrency}"
    )

    res = RungResult()
    lock = threading.Lock()
    start = time.monotonic()

    def one(spec: GameSpec) -> None:
        try:
            outcome = play_game(engine_path, spec, fast, slow)
        except Exception as e:
            with lock:
                res.errs += 1
                print(f"    game error: {e}", file=sys.stderr)
            return
        with lock:
            if outcome == "slow":
                res.slow_wins += 1
            elif outcome == "fast":
                res.fast_wins += 1
            else:
                res.draws += 1
            done = res.slow_wins + res.fast_wins + res.draws + res.errs
            if done % 50 == 0 or done == len(specs):
                print(f"    {done}/{len(specs)}  ({time.monotonic() - start:.0f}s)")

    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        list(pool.map(one, specs))
    res.elapsed_s = time.monotonic() - start
    return res


def rung_record(rung: Rung, res: RungResult) -> dict:
    played = res.slow_wins + res.draws + res.fast_wins
    score = (res.slow_wins + 0.5 * res.draws) / played
    elo, lo, hi = score_stats(res.slow_wins, res.draws, res.fast_wins)
    return {
        "rung": rung.name,
        "fast_ms": ms_per_move(rung.fast_base_ms, rung.fast_inc_ms),
        "slow_ms": ms_per_move(rung.fast_base_ms * 2, rung.fast_inc_ms * 2),
        "fast_base_ms": rung.fast_base_ms,
        "fast_inc_ms": rung.fast_inc_ms,
        "slow_base_ms": rung.fast_base_ms * 2,
        "slow_inc_ms": rung.fast_inc_ms * 2,
        "games": played,
        "w": res.slow_wins,  # slow-side perspective
        "d": res.draws,
        "l": res.fast_wins,
        "errors": res.errs,
        "score": score,
        "elo_per_doubling": elo,
        "ci_lo": lo,
        "ci_hi": hi,
        "elapsed_s": res.elapsed_s,
        "finished_at": int(time.time()),
    }


def persist(path: Path, store: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(store, indent=2, sort_keys=True) + "\n")
    tmp.replace(path)


def selftest() -> int:
    """Offline checks of the stats/shape math against the known 62ms rung in
    the committed Mac ladder (w=305 d=669 l=26 of 1000 -> +99.6 [+87.9, +111.4])."""
    elo, lo, hi = score_stats(305, 669, 26)
    assert abs(elo - 99.574) < 0.01, elo
    assert abs(lo - 87.930) < 0.01, lo
    assert abs(hi - 111.440) < 0.01, hi
    assert ms_per_move(500, 50) == 62 and ms_per_move(1000, 100) == 125
    assert ms_per_move(32000, 3200) == 4000
    rec = rung_record(LADDER[0], RungResult(slow_wins=305, draws=669, fast_wins=26))
    for key in ("fast_ms", "slow_ms", "elo_per_doubling", "ci_lo", "ci_hi"):
        assert key in rec, key  # fit_curve.py's required fields
    assert abs(to_elo(0.5)) < 1e-9
    print("selftest OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Play the spec-216 time-odds ladder and write ladder_<host>.json.")
    ap.add_argument("--rung", type=str, default=None, help="run a single named rung")
    ap.add_argument("--games", type=int, default=None, help="override the rung's game count")
    ap.add_argument("--engine", type=str, default=DEFAULT_ENGINE, help="UCI engine binary")
    ap.add_argument("--out", type=Path, default=None, help="ladder JSON path (default data/calibration/ladder_<host>.json)")
    ap.add_argument("--concurrency", type=int, default=None, help="parallel games (default: cpu count)")
    ap.add_argument("--force", action="store_true", help="rerun rungs already in the ladder file")
    ap.add_argument("--quick", action="store_true", help="smoke test: cheapest rung, 8 games, separate .quick.json output")
    ap.add_argument("--nice", type=int, default=19, help="niceness added to this process + engines (0 disables)")
    ap.add_argument("--selftest", action="store_true", help="run offline math/shape checks and exit")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if args.nice > 0:
        try:
            os.nice(args.nice)
        except OSError as e:
            print(f"WARN: could not renice: {e}", file=sys.stderr)

    host = hostname()
    if args.out is not None:
        out_path = args.out
    elif args.quick:
        out_path = REPO_ROOT / "data" / "calibration" / f"ladder_{host}.quick.json"
    else:
        out_path = REPO_ROOT / "data" / "calibration" / f"ladder_{host}.json"

    concurrency = args.concurrency or os.cpu_count() or 2

    selected = [r for r in LADDER if args.rung is None or r.name == args.rung]
    if not selected:
        print(f"no rung named {args.rung!r}; known: {[r.name for r in LADDER]}", file=sys.stderr)
        return 1
    if args.quick:
        selected = selected[:1]

    print(f"=== TIME-ODDS LADDER  (host {host}) ===")
    print(f"  engine: {args.engine}")
    print(f"  output: {out_path}   force={args.force}   quick={args.quick}\n")

    store: dict = {}
    if out_path.exists():
        try:
            store = json.loads(out_path.read_text())
            if not isinstance(store, dict):
                store = {}
        except json.JSONDecodeError:
            print(f"WARN: {out_path} unreadable; starting fresh", file=sys.stderr)
            store = {}

    summary: list[tuple[str, float, float, float, int]] = []
    for rung in selected:
        if not args.force and rung.name in store:
            print(f"  rung {rung.name} already done — skipping (use --force to rerun)")
            rec = store[rung.name]
            summary.append((rung.name, rec.get("elo_per_doubling", 0.0), rec.get("ci_lo", 0.0), rec.get("ci_hi", 0.0), rec.get("games", 0)))
            continue

        games = args.games if args.games is not None else (8 if args.quick else rung.games)
        res = run_rung(args.engine, rung, games, concurrency)
        played = res.slow_wins + res.draws + res.fast_wins
        if played == 0:
            print(f"  rung {rung.name}: no games completed ({res.errs} errors) — not persisted", file=sys.stderr)
            continue

        rec = rung_record(rung, res)
        print(
            f"  rung {rung.name} done in {res.elapsed_s:.0f}s: slow {res.slow_wins}  "
            f"fast {res.fast_wins}  draws {res.draws}  ({res.errs} errors)"
        )
        sig = "SIGNIFICANT" if rec["ci_lo"] > 0 or rec["ci_hi"] < 0 else "CI includes 0"
        print(
            f"    score {rec['score']:.3f}  Elo/doubling {rec['elo_per_doubling']:+.0f}  "
            f"95% CI [{rec['ci_lo']:+.0f}, {rec['ci_hi']:+.0f}]  {sig}\n"
        )

        # Checkpoint: merge this rung and persist immediately (resumable).
        store[rung.name] = rec
        persist(out_path, store)
        summary.append((rung.name, rec["elo_per_doubling"], rec["ci_lo"], rec["ci_hi"], played))

    print(f"=== LADDER SUMMARY ({out_path}) ===")
    for name, elo, lo, hi, g in summary:
        print(f"  {name:>6}  Elo/doubling {elo:+5.0f}  95% CI [{lo:+.0f}, {hi:+.0f}]  ({g} games)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

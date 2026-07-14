#!/usr/bin/env python3
"""filter_month.py — streaming accept-filter for one Lichess monthly dump.

Reads decompressed PGN from STDIN (feed it with `zstd -dc month.pgn.zst |`),
writes accepted games to STDOUT verbatim, running stats to STDERR. One game
is buffered at a time; a rejected game's movetext is never buffered — safe
on a ~200 GB decompressed month.

Accept criteria (data-strategy v3 pinned recipe — see pgnstream.py docstring
for provenance; spec 211:47 requires the [%eval] tags for Tier-1 mining):
    rated  AND  TimeControl in {600+5, 900+10, 1800+0, 1800+20}
    AND  both Elos >= 1400  AND  movetext contains [%eval]

Typical use (the month loop wraps this — see run_month.py):
    zstd -dc lichess_db_standard_rated_2026-05.pgn.zst \\
      | python3 scripts/mining/filter_month.py --stats-json m.stats.json \\
      | python3 scripts/mining/band_cap.py --cap 50000 > 2026-05.pgn

--band-cap N applies the per-band cap inline (same semantics as band_cap.py)
when you don't need the cap as a separate pipe stage.
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone

import pgnstream
from pgnstream import (DEFAULT_MIN_ELO, RAPID_CLASSICAL_TCS, Filter, band_of,
                       iter_games, min_elo_of, tc_set_from_arg, write_game)


def parse_args():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--min-elo", type=int, default=DEFAULT_MIN_ELO,
                   help="Minimum Elo required of BOTH players "
                        f"(default {DEFAULT_MIN_ELO}, per data-strategy v3).")
    p.add_argument("--time-control", default=RAPID_CLASSICAL_TCS,
                   help="TimeControls to keep, comma-separated (default "
                        f'"{RAPID_CLASSICAL_TCS}" — the calibrated '
                        'rapid+classical four). "any" disables the filter.')
    p.add_argument("--allow-unrated", dest="rated_only", action="store_false",
                   default=True, help="Also keep casual games (default: "
                                      "rated only).")
    p.add_argument("--no-require-evals", dest="require_evals",
                   action="store_false", default=True,
                   help="Drop the [%%eval] requirement (NOT the mining "
                        "recipe; for experiments only).")
    p.add_argument("--band-cap", type=int, default=0,
                   help="Optional inline per-100-Elo-band cap on accepted "
                        "games (0 = off; usually band_cap.py does this).")
    p.add_argument("--limit", type=int, default=0,
                   help="Stop after N accepted games (0 = off; smoke tests).")
    p.add_argument("--stats-json", default=None,
                   help="Also write the final stats as JSON to this path.")
    p.add_argument("--progress-every", type=int, default=500000,
                   help="stderr progress line every N games seen "
                        "(default 500000; 0 = off).")
    return p.parse_args()


def main():
    args = parse_args()
    flt = Filter(min_elo=args.min_elo,
                 tc_set=tc_set_from_arg(args.time_control),
                 rated_only=args.rated_only,
                 require_evals=args.require_evals)
    out = sys.stdout.buffer

    seen = matched = 0
    rejected = {}                    # reason -> count
    by_band = {}                     # band -> accepted count
    by_tc = {}                       # TimeControl -> accepted count
    band_cap_skipped = 0
    started = time.time()
    limit_hit = False

    for headers, text, reject, has_eval in iter_games(sys.stdin.buffer, flt):
        seen += 1
        if args.progress_every and seen % args.progress_every == 0:
            el = time.time() - started
            print(f"  [filter] seen {seen:,} | accepted {matched:,} | "
                  f"{seen / el:,.0f} games/s | {el:.0f}s",
                  file=sys.stderr, flush=True)
        if reject:
            rejected[reject] = rejected.get(reject, 0) + 1
            continue
        if flt.require_evals and not has_eval:
            rejected["no_eval"] = rejected.get("no_eval", 0) + 1
            continue
        lo = min_elo_of(headers)     # headers passed, so this is an int
        band = band_of(lo) if lo is not None else "?"
        if args.band_cap and by_band.get(band, 0) >= args.band_cap:
            band_cap_skipped += 1
            continue
        write_game(out, text)
        matched += 1
        by_band[band] = by_band.get(band, 0) + 1
        tc = headers.get(b"TimeControl", b"?").decode("utf-8", "replace")
        by_tc[tc] = by_tc.get(tc, 0) + 1
        if args.limit and matched >= args.limit:
            limit_hit = True
            break
    out.flush()

    elapsed = time.time() - started
    stats = {
        "filter": flt.describe(),
        "band_cap_inline": args.band_cap or None,
        "games_seen": seen,
        "games_accepted": matched,
        "rejected": dict(sorted(rejected.items())),
        "band_cap_skipped": band_cap_skipped,
        "accepted_by_band": dict(sorted(by_band.items())),
        "accepted_by_time_control": dict(sorted(by_tc.items(),
                                                key=lambda kv: -kv[1])),
        "limit_hit": limit_hit,
        "elapsed_seconds": round(elapsed, 1),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    if args.stats_json:
        with open(args.stats_json, "w", encoding="utf-8") as f:
            json.dump(stats, f, indent=2)
    print(f"[filter] done: seen {seen:,}, accepted {matched:,} "
          f"({elapsed:.0f}s)", file=sys.stderr)
    print("[filter] " + json.dumps(stats), file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        pgnstream.exit_on_broken_pipe()

#!/usr/bin/env python3
"""band_cap.py — cap PGN games at N per 100-Elo band, as a pipe stage.

Reads (already-filtered) PGN games from STDIN, writes at most --cap games
per band to STDOUT, drops the rest. Bands are 100-Elo-wide by the LOWER of
the two players' Elos (build_reference_pack.py:298 convention; corpus is
"1400-2200, band-balanced" per docs/research/elo-conditioned-eval-design.md:258).
First-come-first-kept within a band — the dump is chronological, so a capped
band is a contiguous early-month sample; good enough for mining, revisit if
within-month drift ever matters.

Caps are PER INVOCATION (i.e. per month in the run_month.py loop). Pass
--state counts.json to make them cumulative across invocations instead:
counts load from the file at start and are written back (atomically) at end.

Usage:
    ... | python3 band_cap.py --cap 50000 [--state counts.json] \\
                              [--stats-json cap.stats.json] > out.pgn
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import pgnstream
from pgnstream import band_of, iter_games, min_elo_of, write_game


def parse_args():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--cap", type=int, required=True,
                   help="Max games kept per 100-Elo band. Tune with "
                        "tune_caps.py before a corpus build.")
    p.add_argument("--state", default=None,
                   help="JSON file of cumulative per-band counts; makes the "
                        "cap span multiple invocations (default: per-run).")
    p.add_argument("--stats-json", default=None,
                   help="Write this run's stats as JSON to this path.")
    return p.parse_args()


def load_state(path):
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return {str(k): int(v) for k, v in json.load(f).items()}
    return {}


def save_state(path, counts):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(counts.items())), f, indent=2)
    os.replace(tmp, path)  # atomic: a crash never corrupts the state file


def main():
    args = parse_args()
    counts = load_state(args.state)
    start_counts = dict(counts)
    out = sys.stdout.buffer

    seen = kept = 0
    dropped_by_band = {}
    for headers, text, _reject, _has_eval in iter_games(sys.stdin.buffer):
        seen += 1
        lo = min_elo_of(headers)
        band = band_of(lo) if lo is not None else "?"
        if counts.get(band, 0) >= args.cap:
            dropped_by_band[band] = dropped_by_band.get(band, 0) + 1
            continue
        write_game(out, text)
        counts[band] = counts.get(band, 0) + 1
        kept += 1
    out.flush()

    if args.state:
        save_state(args.state, counts)

    kept_by_band = {b: counts.get(b, 0) - start_counts.get(b, 0)
                    for b in counts if counts.get(b, 0) > start_counts.get(b, 0)}
    stats = {
        "cap": args.cap,
        "state_file": args.state,
        "games_in": seen,
        "games_kept": kept,
        "games_dropped": seen - kept,
        "kept_by_band": dict(sorted(kept_by_band.items())),
        "dropped_by_band": dict(sorted(dropped_by_band.items())),
        "cumulative_by_band": dict(sorted(counts.items())),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    if args.stats_json:
        with open(args.stats_json, "w", encoding="utf-8") as f:
            json.dump(stats, f, indent=2)
    print(f"[band_cap] kept {kept:,} / {seen:,} (cap {args.cap}/band)",
          file=sys.stderr)
    print("[band_cap] " + json.dumps(stats), file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        pgnstream.exit_on_broken_pipe()

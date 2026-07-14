#!/usr/bin/env python3
"""tune_caps.py — pick the band-cap N before the corpus build.

Runs the mining filter over 1-3 downloaded months in a SINGLE counting pass
(nothing is written), then prints a size/balance table for several candidate
per-band caps so a human can pick N. This is the "tune band-cap N on 2-3
recent full months" step from data-strategy v3; the target is a ~50-60 GB
corpus of ~9-10.5M games total.

Prep the inputs without filtering (resumable, rate-limited):
    python3 scripts/mining/run_month.py 2026-03 --corpus-dir /data/mining \\
        --download-only
Then:
    nice -n19 ionice -c3 python3 scripts/mining/tune_caps.py \\
        /data/mining/raw/lichess_db_standard_rated_2026-0{3,4,5}.pgn.zst \\
        --caps 25000,50000,100000,200000

Kept-size estimates use each band's average game size (the cap keeps a
first-come sample, so per-band averages are the honest estimator).
--max-input-bytes caps COMPRESSED bytes per input for quick smoke passes —
counts are then a sample of the month head, not the month.
"""

import argparse
import sys
import time

from pgnstream import (DEFAULT_MIN_ELO, RAPID_CLASSICAL_TCS, Filter, band_of,
                       iter_games, min_elo_of, pgn_lines, tc_set_from_arg)

DEFAULT_CAPS = "25000,50000,100000,200000"


def parse_args():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("inputs", nargs="+",
                   help=".pgn.zst / .pgn paths (or '-' for stdin), one per "
                        "month. Use 1-3 RECENT months (match rates grew 40x "
                        "2019->2025; old months mislead).")
    p.add_argument("--caps", default=DEFAULT_CAPS,
                   help=f"Candidate per-band caps (default {DEFAULT_CAPS}).")
    p.add_argument("--min-elo", type=int, default=DEFAULT_MIN_ELO)
    p.add_argument("--time-control", default=RAPID_CLASSICAL_TCS)
    p.add_argument("--max-input-bytes", type=int, default=0,
                   help="Read at most N compressed bytes per input "
                        "(0 = whole month). For smoke tests only.")
    p.add_argument("--progress-every", type=int, default=500000)
    return p.parse_args()


def scan(path, flt, args):
    """One counting pass: band -> [n_candidates, total_bytes]."""
    bands = {}
    seen = 0
    started = time.time()
    for headers, text, reject, has_eval in iter_games(
            pgn_lines(path, args.max_input_bytes), flt):
        seen += 1
        if args.progress_every and seen % args.progress_every == 0:
            el = time.time() - started
            print(f"  [tune] {path}: seen {seen:,} | "
                  f"{seen / el:,.0f} games/s", file=sys.stderr, flush=True)
        if reject or (flt.require_evals and not has_eval):
            continue
        lo = min_elo_of(headers)
        band = band_of(lo) if lo is not None else "?"
        st = bands.setdefault(band, [0, 0])
        st[0] += 1
        st[1] += len(text.rstrip(b"\n")) + 2  # as write_game would emit it
    return bands, seen


def band_sort_key(b):
    return (1, 0) if b == "?" else (0, int(b))


def print_table(title, bands, caps):
    order = sorted(bands, key=band_sort_key)
    print(f"\n=== {title} ===")
    hdr = f"{'band':>6} {'candidates':>11} {'avg KB':>7}"
    hdr += "".join(f" {'kept@' + str(c):>12}" for c in caps)
    print(hdr)
    for b in order:
        n, size = bands[b]
        avg_kb = size / n / 1024 if n else 0.0
        row = f"{b:>6} {n:>11,} {avg_kb:>7.2f}"
        row += "".join(f" {min(n, c):>12,}" for c in caps)
        print(row)
    print("-" * len(hdr))
    tot_row = (f"{'total':>6} {sum(n for n, _ in bands.values()):>11,} "
               f"{'':>7}")
    tot_row += "".join(
        f" {sum(min(n, c) for n, _ in bands.values()):>12,}" for c in caps)
    print(tot_row)

    # Per-cap summary: size, balance, projection to the corpus targets.
    print(f"\n{'cap':>10} {'games/mo':>12} {'GB/mo':>8} {'balance':>8} "
          f"{'mo->10M games':>14} {'GB @ 10M':>9}")
    for c in caps:
        games = size_b = 0
        kept_sizes = []
        for b in order:
            n, size = bands[b]
            k = min(n, c)
            games += k
            gb = size / n * k if n else 0  # avg game size x kept
            size_b += gb
            if n:
                kept_sizes.append(k)
        # balance: smallest band / largest band after capping (1.0 = flat)
        bal = (min(kept_sizes) / max(kept_sizes)) if kept_sizes else 0.0
        months_to_10m = 10e6 / games if games else float("inf")
        gb_at_10m = size_b / 1e9 * months_to_10m if games else float("inf")
        print(f"{c:>10,} {games:>12,} {size_b / 1e9:>8.2f} {bal:>8.2f} "
              f"{months_to_10m:>14.1f} {gb_at_10m:>9.1f}")
    print("\n(balance = min band / max band after capping; targets per "
          "data-strategy v3: ~9-10.5M games, 50-60 GB)")


def main():
    args = parse_args()
    caps = sorted({int(c) for c in args.caps.split(",") if c.strip()})
    flt = Filter(min_elo=args.min_elo,
                 tc_set=tc_set_from_arg(args.time_control),
                 rated_only=True, require_evals=True)

    combined = {}
    for path in args.inputs:
        started = time.time()
        bands, seen = scan(path, flt, args)
        print(f"[tune] {path}: {seen:,} games scanned in "
              f"{time.time() - started:.0f}s", file=sys.stderr)
        print_table(f"{path} (1 month)", bands, caps)
        for b, (n, size) in bands.items():
            st = combined.setdefault(b, [0, 0])
            st[0] += n
            st[1] += size

    if len(args.inputs) > 1:
        # Per-month average across the sampled months (caps apply per month).
        m = len(args.inputs)
        avg = {b: [n // m, size // m] for b, (n, size) in combined.items()}
        print_table(f"AVERAGE per month over {m} inputs", avg, caps)


if __name__ == "__main__":
    main()

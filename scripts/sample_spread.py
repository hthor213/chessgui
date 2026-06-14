#!/usr/bin/env python3
"""
sample_spread.py — Demonstrate sampling a *spread* of starting positions
across a target eval range, with variance (not all the same eval).

Loads data/tagged_positions.json (produced by tag_positions.py), buckets the
positions into fixed-width eval bins (default 0.25 pawns) across a target range
(default [-2.0, +2.0]), and samples to approximate a uniform spread across the
buckets. This is the core of the "eval-qualified starting positions" tournament
mode: pick N openings whose evals are evenly spread across the range so each
game starts from a controlled, known imbalance.

Pure stdlib.

Usage:
    python3 scripts/sample_spread.py
    python3 scripts/sample_spread.py --input data/tagged_positions.json \
        --lo -2.0 --hi 2.0 --bin 0.25 --n 16 --seed 1
"""

import argparse
import json
import math
import random
import sys


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-i", "--input", default="data/tagged_positions.json")
    p.add_argument("--lo", type=float, default=-2.0, help="Range low (pawns).")
    p.add_argument("--hi", type=float, default=2.0, help="Range high (pawns).")
    p.add_argument("--bin", type=float, default=0.25, help="Bin width (pawns).")
    p.add_argument("-n", "--n", type=int, default=16,
                   help="Number of positions to select.")
    p.add_argument("--seed", type=int, default=1)
    return p.parse_args()


def bin_index(value, lo, width):
    return int(math.floor((value - lo) / width))


def main():
    args = parse_args()
    rng = random.Random(args.seed)

    try:
        data = json.load(open(args.input, encoding="utf-8"))
    except FileNotFoundError:
        sys.exit(f"Not found: {args.input} (run tag_positions.py first).")

    nbins = int(round((args.hi - args.lo) / args.bin))
    buckets = [[] for _ in range(nbins)]
    for d in data:
        v = d["eval_pawns"]
        if args.lo <= v < args.hi:
            buckets[bin_index(v, args.lo, args.bin)].append(d)

    # --- Report bucket occupancy (proves variance is available) ---
    print(f"Loaded {len(data)} tagged positions from {args.input}")
    print(f"Target range [{args.lo:+.2f}, {args.hi:+.2f}] in "
          f"{nbins} bins of {args.bin} pawns:\n")
    print(f"  {'bin (pawns)':>16}   count")
    nonempty = 0
    for i, b in enumerate(buckets):
        lo = args.lo + i * args.bin
        hi = lo + args.bin
        if b:
            nonempty += 1
        bar = "#" * len(b)
        print(f"  [{lo:+.2f}, {hi:+.2f}): {len(b):3d}  {bar}")
    print(f"\n{nonempty}/{nbins} bins populated.\n")

    # --- Sample a spread: round-robin across bins, jittered order ---
    # Visit bins in a shuffled order so the spread is varied across runs, and
    # draw one (unique) position per bin per pass until N are collected.
    for b in buckets:
        rng.shuffle(b)
    cursors = [0] * nbins
    order = list(range(nbins))
    selected = []
    while len(selected) < args.n:
        rng.shuffle(order)
        progressed = False
        for i in order:
            if len(selected) >= args.n:
                break
            if cursors[i] < len(buckets[i]):
                selected.append(buckets[i][cursors[i]])
                cursors[i] += 1
                progressed = True
        if not progressed:
            break  # exhausted all buckets

    selected.sort(key=lambda d: d["eval_pawns"])
    print(f"Selected {len(selected)} positions (requested {args.n}), "
          f"spread across the range:\n")
    evs = [d["eval_pawns"] for d in selected]
    for d in selected:
        print(f"  {d['eval_pawns']:+6.2f}  {d['fen']}")
    if evs:
        spread = max(evs) - min(evs)
        print(f"\n  eval span of selection: {min(evs):+.2f} .. {max(evs):+.2f} "
              f"(spread {spread:.2f} pawns, {len(set(evs))} distinct evals)")


if __name__ == "__main__":
    main()

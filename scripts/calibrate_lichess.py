#!/usr/bin/env python3
"""
calibrate_lichess.py — Size the Lichess "quality pack" filter before building
the full history.

Streams the head of a few sample months ONCE each (via
build_reference_pack.line_stream, so the sample is identical to what the real
filter sees) and tallies EVERY candidate filter combo simultaneously:

    elo in {--elos}  x  TC set {rapid, rapid+classical}  x  evals {off, on}

then extrapolates each combo to a full-history game count using authoritative
per-year totals from https://database.lichess.org/standard/counts.txt, and
prints an estimated imported-DB size (games x --bytes-per-game).

The point: pick the filter whose full-history yield lands in a target disk
budget, biased toward longer time controls and higher Elo over raw volume.
Calibration only — it never writes a pack; use build_reference_pack.py for that.

Example:
    python3 scripts/calibrate_lichess.py \
        --months 2019-06,2022-06,2025-06 --max-input-bytes 300000000
"""

import argparse
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_reference_pack as brp  # noqa: E402

RAPID = {"600+5", "900+10"}
CLASSICAL = {"1800+0", "1800+20"}
TCSETS = {"rapid": RAPID, "rapid+classical": RAPID | CLASSICAL}
DUMP_URL = ("https://database.lichess.org/standard/"
            "lichess_db_standard_rated_{ym}.pgn.zst")
COUNTS_URL = "https://database.lichess.org/standard/counts.txt"


def parse_args():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--months", default="2019-06,2022-06,2025-06",
                   help="Comma list of YYYY-MM sample months (early/mid/recent "
                        "eras). Default 2019-06,2022-06,2025-06.")
    p.add_argument("--elos", default="2000,2200",
                   help="Comma list of min-Elo thresholds to test "
                        "(default 2000,2200).")
    p.add_argument("--max-input-bytes", type=int, default=300_000_000,
                   help="Compressed bytes to stream per month (default 300MB).")
    p.add_argument("--bytes-per-game", type=int, default=5745,
                   help="Imported SQLite bytes/game incl. position index "
                        "(measured default 5745).")
    return p.parse_args()


def tally_month(url, elos, max_bytes):
    seen = 0
    counters = {(e, ts, ev): 0
                for e in elos for ts in TCSETS for ev in (False, True)}
    buf, headers, in_move = [], {}, False

    def process(buf, headers):
        nonlocal seen
        if not headers:
            return
        seen += 1
        if not headers.get("Event", "").lower().startswith("rated"):
            return
        we, be = headers.get("WhiteElo"), headers.get("BlackElo")
        if not we or not be or we == "?" or be == "?":
            return
        try:
            lo_elo = min(int(we), int(be))
        except ValueError:
            return
        tc = headers.get("TimeControl")
        has_eval = "%eval" in "".join(buf)
        for e in elos:
            if lo_elo < e:
                continue
            for ts_name, ts_set in TCSETS.items():
                if tc not in ts_set:
                    continue
                counters[(e, ts_name, False)] += 1
                if has_eval:
                    counters[(e, ts_name, True)] += 1

    for line, _ in brp.line_stream(url, max_bytes):
        s = line.strip()
        if s.startswith("["):
            if in_move:
                process(buf, headers)
                buf, headers, in_move = [], {}, False
            buf.append(line)
            k, v = brp.parse_header_line(line)
            if k:
                headers[k] = v
        else:
            buf.append(line)
            if s:
                in_move = True
    process(buf, headers)
    return seen, counters


def fetch_year_totals():
    """Sum counts.txt by year -> {year:int total games}."""
    import re
    req = urllib.request.Request(COUNTS_URL,
                                 headers={"User-Agent": "chessgui-refpack/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310
        text = r.read().decode("utf-8", "replace")
    totals = {}
    for line in text.splitlines():
        m = re.search(r"rated_(\d{4})-\d{2}\.pgn\.zst\s+(\d+)", line)
        if m:
            totals[int(m.group(1))] = totals.get(int(m.group(1)), 0) \
                + int(m.group(2))
    return totals


def era_for(year, months):
    """Map a calendar year to the NEAREST sample month (by year distance).

    Nearest (not floor) so e.g. 2021 attaches to a 2022 sample and 2024 to a
    2025 sample — the closest observed adoption rate for that era.
    """
    return min(months, key=lambda m: abs(int(m.split("-")[0]) - year))


def main():
    args = parse_args()
    months = [m.strip() for m in args.months.split(",") if m.strip()]
    elos = [int(e) for e in args.elos.split(",")]

    rates = {}
    for ym in months:
        sys.stderr.write(f"=== {ym} ===\n")
        seen, counters = tally_month(DUMP_URL.format(ym=ym), elos,
                                     args.max_input_bytes)
        sys.stderr.write(f"  seen={seen:,}\n")
        rates[ym] = {k: (v / seen if seen else 0) for k, v in counters.items()}
        rates[ym]["_seen"] = seen

    print("=== SAMPLED MATCH RATES (per game seen) ===")
    for ym in months:
        print(f"\n{ym}  seen={rates[ym]['_seen']:,}")
        for e in elos:
            for ts in TCSETS:
                for ev in (False, True):
                    r = rates[ym][(e, ts, ev)]
                    print(f"  elo>={e} tc={ts:16s} evals={'on ' if ev else 'off'}"
                          f"  {r*100:.4f}%")

    totals = fetch_year_totals()
    print("\n=== FULL-HISTORY EXTRAPOLATION ===")
    print(f"(years {min(totals)}-{max(totals)}, "
          f"{sum(totals.values()):,} total games)\n")
    print(f"{'filter':44s} {'est games':>13s} {'est DB GB':>10s}")
    for e in elos:
        for ts in TCSETS:
            for ev in (False, True):
                est = sum(rates[era_for(y, months)][(e, ts, ev)] * t
                          for y, t in totals.items())
                gb = est * args.bytes_per_game / 1e9
                flag = "  <-- in 20-30GB" if 20 <= gb <= 30 else ""
                label = f"elo>={e} tc={ts} evals={'on' if ev else 'off'}"
                print(f"{label:44s} {est:13,.0f} {gb:9.1f}G{flag}")


if __name__ == "__main__":
    main()

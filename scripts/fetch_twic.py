#!/usr/bin/env python3
"""
fetch_twic.py — Fetch + unzip a range of TWIC (The Week in Chess) weekly PGN
issues into the reference-database staging area.

TWIC publishes one ZIP per weekly issue at:
    https://theweekinchess.com/zips/twic<NNNN>g.zip
where <NNNN> is the issue number (e.g. 1652). Each zip contains a single
.pgn of that week's games — the standard "ongoing freshness" feed for a
master-games database.

TERMS OF USE (important): TWIC is stated to be "free for personal use only.
All rights are reserved." (https://theweekinchess.com/twic). This script
therefore fetches into data/reference/ (gitignored, LOCAL staging) for
personal use; the downloaded PGN is NOT redistributed and NOT committed. Do
not re-publish TWIC PGN.

Politeness: single-threaded, identifies via User-Agent, sleeps between
requests, and is idempotent + resumable — issues already downloaded are
skipped, so a re-run only fetches what's missing. Missing issue numbers
(404) are reported and skipped, never fatal.

Extracted PGNs can then be imported directly (they're plain .pgn) or fed
through build_reference_pack.py if you want to filter them.

Examples:
    # Fetch issues 1600..1652 into data/reference/twic/
    python3 scripts/fetch_twic.py --from 1600 --to 1652

    # Fetch a single issue, keep the zips too
    python3 scripts/fetch_twic.py --from 1652 --to 1652 --keep-zip
"""

import argparse
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile

ZIP_URL = "https://theweekinchess.com/zips/twic{n}g.zip"


def parse_args():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--from", dest="lo", type=int, required=True,
                   help="First issue number (inclusive).")
    p.add_argument("--to", dest="hi", type=int, required=True,
                   help="Last issue number (inclusive).")
    p.add_argument("--out", default="data/reference/twic",
                   help="Output dir for extracted PGNs (default "
                        "data/reference/twic).")
    p.add_argument("--delay", type=float, default=2.0,
                   help="Seconds to sleep between downloads (default 2.0).")
    p.add_argument("--keep-zip", action="store_true",
                   help="Keep the downloaded .zip files (default: delete "
                        "after extracting).")
    return p.parse_args()


def fetch_one(n, out_dir, delay, keep_zip):
    """Fetch+extract issue n. Returns 'ok' | 'skip' | 'missing' | 'error'."""
    pgn_path = os.path.join(out_dir, f"twic{n}.pgn")
    if os.path.isfile(pgn_path) and os.path.getsize(pgn_path) > 0:
        return "skip"  # already have it -> resumable/idempotent

    url = ZIP_URL.format(n=n)
    zip_path = os.path.join(out_dir, f"twic{n}g.zip")
    req = urllib.request.Request(
        url, headers={"User-Agent": "chessgui-refpack/1.0 (personal use)"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310
            data = r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return "missing"
        print(f"  twic{n}: HTTP {e.code}", file=sys.stderr)
        return "error"
    except Exception as e:
        print(f"  twic{n}: {e}", file=sys.stderr)
        return "error"

    with open(zip_path, "wb") as f:
        f.write(data)
    try:
        with zipfile.ZipFile(zip_path) as z:
            names = [nm for nm in z.namelist() if nm.lower().endswith(".pgn")]
            if not names:
                print(f"  twic{n}: no .pgn inside zip", file=sys.stderr)
                return "error"
            # Extract the (single) pgn to a stable per-issue name.
            with z.open(names[0]) as src, open(pgn_path, "wb") as dst:
                dst.write(src.read())
    except zipfile.BadZipFile:
        print(f"  twic{n}: bad zip", file=sys.stderr)
        return "error"
    finally:
        if not keep_zip and os.path.isfile(zip_path):
            os.remove(zip_path)

    time.sleep(delay)
    return "ok"


def main():
    args = parse_args()
    if args.hi < args.lo:
        sys.exit("--to must be >= --from")
    os.makedirs(args.out, exist_ok=True)

    counts = {"ok": 0, "skip": 0, "missing": 0, "error": 0}
    for n in range(args.lo, args.hi + 1):
        status = fetch_one(n, args.out, args.delay, args.keep_zip)
        counts[status] += 1
        tag = {"ok": "fetched", "skip": "have", "missing": "404",
               "error": "ERR"}[status]
        print(f"  twic{n}: {tag}")

    print(f"\nDone: {counts['ok']} fetched, {counts['skip']} already had, "
          f"{counts['missing']} missing (404), {counts['error']} errors.")
    print(f"  PGNs in {args.out}/")
    if counts["ok"] or counts["skip"]:
        print("  Reminder: TWIC is personal-use-only; do not redistribute or "
              "commit these PGNs.")


if __name__ == "__main__":
    main()

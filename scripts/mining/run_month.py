#!/usr/bin/env python3
"""run_month.py — one iteration of the mining-corpus month loop.

Given a month tag (e.g. 2026-05):
  1. download the Lichess dump if absent (curl: resumable -C -, --limit-rate)
  2. stream-filter it (filter_month.py) with per-band caps (band_cap.py)
  3. land the output in <corpus-dir>/months/<month>.pgn
  4. verify counts (games in the file == band_cap's kept count)
  5. delete the raw .zst (only if WE downloaded it; --keep-zst to keep)

Idempotent and restartable: a completed month leaves months/<month>.done.json
and re-running exits immediately; a crashed run leaves only .part files that
are resumed (download) or redone (filter — the raw .zst is still there).
Every subprocess (curl, zstd, both filter stages) runs under
`nice -n19 ionice -c3` (ionice skipped where unavailable, e.g. macOS).

The corpus is one PGN file per month — "append to the corpus directory"
without ever rewriting or truncating previous months.

Server invocation (band-cap N from a tune_caps.py run — do that first):
    python3 scripts/mining/run_month.py 2026-05 \\
        --corpus-dir /data/mining --cap 50000 --limit-rate 8M
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

from pgnstream import (DEFAULT_MIN_ELO, LICHESS_URL_TEMPLATE,
                       RAPID_CLASSICAL_TCS)

HERE = os.path.dirname(os.path.abspath(__file__))


def parse_args():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("month", help="Month tag, e.g. 2026-05.")
    p.add_argument("--corpus-dir", default="corpus",
                   help="Corpus root; gets raw/ and months/ subdirs "
                        "(default ./corpus — on the server point it at the "
                        "mining volume).")
    p.add_argument("--cap", type=int, default=None,
                   help="Per-band cap N (required unless --download-only; "
                        "no default on purpose — tune it first, see "
                        "tune_caps.py).")
    p.add_argument("--min-elo", type=int, default=DEFAULT_MIN_ELO)
    p.add_argument("--time-control", default=RAPID_CLASSICAL_TCS)
    p.add_argument("--limit-rate", default="8M",
                   help='curl --limit-rate value (default "8M"; be polite '
                        "to database.lichess.org).")
    p.add_argument("--url-template", default=LICHESS_URL_TEMPLATE,
                   help="Dump URL template with {month} placeholder.")
    p.add_argument("--zst", default=None,
                   help="Use this local .pgn.zst instead of downloading "
                        "(never deleted afterwards).")
    p.add_argument("--keep-zst", action="store_true",
                   help="Keep the downloaded raw dump after success.")
    p.add_argument("--download-only", action="store_true",
                   help="Fetch the raw .zst and stop (for tune_caps.py "
                        "input prep).")
    return p.parse_args()


def nice_prefix():
    """`nice -n19 ionice -c3` prefix, dropping ionice if the box lacks it."""
    prefix = ["nice", "-n19"]
    if shutil.which("ionice"):
        prefix += ["ionice", "-c3"]
    return prefix


def remote_size(url):
    """Content-Length via curl -sIL, or None if it can't be determined."""
    try:
        out = subprocess.run(["curl", "-sIL", "--max-time", "60", url],
                             capture_output=True, text=True,
                             check=True).stdout
    except (subprocess.CalledProcessError, OSError):
        return None
    sizes = re.findall(r"(?im)^content-length:\s*(\d+)", out)
    return int(sizes[-1]) if sizes else None


def download(url, dest, limit_rate, prefix):
    """Resumable, rate-limited download to dest (via dest.part)."""
    if os.path.exists(dest):
        print(f"[run_month] raw dump present: {dest}", file=sys.stderr)
        return
    part = dest + ".part"
    want = remote_size(url)
    if want and os.path.exists(part) and os.path.getsize(part) == want:
        os.replace(part, dest)  # previous run finished the bytes, died before rename
        return
    print(f"[run_month] downloading {url}"
          + (f" ({want / 1e9:.1f} GB)" if want else ""), file=sys.stderr)
    cmd = prefix + ["curl", "-L", "--fail", "--retry", "5",
                    "--retry-delay", "15", "-C", "-",
                    "--limit-rate", limit_rate, "-o", part, url]
    rc = subprocess.call(cmd)
    have = os.path.getsize(part) if os.path.exists(part) else 0
    # curl exits 33/22 when the .part is already complete (HTTP 416).
    if rc != 0 and not (want and have == want):
        sys.exit(f"[run_month] download failed (curl rc={rc}); "
                 f".part kept for resume: {part}")
    if want and have != want:
        sys.exit(f"[run_month] size mismatch after download: have {have}, "
                 f"expected {want}; .part kept for resume: {part}")
    os.replace(part, dest)


def count_games(path):
    """Number of games in a PGN file = lines starting with [Event ."""
    n = 0
    with open(path, "rb") as f:
        for line in f:
            if line.startswith(b"[Event "):
                n += 1
    return n


def main():
    args = parse_args()
    if not re.fullmatch(r"\d{4}-\d{2}", args.month):
        sys.exit(f"[run_month] bad month tag {args.month!r} (want YYYY-MM)")
    if args.cap is None and not args.download_only:
        sys.exit("[run_month] --cap is required (tune it with tune_caps.py "
                 "first; an untuned corpus build blows the 50-60 GB budget)")

    raw_dir = os.path.join(args.corpus_dir, "raw")
    months_dir = os.path.join(args.corpus_dir, "months")
    os.makedirs(raw_dir, exist_ok=True)
    os.makedirs(months_dir, exist_ok=True)

    done_path = os.path.join(months_dir, f"{args.month}.done.json")
    if os.path.exists(done_path):
        print(f"[run_month] {args.month} already done ({done_path}); "
              "nothing to do.", file=sys.stderr)
        return

    prefix = nice_prefix()
    url = args.url_template.format(month=args.month)
    if args.zst:
        zst_path = args.zst
        downloaded_by_us = False
        if not os.path.exists(zst_path):
            sys.exit(f"[run_month] --zst file not found: {zst_path}")
    else:
        zst_path = os.path.join(raw_dir, os.path.basename(url))
        downloaded_by_us = True
        download(url, zst_path, args.limit_rate, prefix)
    if args.download_only:
        print(f"[run_month] download-only: {zst_path}", file=sys.stderr)
        return

    out_pgn = os.path.join(months_dir, f"{args.month}.pgn")
    out_part = out_pgn + ".part"
    filter_stats = os.path.join(months_dir, f"{args.month}.filter.stats.json")
    cap_stats = os.path.join(months_dir, f"{args.month}.cap.stats.json")

    # zstd -dc | filter_month.py | band_cap.py > out.part
    print(f"[run_month] filtering {zst_path} (cap {args.cap}/band) ...",
          file=sys.stderr)
    with open(out_part, "wb") as out_f:
        p_zstd = subprocess.Popen(prefix + ["zstd", "-dc", zst_path],
                                  stdout=subprocess.PIPE)
        p_filter = subprocess.Popen(
            prefix + [sys.executable, os.path.join(HERE, "filter_month.py"),
                      "--min-elo", str(args.min_elo),
                      "--time-control", args.time_control,
                      "--stats-json", filter_stats],
            stdin=p_zstd.stdout, stdout=subprocess.PIPE)
        p_cap = subprocess.Popen(
            prefix + [sys.executable, os.path.join(HERE, "band_cap.py"),
                      "--cap", str(args.cap), "--stats-json", cap_stats],
            stdin=p_filter.stdout, stdout=out_f)
        # Drop parent copies so SIGPIPE propagates if a stage dies.
        p_zstd.stdout.close()
        p_filter.stdout.close()
        rcs = [p.wait() for p in (p_zstd, p_filter, p_cap)]
    if any(rcs):
        os.unlink(out_part)
        sys.exit(f"[run_month] pipeline failed (zstd/filter/cap rcs={rcs}); "
                 f"raw dump kept for retry: {zst_path}")

    # Verify: games in the file must equal band_cap's kept count.
    with open(cap_stats, encoding="utf-8") as f:
        cap_s = json.load(f)
    with open(filter_stats, encoding="utf-8") as f:
        filter_s = json.load(f)
    n_file = count_games(out_part)
    if n_file != cap_s["games_kept"]:
        sys.exit(f"[run_month] VERIFY FAILED: {n_file} games in {out_part} "
                 f"vs {cap_s['games_kept']} kept by band_cap; raw dump kept.")
    os.replace(out_part, out_pgn)

    done = {
        "month": args.month,
        "source": zst_path if args.zst else url,
        "cap": args.cap,
        "output": os.path.abspath(out_pgn),
        "output_games": n_file,
        "output_bytes": os.path.getsize(out_pgn),
        "games_seen": filter_s["games_seen"],
        "games_accepted": filter_s["games_accepted"],
        "kept_by_band": cap_s["kept_by_band"],
        "verified": True,
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }
    tmp = done_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(done, f, indent=2)
    os.replace(tmp, done_path)  # the .done marker lands last, atomically

    if downloaded_by_us and not args.keep_zst:
        os.unlink(zst_path)
        print(f"[run_month] deleted raw dump {zst_path}", file=sys.stderr)
    print(f"[run_month] {args.month} DONE: {n_file:,} games, "
          f"{done['output_bytes'] / 1e9:.2f} GB -> {out_pgn}",
          file=sys.stderr)


if __name__ == "__main__":
    main()

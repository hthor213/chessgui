#!/usr/bin/env python3
"""
build_reference_pack.py — Streaming header-filter over Lichess (or any) PGN
dumps, producing a filtered .pgn "reference pack" the app imports via its
SQLite backend (src-tauri/src/db.rs :: db_import_pgn).

This is the acquisition/staging stage of the reference-database pipeline
(the ChessBase "Mega Database" replacement). It is deliberately dumb about
*chess* — it parses only PGN **headers**, decides keep/skip per game, and
writes matching games **verbatim** (byte-preserving movetext). Dedup and
position indexing happen later, at import time, in the Rust backend; this
script's only jobs are (a) filter honestly and (b) stay resumable and
crash-proof over multi-GB compressed inputs.

Recipe this implements (Lichess quality pack, per the pipeline spec):
    * rated games only        (Event header starts with "Rated")
    * TimeControl == 600+5    (--time-control, default "600+5")
    * WhiteElo >= 1900 AND BlackElo >= 1900   (--min-elo, default 1900)

Sources:
    * A local .pgn.zst file (the Lichess monthly dump), or
    * A URL to one (streamed + decompressed on the fly — the raw dump is
      never fully materialised on disk).
    * Plain (uncompressed) .pgn files also work (auto-detected by extension).

Provenance / honesty:
    * Every run writes <output>.stats.json next to the pack: input identity,
      the exact filter applied, games seen / matched / errors, and a
      matched-by-year histogram. The pack itself is staging data — it lands
      in data/reference/ (gitignored) and is NEVER written into a user DB by
      this script. Promotion to an imported DB is a separate, logged step
      (see src-tauri/examples/import_smoke.rs and data/reference/README.md).

Malformed games are skipped and counted (errors), never fatal.

Requires: Python 3.8+, and for .zst input either the `zstandard` package
(pip3 install zstandard) or a `zstd`/`zstdcat` binary on PATH (fallback).

Examples:
    # Smoke test: small 2013 month, already downloaded
    python3 scripts/build_reference_pack.py \
        --input data/reference/lichess_db_standard_rated_2013-01.pgn.zst \
        --output data/reference/pack_2013-01.pgn

    # Modern month, stream the first ~200 MB straight from Lichess, cap matches
    python3 scripts/build_reference_pack.py \
        --input https://database.lichess.org/standard/lichess_db_standard_rated_2024-01.pgn.zst \
        --max-input-bytes 200000000 --limit 5000 \
        --output data/reference/pack_2024-01_partial.pgn
"""

import argparse
import io
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

DEFAULT_TIME_CONTROL = "600+5"
DEFAULT_MIN_ELO = 1900


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def parse_args():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-i", "--input", required=True,
                   help="Path or URL to a .pgn.zst (or plain .pgn) dump.")
    p.add_argument("-o", "--output", required=True,
                   help="Output .pgn path for matching games (staging).")
    p.add_argument("--time-control", default=DEFAULT_TIME_CONTROL,
                   help='TimeControl(s) to keep, comma-separated for several '
                        f'(default "{DEFAULT_TIME_CONTROL}"; e.g. '
                        '"600+5,900+10,1800+0,1800+20"). Pass "any" to disable '
                        'this filter.')
    p.add_argument("--min-elo", type=int, default=DEFAULT_MIN_ELO,
                   help="Minimum Elo required of BOTH players "
                        f"(default {DEFAULT_MIN_ELO}).")
    p.add_argument("--require-evals", action="store_true",
                   help="Keep only games whose movetext carries [%%eval] "
                        "annotations (the mistake-mining corpus). Cuts yield.")
    p.add_argument("--rated-only", dest="rated_only", action="store_true",
                   default=True,
                   help="Keep only rated games (default on).")
    p.add_argument("--allow-unrated", dest="rated_only", action="store_false",
                   help="Also keep casual/unrated games.")
    p.add_argument("--limit", type=int, default=0,
                   help="Stop after N matched games (0 = no cap). For smoke "
                        "tests.")
    p.add_argument("--max-input-bytes", type=int, default=0,
                   help="Stop after reading N bytes from the (compressed) "
                        "source (0 = no cap). Lets you sample the head of a "
                        "huge remote month without downloading all of it.")
    p.add_argument("--progress-every", type=int, default=250000,
                   help="Print a progress line every N games seen "
                        "(default 250000).")
    return p.parse_args()


# --------------------------------------------------------------------------- #
# Byte-capped raw reader (works for local files and URL streams alike)
# --------------------------------------------------------------------------- #
class _CappedReader:
    """Wrap a binary stream, counting bytes read and stopping at `cap`."""

    def __init__(self, raw, cap):
        self.raw = raw
        self.cap = cap if cap and cap > 0 else None
        self.read_n = 0

    def read(self, size=-1):
        if self.cap is not None and self.read_n >= self.cap:
            return b""
        want = 65536 if (size is None or size < 0) else size
        if self.cap is not None:
            want = min(want, self.cap - self.read_n)
        chunk = self.raw.read(want)
        self.read_n += len(chunk)
        return chunk

    def close(self):
        try:
            self.raw.close()
        except Exception:
            pass


def _open_raw(source):
    """Return a binary, read()-able stream for a path or URL."""
    if source.startswith("http://") or source.startswith("https://"):
        import urllib.request
        req = urllib.request.Request(
            source, headers={"User-Agent": "chessgui-refpack/1.0"})
        return urllib.request.urlopen(req)  # noqa: S310 (trusted URL)
    return open(source, "rb")


def line_stream(source, max_input_bytes):
    """Yield text lines from a (possibly zstd-compressed) PGN source.

    Decompresses .zst on the fly via the `zstandard` package, falling back to
    a `zstd -dc` subprocess. Plain .pgn passes through. `max_input_bytes` caps
    bytes pulled from the *compressed* source. A truncated final zstd frame
    (expected when the cap trips mid-frame) is treated as clean EOF.

    Yields (line, compressed_bytes_read_so_far).
    """
    is_zst = source.rstrip("/").endswith(".zst")
    raw = _open_raw(source)
    capped = _CappedReader(raw, max_input_bytes)

    if not is_zst:
        text = io.TextIOWrapper(capped, encoding="utf-8", errors="replace")
        try:
            for line in text:
                yield line, capped.read_n
        finally:
            capped.close()
        return

    # zstd path
    try:
        import zstandard as zstd
    except ImportError:
        yield from _line_stream_subprocess(capped, max_input_bytes)
        return

    dctx = zstd.ZstdDecompressor()
    reader = dctx.stream_reader(capped)
    text = io.TextIOWrapper(reader, encoding="utf-8", errors="replace")
    try:
        while True:
            try:
                line = text.readline()
            except (zstd.ZstdError, EOFError):
                # Truncated frame from --max-input-bytes: clean stop.
                break
            if not line:
                break
            yield line, capped.read_n
    finally:
        capped.close()


def _line_stream_subprocess(capped, max_input_bytes):
    """Fallback: pipe the (already byte-capped) stream through `zstd -dc`."""
    exe = None
    for cand in ("zstd", "zstdcat"):
        try:
            subprocess.run([cand, "--version"], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=True)
            exe = cand
            break
        except Exception:
            continue
    if exe is None:
        sys.exit("Need the `zstandard` package or a `zstd` binary to read .zst "
                 "input. pip3 install zstandard")
    cmd = [exe, "-dc"] if exe == "zstd" else [exe]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    # Pump the capped source into the subprocess in a thread; read decoded
    # lines from its stdout on the main thread.
    import threading

    def _pump():
        try:
            while True:
                chunk = capped.read(65536)
                if not chunk:
                    break
                proc.stdin.write(chunk)
        except Exception:
            pass
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    t = threading.Thread(target=_pump, daemon=True)
    t.start()
    text = io.TextIOWrapper(proc.stdout, encoding="utf-8", errors="replace")
    try:
        for line in text:
            yield line, capped.read_n
    finally:
        capped.close()
        try:
            proc.terminate()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# Filtering
# --------------------------------------------------------------------------- #
def parse_header_line(line):
    """'[Key "Value"]' -> ("Key", "Value"), or (None, None)."""
    s = line.strip()
    if not (s.startswith("[") and s.endswith("]")):
        return None, None
    body = s[1:-1]
    sp = body.find(" ")
    if sp < 0:
        return None, None
    key = body[:sp]
    val = body[sp + 1:].strip()
    if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
        val = val[1:-1]
    return key, val


def game_matches(headers, args):
    """True if this game's headers pass the filter. Raises on malformed Elo.

    Header-only checks; --require-evals is applied separately (it needs the
    movetext, not the headers).
    """
    if args.rated_only:
        event = headers.get("Event", "")
        if not event.lower().startswith("rated"):
            return False
    if args.tc_set is not None:
        if headers.get("TimeControl") not in args.tc_set:
            return False
    # Elo: both required and both >= threshold. Missing/"?" => not a match.
    we = headers.get("WhiteElo")
    be = headers.get("BlackElo")
    if we is None or be is None or we == "?" or be == "?":
        return False
    # int() raises ValueError on garbage -> counted as an error upstream.
    if int(we) < args.min_elo or int(be) < args.min_elo:
        return False
    return True


def year_of(headers):
    """Best-effort 4-digit year from UTCDate/Date ('2024.01.31'), or 'unknown'."""
    for k in ("UTCDate", "Date"):
        v = headers.get(k)
        if v and len(v) >= 4 and v[:4].isdigit():
            return v[:4]
    return "unknown"


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main():
    args = parse_args()

    # Comma-separated TimeControls -> a set, or None to disable the filter.
    if args.time_control.strip().lower() == "any":
        args.tc_set = None
    else:
        args.tc_set = {t.strip() for t in args.time_control.split(",")
                       if t.strip()}

    out_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(out_dir, exist_ok=True)
    stats_path = args.output + ".stats.json"

    seen = matched = errors = 0
    by_year = {}
    by_tc = {}
    started = time.time()

    # Per-game accumulation. A new game begins at a '[' header line that
    # follows movetext; games are written verbatim.
    buf = []
    headers = {}
    in_movetext = False

    out = open(args.output, "w", encoding="utf-8")

    def flush(buf, headers):
        """Decide + (maybe) write one accumulated game. Returns True to stop."""
        nonlocal seen, matched, errors
        flush.last_bytes = getattr(flush, "last_bytes", 0)
        if not headers:  # leading junk / blank noise between games
            return False
        seen += 1
        if args.progress_every and seen % args.progress_every == 0:
            _progress(seen, matched, errors, flush.last_bytes, started)
        try:
            keep = game_matches(headers, args)
        except (ValueError, TypeError):
            errors += 1
            return False
        text = "".join(buf)
        if keep and args.require_evals and "%eval" not in text:
            keep = False
        if keep:
            out.write(text)
            if not text.endswith("\n"):
                out.write("\n")
            out.write("\n")  # blank line separator between games
            matched += 1
            y = year_of(headers)
            by_year[y] = by_year.get(y, 0) + 1
            tc = headers.get("TimeControl", "?")
            by_tc[tc] = by_tc.get(tc, 0) + 1
            if args.limit and matched >= args.limit:
                return True
        return False

    stopped_early = False
    last_bytes = 0
    try:
        for line, cbytes in line_stream(args.input, args.max_input_bytes):
            last_bytes = cbytes
            flush.last_bytes = cbytes
            s = line.strip()
            if s.startswith("["):
                if in_movetext:
                    if flush(buf, headers):
                        stopped_early = True
                        break
                    buf, headers, in_movetext = [], {}, False
                buf.append(line)
                k, v = parse_header_line(line)
                if k:
                    headers[k] = v
            else:
                buf.append(line)
                if s:
                    in_movetext = True
        else:
            # Stream exhausted normally: flush the trailing game.
            flush(buf, headers)
    finally:
        out.close()

    elapsed = time.time() - started
    stats = {
        "input": args.input,
        "output": os.path.abspath(args.output),
        "filter": {
            "rated_only": args.rated_only,
            "time_control": args.time_control,
            "min_elo": args.min_elo,
            "require_evals": args.require_evals,
        },
        "games_seen": seen,
        "games_matched": matched,
        "errors_malformed": errors,
        "matched_by_year": dict(sorted(by_year.items())),
        "matched_by_time_control": dict(sorted(by_tc.items(),
                                               key=lambda kv: -kv[1])),
        "limit_hit": bool(args.limit and matched >= args.limit),
        "max_input_bytes": args.max_input_bytes or None,
        "compressed_bytes_read": last_bytes,
        "stopped_early": stopped_early,
        "elapsed_seconds": round(elapsed, 1),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    with open(stats_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2)

    print(f"\nDone in {elapsed:.1f}s")
    print(f"  seen    : {seen}")
    print(f"  matched : {matched}  -> {args.output}")
    print(f"  errors  : {errors} (malformed, skipped)")
    if by_year:
        print("  matched by year: "
              + ", ".join(f"{y}:{n}" for y, n in sorted(by_year.items())))
    print(f"  stats   : {stats_path}")
    if matched == 0:
        print("\n  NOTE: 0 matches. For older months (e.g. 2013) the 600+5 "
              "time control and 1900+ Elo were rare. Try a modern month.")


def _progress(seen, matched, errors, cbytes, started):
    el = time.time() - started
    rate = seen / el if el > 0 else 0
    mb = cbytes / 1e6
    print(f"  seen {seen:,} | matched {matched:,} | err {errors} | "
          f"{mb:,.0f} MB in | {rate:,.0f} games/s | {el:.0f}s",
          file=sys.stderr)


if __name__ == "__main__":
    main()

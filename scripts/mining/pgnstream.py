#!/usr/bin/env python3
"""pgnstream.py — shared streaming-PGN plumbing for the mining-corpus scripts.

Spec 211 (avoidance puzzles) Tier-1 mines eval-tagged games ("Scan games with
[%eval] for single-move eval cliffs", specs/211-avoidance-puzzles.md:47-48);
spec 213 consumes the same corpus for validation ("est. 9-10.5M lichess games,
1400-2200, band-balanced, all with [%eval] labels",
docs/research/elo-conditioned-eval-design.md:258).

The accept recipe implemented here is data-strategy v3 (roadmap plan
`then-we-are-going-witty-kazoo.md`, 2026-07-13, "Final recipe: elo>=1400,
rapid+classical (600+5,900+10,1800+0,1800+20), require-evals, band-cap tuned
to ~9-10.5M games. Blitz excluded."):

    * rated games only          (Event header starts with "Rated")
    * TimeControl in the four calibrated rapid+classical controls
    * WhiteElo >= 1400 AND BlackElo >= 1400
    * movetext carries [%eval ...] annotations

Everything operates on BYTES, one game buffered at a time — a decompressed
Lichess month is ~200 GB and must never be materialised. Games that fail the
header check are streamed past without buffering their movetext.

Bands are 100-Elo-wide, keyed by the LOWER of the two players' Elos — the
same convention as scripts/build_reference_pack.py:298 (band_of) and the
calibration samplers.

Stdlib only (the target server has python3 + the zstd CLI, no pip guarantee).
"""

import os
import subprocess
import sys
import threading

# Data-strategy v3 pinned filter (see module docstring for provenance).
RAPID_CLASSICAL_TCS = "600+5,900+10,1800+0,1800+20"
DEFAULT_MIN_ELO = 1400
BAND_WIDTH = 100

LICHESS_URL_TEMPLATE = ("https://database.lichess.org/standard/"
                        "lichess_db_standard_rated_{month}.pgn.zst")


# --------------------------------------------------------------------------- #
# Header parsing / banding
# --------------------------------------------------------------------------- #
def parse_header(line):
    """b'[Key "Value"]\\n' -> (b'Key', b'Value'), or (None, None)."""
    s = line.strip()
    if not (s.startswith(b"[") and s.endswith(b"]")):
        return None, None
    body = s[1:-1]
    sp = body.find(b" ")
    if sp < 0:
        return None, None
    key = body[:sp]
    val = body[sp + 1:].strip()
    if len(val) >= 2 and val[:1] == b'"' and val[-1:] == b'"':
        val = val[1:-1]
    return key, val


def min_elo_of(headers):
    """Lower of the two players' Elos as int, or None if missing/malformed."""
    we = headers.get(b"WhiteElo")
    be = headers.get(b"BlackElo")
    if not we or not be or we == b"?" or be == b"?":
        return None
    try:
        return min(int(we), int(be))
    except ValueError:
        return None


def band_of(lo_elo):
    """100-Elo band label for a lower-Elo value, e.g. 1456 -> '1400'.

    Same convention as build_reference_pack.py:298. Open-ended at the top:
    the cap only ever bites on the over-full low bands (data-strategy v3),
    high bands stay whatever size they naturally are.
    """
    return str((lo_elo // BAND_WIDTH) * BAND_WIDTH)


def tc_set_from_arg(s):
    """CLI --time-control value -> set of bytes, or None for 'any'."""
    if s.strip().lower() == "any":
        return None
    return {t.strip().encode() for t in s.split(",") if t.strip()}


# --------------------------------------------------------------------------- #
# Clock plumbing ([%clk] tags / TimeControl header)
# --------------------------------------------------------------------------- #
def clk_to_seconds(s):
    """'[%clk H:MM:SS(.t)]' payload str -> seconds float, or None.

    Lichess emits H:MM:SS with tenths on some controls ('0:09:59.4').
    Consumed by spec 211's engagement filter (mine_cliffs.py)."""
    try:
        parts = [float(x) for x in s.split(":")]
    except ValueError:
        return None
    if not 1 <= len(parts) <= 3:
        return None
    sec = 0.0
    for x in parts:
        sec = sec * 60.0 + x
    return sec


def tc_base_inc(tc):
    """TimeControl str 'base+inc' -> (base_s, inc_s) ints, else (None, None).

    Correspondence ('-'), daily ('1/86400'), missing and malformed values
    carry no per-move clock semantics -> (None, None)."""
    if not tc or tc == "-" or "/" in tc:
        return None, None
    base, _, inc = tc.partition("+")
    try:
        return int(base), (int(inc) if inc else 0)
    except ValueError:
        return None, None


# --------------------------------------------------------------------------- #
# Accept filter
# --------------------------------------------------------------------------- #
class Filter:
    """Header-level accept criteria. Eval presence is checked on movetext."""

    __slots__ = ("min_elo", "tc_set", "rated_only", "require_evals")

    def __init__(self, min_elo=DEFAULT_MIN_ELO, tc_set=None, rated_only=True,
                 require_evals=True):
        self.min_elo = min_elo
        # None = TC filter disabled; default = the v3 calibrated four.
        self.tc_set = (tc_set_from_arg(RAPID_CLASSICAL_TCS)
                       if tc_set == "default" else tc_set)
        self.rated_only = rated_only
        self.require_evals = require_evals

    def headers_reject(self, headers):
        """Return a reject-reason string, or None if the headers pass."""
        if self.rated_only:
            if not headers.get(b"Event", b"").lower().startswith(b"rated"):
                return "unrated"
        if self.tc_set is not None:
            if headers.get(b"TimeControl") not in self.tc_set:
                return "time_control"
        we = headers.get(b"WhiteElo")
        be = headers.get(b"BlackElo")
        if not we or not be or we == b"?" or be == b"?":
            return "elo_missing"
        try:
            if int(we) < self.min_elo or int(be) < self.min_elo:
                return "elo_below_min"
        except ValueError:
            return "elo_malformed"
        return None

    def describe(self):
        return {
            "min_elo": self.min_elo,
            "time_control": (sorted(t.decode() for t in self.tc_set)
                             if self.tc_set is not None else "any"),
            "rated_only": self.rated_only,
            "require_evals": self.require_evals,
        }


# --------------------------------------------------------------------------- #
# Streaming game iterator
# --------------------------------------------------------------------------- #
def iter_games(stream, flt=None):
    """Yield (headers, text, reject_reason, has_eval) per game.

    `stream` is a binary line-iterable (sys.stdin.buffer, zstd stdout, ...).
    If `flt` is given, its header check runs the moment movetext starts;
    rejected games yield text=None and their movetext is NOT buffered —
    this is what keeps memory flat over a 200 GB month. `has_eval` is only
    meaningful for games whose headers passed.

    Game boundary heuristic: a '[' line while in movetext starts a new game.
    Lichess exports movetext as a single line, so bracketed comment payloads
    ([%eval]/[%clk]) never begin a line — same assumption as
    build_reference_pack.py.
    """
    headers = {}
    buf = []
    in_movetext = False
    decided = False     # header verdict rendered (at first movetext line)
    reject = None       # reason string once rejected
    has_eval = False

    for line in stream:
        if line[:1] == b"[" and not in_movetext:
            buf.append(line)
            k, v = parse_header(line)
            if k:
                headers[k] = v
            continue
        if line[:1] == b"[":  # in_movetext: boundary — next game begins
            if headers:
                yield headers, (None if reject else b"".join(buf)), \
                    reject, has_eval
            headers, buf = {}, []
            in_movetext = decided = False
            reject, has_eval = None, False
            buf.append(line)
            k, v = parse_header(line)
            if k:
                headers[k] = v
            continue

        stripped = line.strip()
        if stripped and not decided:
            decided = True
            if flt is not None:
                reject = flt.headers_reject(headers)
                if reject:
                    buf = []  # drop; stream past the movetext unbuffered
        if reject is None:
            buf.append(line)
            if not has_eval and b"%eval" in line:
                has_eval = True
        if stripped:
            in_movetext = True

    if headers:  # trailing game at EOF
        yield headers, (None if reject else b"".join(buf)), reject, has_eval


def write_game(out, text):
    """Write one game with exactly one blank-line separator after it."""
    out.write(text.rstrip(b"\n") + b"\n\n")


# --------------------------------------------------------------------------- #
# Input plumbing: .pgn / .pgn.zst / stdin
# --------------------------------------------------------------------------- #
def pgn_lines(path, max_input_bytes=0):
    """Yield raw bytes lines from '-'(stdin), a .pgn, or a .pgn.zst.

    .zst is decompressed via the `zstd` CLI (guaranteed on the target
    server; no pip zstandard needed). `max_input_bytes` caps bytes read from
    the COMPRESSED source — for sampling the head of a huge month — and a
    truncated final frame is treated as clean EOF.
    """
    if path == "-":
        yield from sys.stdin.buffer
        return
    if not path.endswith(".zst"):
        with open(path, "rb") as f:
            yield from f
        return

    if max_input_bytes and max_input_bytes > 0:
        # Pump a byte-capped copy of the file into `zstd -dc` on a thread.
        proc = subprocess.Popen(["zstd", "-dc"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL)

        def _pump():
            try:
                with open(path, "rb") as f:
                    left = max_input_bytes
                    while left > 0:
                        chunk = f.read(min(65536, left))
                        if not chunk:
                            break
                        proc.stdin.write(chunk)
                        left -= len(chunk)
            except (BrokenPipeError, OSError):
                pass
            finally:
                try:
                    proc.stdin.close()
                except OSError:
                    pass

        threading.Thread(target=_pump, daemon=True).start()
    else:
        proc = subprocess.Popen(["zstd", "-dc", path],
                                stdout=subprocess.PIPE)
    try:
        yield from proc.stdout
    finally:
        proc.stdout.close()
        proc.terminate()
        proc.wait()


def exit_on_broken_pipe():
    """Silence the noise when a downstream pipe stage closes early."""
    try:
        sys.stdout.close()
    except (BrokenPipeError, OSError):
        pass
    os.dup2(os.open(os.devnull, os.O_WRONLY), 1)
    sys.exit(141)  # conventional 128+SIGPIPE

#!/usr/bin/env python3
"""
curate_positions.py — Build a curated pool of *imbalanced but reachable* opening
positions for the Engine Tournament starting-position feature.

For every candidate position this script combines three signals:

  1. **Stockfish eval** (depth ~16, normalized to White's point of view) — keep
     only positions whose |eval_pawns| lands inside a target imbalance window
     (default 0.2 .. 1.6). Reuses the UCI-driving + White-POV logic style of
     `tag_positions.py`.
  2. **Lichess Masters explorer** — how many master games actually REACHED this
     position (`self_games`). This is the "is it real chess, not junk?" oracle.
  3. For PGN-sourced candidates (which carry move history) we also query the
     position ONE PLY EARLIER (`parent_games`). High parent + low self =
     "theory to ~move 10, one fresh move into new imbalanced territory".

Curation criterion (all thresholds are CLI-tunable):

  * |eval_pawns| in [--win-lo, --win-hi]  (a real imbalance, not dead-equal,
    not hopeless).
  * quality "just_past_book": parent_games >= --parent-min AND
    self_games <= --self-max-book   (the ideal: mainline parent, fresh child).
  * quality "near_theory": no/low parent info but self_games is in a sane band
    [--self-min .. --self-max-near]  (reached in real master play, not absurdly
    common).
  * Drop pure junk: self_games == 0 with no usable parent signal, or positions
    that are too common / too deep.

The output is binned across the eval range so coverage is even: each
0.2-pawn bin is filled up to --per-bin entries, then we stop adding to it.

Lichess explorer politeness:
  * single-threaded, throttled to --rps requests/second (default ~2.5),
  * every response cached to --cache (keyed by FEN) so reruns are cheap,
  * HTTP 429 honored via Retry-After / exponential backoff,
  * any other error => treated as "unknown" (the candidate is skipped, never a
    crash). The masters endpoint now requires a Lichess API token (Bearer);
    pass it with --token or set LICHESS_TOKEN / it is read from ./.env
    ("lichess: <token>").

Requires: python-chess (SAN parsing + parent FEN), requests, Stockfish (UCI).

Usage:
    python3 scripts/curate_positions.py \
        --pgn data/openings/8moves_v3.pgn \
        --pgn data/openings/UHO_XXL_+1.00_+1.29.pgn \
        --epd data/openings/UHO_4060_v3.epd \
        --epd data/openings/popularpos_lichess_v3.epd \
        --output data/tagged_positions.json \
        --depth 16 --per-bin 40 --max 600
"""

import argparse
import json
import os
import random
import signal
import subprocess
import sys
import time

try:
    import chess
    import chess.pgn
except ImportError:
    sys.exit("python-chess is required: pip3 install python-chess")

try:
    import requests
except ImportError:
    sys.exit("requests is required: pip3 install requests")

MATE_CP = 32000
EXPLORER_URL = "https://explorer.lichess.ovh/masters"


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def parse_args():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--pgn", action="append", default=[],
                   help="PGN source file (gives move history -> parent_games). "
                        "Repeatable. Preferred source.")
    p.add_argument("--epd", action="append", default=[],
                   help="EPD/FEN source file (no history; parent_games=null). "
                        "Repeatable. Used to fill sparse bins.")
    p.add_argument("-o", "--output", default="data/tagged_positions.json")
    p.add_argument("-e", "--engine", default="/opt/homebrew/bin/stockfish")
    p.add_argument("-d", "--depth", type=int, default=16,
                   help="Stockfish search depth (default 16).")
    p.add_argument("--movetime", type=int, default=None,
                   help="Search time per position in ms (overrides --depth).")
    p.add_argument("--threads", type=int, default=2)
    p.add_argument("--hash", type=int, default=256)

    # Imbalance window (White-POV |eval_pawns|).
    p.add_argument("--win-lo", type=float, default=0.2)
    p.add_argument("--win-hi", type=float, default=1.6)

    # Even-coverage binning across [-win-hi, +win-hi].
    p.add_argument("--bin", type=float, default=0.2, help="Bin width (pawns).")
    p.add_argument("--per-bin", type=int, default=40,
                   help="Target positions per eval bin (default 40).")
    p.add_argument("--max", type=int, default=600,
                   help="Hard cap on total curated positions.")

    # Near-theory thresholds.
    p.add_argument("--parent-min", type=int, default=50,
                   help="just_past_book: parent must have >= this many master "
                        "games (default 50).")
    p.add_argument("--self-max-book", type=int, default=20,
                   help="just_past_book: self must have <= this many master "
                        "games (just past book) (default 20).")
    p.add_argument("--self-min", type=int, default=1,
                   help="near_theory: self must have >= this many master games "
                        "(default 1: reached in real master play).")
    p.add_argument("--self-max-near", type=int, default=500,
                   help="near_theory: self must have <= this many master games "
                        "(not absurdly common) (default 500).")

    # Explorer politeness.
    p.add_argument("--rps", type=float, default=2.5,
                   help="Max explorer requests/second (default 2.5).")
    p.add_argument("--cache", default="data/openings/explorer_cache.json")
    p.add_argument("--token", default=None,
                   help="Lichess API token (else LICHESS_TOKEN env or ./.env).")

    # Sampling.
    p.add_argument("--shuffle", action="store_true", default=True,
                   help="Shuffle candidates for opening variety (default on).")
    p.add_argument("--no-shuffle", dest="shuffle", action="store_false")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--max-candidates", type=int, default=40000,
                   help="Cap on candidates pulled into memory per source "
                        "(default 40000).")
    p.add_argument("--max-examined", type=int, default=0,
                   help="Stop after evaluating this many candidates (0 = no "
                        "cap; runs until bins fill or candidates exhaust). "
                        "Useful to bound runtime on sparse bins.")
    return p.parse_args()


# --------------------------------------------------------------------------- #
# Lichess token discovery
# --------------------------------------------------------------------------- #
def discover_token(cli_token):
    if cli_token:
        return cli_token.strip()
    env = os.environ.get("LICHESS_TOKEN")
    if env:
        return env.strip()
    # ./.env  with a line like:  lichess: lip_xxx   or   LICHESS_TOKEN=lip_xxx
    for path in (".env", os.path.join(os.path.dirname(__file__), "..", ".env")):
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    for sep in (":", "="):
                        if sep in line:
                            k, v = line.split(sep, 1)
                            if k.strip().lower() in ("lichess", "lichess_token"):
                                return v.strip().strip('"').strip("'")
        except FileNotFoundError:
            continue
    return None


# --------------------------------------------------------------------------- #
# Candidate extraction
# --------------------------------------------------------------------------- #
def candidates_from_pgn(path, limit):
    """Yield dicts {fen, parent_fen, source, opening_hint} from a PGN file.

    The position taken is the END of the recorded opening line; parent_fen is
    one ply earlier. opening_hint comes from the PGN ECO/Opening tags if any.
    """
    source = os.path.basename(path)
    n = 0
    with open(path, encoding="utf-8", errors="replace") as f:
        while n < limit:
            game = chess.pgn.read_game(f)
            if game is None:
                break
            moves = list(game.mainline_moves())
            if len(moves) < 2:
                continue
            board = game.board()
            parent_fen = None
            for i, mv in enumerate(moves):
                if i == len(moves) - 1:
                    parent_fen = board.fen()  # position before the last move
                board.push(mv)
            fen = board.fen()
            eco = game.headers.get("ECO") or game.headers.get("Eco")
            name = game.headers.get("Opening")
            hint = None
            if name:
                hint = f"{eco} {name}".strip() if eco else name
            elif eco:
                hint = eco
            yield {"fen": fen, "parent_fen": parent_fen,
                   "source": source, "opening_hint": hint}
            n += 1


def looks_like_fen(fields):
    return len(fields) >= 2 and "/" in fields[0] and fields[1] in ("w", "b")


def candidates_from_epd(path, limit):
    """Yield dicts {fen, parent_fen=None, source, opening_hint=None} from EPD."""
    source = os.path.basename(path)
    n = 0
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if n >= limit:
                break
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            fields = line.split()
            if not looks_like_fen(fields):
                continue
            board, stm = fields[0], fields[1]
            cast = fields[2] if len(fields) > 2 else "-"
            ep = fields[3] if len(fields) > 3 else "-"
            half = fields[4] if len(fields) > 4 and fields[4].isdigit() else "0"
            full = fields[5] if len(fields) > 5 and fields[5].isdigit() else "1"
            fen = f"{board} {stm} {cast} {ep} {half} {full}"
            yield {"fen": fen, "parent_fen": None,
                   "source": source, "opening_hint": None}
            n += 1


# --------------------------------------------------------------------------- #
# Stockfish UCI driver (White-POV eval) — same convention as tag_positions.py
# --------------------------------------------------------------------------- #
class Engine:
    def __init__(self, path, threads, hash_mb):
        self.proc = subprocess.Popen(
            [path], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self._send("uci")
        self._wait_for("uciok")
        self._send(f"setoption name Threads value {threads}")
        self._send(f"setoption name Hash value {hash_mb}")
        self._send("isready")
        self._wait_for("readyok")

    def _send(self, cmd):
        self.proc.stdin.write(cmd + "\n")
        self.proc.stdin.flush()

    def _wait_for(self, token):
        for line in self.proc.stdout:
            if line.strip() == token or line.strip().startswith(token):
                return

    def evaluate(self, fen, depth=None, movetime=None):
        stm = fen.split()[1]
        self._send("ucinewgame")
        self._send(f"position fen {fen}")
        if movetime is not None:
            self._send(f"go movetime {movetime}")
        else:
            self._send(f"go depth {depth}")
        last = None
        for line in self.proc.stdout:
            line = line.strip()
            if line.startswith("info ") and " score " in line:
                parsed = self._parse_score(line)
                if parsed is not None:
                    last = parsed
            elif line.startswith("bestmove"):
                break
        if last is None:
            return None
        kind, value = last
        if kind == "cp":
            cp = value
        else:
            cp = MATE_CP - abs(value) if value > 0 else -(MATE_CP - abs(value))
        if stm == "b":
            cp = -cp  # normalize to White POV
        return cp

    @staticmethod
    def _parse_score(info_line):
        toks = info_line.split()
        try:
            idx = toks.index("score")
        except ValueError:
            return None
        return toks[idx + 1], int(toks[idx + 2])

    def quit(self):
        try:
            self._send("quit")
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


# --------------------------------------------------------------------------- #
# Lichess Masters explorer (cached, throttled, backoff)
# --------------------------------------------------------------------------- #
class Explorer:
    def __init__(self, token, cache_path, rps):
        self.cache_path = cache_path
        self.cache = {}
        if cache_path and os.path.isfile(cache_path):
            try:
                self.cache = json.load(open(cache_path, encoding="utf-8"))
            except Exception:
                self.cache = {}
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "chessgui-curate/1.0"})
        if token:
            self.session.headers["Authorization"] = f"Bearer {token}"
        self.min_interval = 1.0 / rps if rps > 0 else 0.0
        self._last = 0.0
        self._dirty = 0
        self.requests_made = 0

    def _throttle(self):
        now = time.time()
        wait = self.min_interval - (now - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.time()

    @staticmethod
    def _as_games(v):
        """Normalize a cache value (legacy int/null or {"g","o"} dict) -> games."""
        if isinstance(v, dict):
            return v.get("g")
        return v  # int or None

    def games_for(self, fen):
        """Return total master games that reached `fen`, or None on error.

        Cached by FEN. None means "unknown" (caller should skip), not 0.
        """
        if fen is None:
            return None
        if fen in self.cache:
            return self._as_games(self.cache[fen])
        games, opening = self._fetch(fen)
        self.cache[fen] = {"g": games, "o": opening}
        self._dirty += 1
        if self._dirty >= 25:
            self.flush()
        return games

    def opening_for(self, fen):
        """Return the explorer opening name for `fen` if known/cached, else None.

        Only reads the cache (populated by games_for); never issues a request.
        """
        v = self.cache.get(fen)
        if isinstance(v, dict):
            return v.get("o")
        return None

    def _fetch(self, fen):
        """Return (games, opening_name). games=None on error/unknown."""
        backoff = 2.0
        for attempt in range(5):
            self._throttle()
            try:
                r = self.session.get(EXPLORER_URL, params={"fen": fen},
                                     timeout=15)
                self.requests_made += 1
            except Exception:
                return None, None  # network error => unknown
            if r.status_code == 200:
                try:
                    d = r.json()
                except Exception:
                    return None, None
                games = int(d.get("white", 0) + d.get("draws", 0)
                            + d.get("black", 0))
                op = d.get("opening") or None
                name = op.get("name") if isinstance(op, dict) else None
                return games, name
            if r.status_code == 429:
                ra = r.headers.get("Retry-After")
                delay = float(ra) if ra and ra.isdigit() else backoff
                time.sleep(delay)
                backoff = min(backoff * 2, 60)
                continue
            if r.status_code in (401, 403):
                # Auth problem is fatal to the whole run; surface it once.
                raise RuntimeError(
                    f"Explorer returned {r.status_code}. A valid Lichess API "
                    f"token is required (--token / LICHESS_TOKEN / .env).")
            # 404 / 5xx etc => unknown, give up on this FEN.
            return None, None
        return None, None  # exhausted retries

    def flush(self):
        if not self.cache_path:
            return
        os.makedirs(os.path.dirname(os.path.abspath(self.cache_path)),
                    exist_ok=True)
        tmp = self.cache_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.cache, f)
        os.replace(tmp, self.cache_path)
        self._dirty = 0


# --------------------------------------------------------------------------- #
# Main curation
# --------------------------------------------------------------------------- #
def bin_index(pawns, lo, width):
    return int((pawns - lo) // width)


def main():
    args = parse_args()

    if not os.path.isfile(args.engine):
        sys.exit(f"Engine not found: {args.engine}")
    for src in args.pgn + args.epd:
        if not os.path.isfile(src):
            sys.exit(f"Source not found: {src}")
    if not args.pgn and not args.epd:
        sys.exit("Provide at least one --pgn or --epd source.")

    token = discover_token(args.token)
    if not token:
        print("WARNING: no Lichess token found; the masters explorer now "
              "requires one and will likely 401.", file=sys.stderr)

    rng = random.Random(args.seed)

    # --- Gather candidates (PGN preferred, then EPD to fill volume) ---
    print("Gathering candidates...")
    candidates = []
    for path in args.pgn:
        c = list(candidates_from_pgn(path, args.max_candidates))
        print(f"  PGN {os.path.basename(path)}: {len(c)} candidates "
              f"(with parent history)")
        candidates.extend(c)
    pgn_count = len(candidates)
    for path in args.epd:
        c = list(candidates_from_epd(path, args.max_candidates))
        print(f"  EPD {os.path.basename(path)}: {len(c)} candidates")
        candidates.extend(c)
    print(f"  total: {len(candidates)} ({pgn_count} from PGN with parents)")

    if args.shuffle:
        # Keep PGN candidates first (preferred) but shuffle within each group.
        pgn_c = candidates[:pgn_count]
        epd_c = candidates[pgn_count:]
        rng.shuffle(pgn_c)
        rng.shuffle(epd_c)
        candidates = pgn_c + epd_c

    # Dedup by FEN, preferring the first (PGN) occurrence.
    seen = set()
    deduped = []
    for c in candidates:
        if c["fen"] in seen:
            continue
        seen.add(c["fen"])
        deduped.append(c)
    candidates = deduped
    print(f"  {len(candidates)} unique FENs after dedup")

    # --- Binning setup across [-win-hi, +win-hi] ---
    lo, hi = -args.win_hi, args.win_hi
    nbins = int(round((hi - lo) / args.bin))
    bins = [[] for _ in range(nbins)]

    def bin_full(idx):
        return len(bins[idx]) >= args.per_bin

    def all_full():
        return all(len(b) >= args.per_bin for b in bins) \
            or sum(len(b) for b in bins) >= args.max

    engine = Engine(args.engine, args.threads, args.hash)
    explorer = Explorer(token, args.cache, args.rps)

    # Graceful stop: on Ctrl-C / SIGTERM, finish the current iteration and let
    # the `finally` block write whatever has been collected so far.
    stop = {"flag": False}

    def _request_stop(signum, frame):
        stop["flag"] = True
        print(f"\nSignal {signum} received — finishing up and writing partial "
              f"results...", file=sys.stderr)
    signal.signal(signal.SIGINT, _request_stop)
    signal.signal(signal.SIGTERM, _request_stop)

    kept = 0
    examined = 0
    skip_window = skip_junk = skip_binfull = 0
    start = time.time()
    try:
        for c in candidates:
            if all_full() or stop["flag"]:
                break
            if args.max_examined and examined >= args.max_examined:
                print(f"  reached --max-examined {args.max_examined}; stopping.")
                break
            examined += 1

            cp = engine.evaluate(c["fen"], depth=args.depth,
                                 movetime=args.movetime)
            if cp is None:
                continue
            pawns = round(cp / 100.0, 2)
            mag = abs(pawns)

            # 1) imbalance window
            if mag < args.win_lo or mag > args.win_hi:
                skip_window += 1
                continue
            # bin gate — don't even query the explorer if the bin is already full
            if pawns < lo or pawns >= hi:
                skip_window += 1
                continue
            idx = bin_index(pawns, lo, args.bin)
            if idx < 0 or idx >= nbins or bin_full(idx):
                skip_binfull += 1
                continue

            # 2) explorer: self + (PGN only) parent
            self_games = explorer.games_for(c["fen"])
            if self_games is None:
                # Unknown self => can't validate as real chess; skip.
                skip_junk += 1
                continue
            parent_games = None
            if c["parent_fen"] is not None:
                parent_games = explorer.games_for(c["parent_fen"])

            # 3) near-theory filter + quality tag
            quality = None
            if (parent_games is not None
                    and parent_games >= args.parent_min
                    and self_games <= args.self_max_book
                    and self_games >= 1):
                quality = "just_past_book"
            elif (args.self_min <= self_games <= args.self_max_near):
                quality = "near_theory"
            else:
                skip_junk += 1
                continue

            # opening name from explorer (richer than PGN hint) if available
            opening = explorer.opening_for(c["fen"]) or c.get("opening_hint")
            entry = {
                "fen": c["fen"],
                "eval_cp": int(cp),
                "eval_pawns": pawns,
                "source": c["source"],
                "self_games": int(self_games),
                "parent_games": (int(parent_games)
                                 if parent_games is not None else None),
                "quality": quality,
                "opening": opening,
            }
            bins[idx].append(entry)
            kept += 1

            if kept % 25 == 0:
                el = time.time() - start
                filled = sum(1 for b in bins if len(b) >= args.per_bin)
                print(f"  kept {kept} | examined {examined} | "
                      f"bins full {filled}/{nbins} | "
                      f"explorer reqs {explorer.requests_made} | {el:.0f}s")
    except RuntimeError as e:
        print(f"\nFATAL: {e}", file=sys.stderr)
    finally:
        engine.quit()
        explorer.flush()

    results = [e for b in bins for e in b]
    results.sort(key=lambda d: d["eval_pawns"])

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)

    el = time.time() - start
    print(f"\nDone: {len(results)} curated positions -> {args.output} "
          f"in {el:.0f}s")
    print(f"  examined {examined} | skipped: window {skip_window}, "
          f"junk/unknown {skip_junk}, bin-full {skip_binfull}")
    print(f"  explorer requests: {explorer.requests_made} "
          f"(cache {len(explorer.cache)} FENs)")
    _print_summary(results, args)


def _print_summary(results, args):
    if not results:
        print("  (no results)")
        return
    # 0.5-pawn histogram
    print("\nEval histogram (0.5-pawn bins, White POV):")
    edges = [x / 10 for x in range(-20, 21, 5)]
    for i in range(len(edges) - 1):
        a, b = edges[i], edges[i + 1]
        n = sum(1 for d in results if a <= d["eval_pawns"] < b)
        print(f"  [{a:+.1f}, {b:+.1f}): {n:3d}  {'#' * n}")
    # quality
    from collections import Counter
    q = Counter(d["quality"] for d in results)
    print("\nBy quality:", dict(q))
    # game stats
    sg = sorted(d["self_games"] for d in results)
    pg = sorted(d["parent_games"] for d in results
                if d["parent_games"] is not None)

    def med(x):
        return x[len(x) // 2] if x else None
    print(f"self_games:   min {sg[0]}  median {med(sg)}  max {sg[-1]}  "
          f"(n={len(sg)})")
    if pg:
        print(f"parent_games: min {pg[0]}  median {med(pg)}  max {pg[-1]}  "
              f"(n={len(pg)}, {len(results) - len(pg)} null)")
    else:
        print(f"parent_games: all null (n={len(results)})")


if __name__ == "__main__":
    main()

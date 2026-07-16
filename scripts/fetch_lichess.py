#!/usr/bin/env python3
"""Fetch a lichess player's public game history as one PGN file.

Uses the public export API (lichess.org/api/games/user/{username}) — one
streaming request, PGN out, no auth needed. The lichess counterpart of
fetch_chesscom.py, built for the any-player profile pipeline (spec 225):
build_player_profile.py invokes this for the `--lichess` source.

Usage:
    python3 scripts/fetch_lichess.py <username> [-o out.pgn]
                                     [--since YYYY-MM] [--time-class rapid,blitz]
                                     [--max N]

Etiquette per lichess API docs: a single streaming request (never parallel),
identifying User-Agent, and on HTTP 429 wait a full minute before retrying.
"""
import argparse
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://lichess.org/api/games/user/{u}"
UA = {"User-Agent": "chessgui-rival-mode/1.0 (github.com/hthor213/chessgui)",
      "Accept": "application/x-chess-pgn"}

# --time-class values (chess.com vocabulary, shared with fetch_chesscom.py)
# mapped to lichess perfType names.
PERF_MAP = {
    "bullet": "bullet",
    "blitz": "blitz",
    "rapid": "rapid",
    "daily": "correspondence",
    "classical": "classical",
    "correspondence": "correspondence",
}


def since_millis(ym: str) -> int:
    """'YYYY-MM' -> epoch milliseconds at the start of that month (UTC)."""
    import calendar
    year, month = (int(x) for x in ym.split("-"))
    return calendar.timegm((year, month, 1, 0, 0, 0)) * 1000


def fetch(username: str, out_path: str, since: str | None = None,
          time_classes: str | None = None, max_games: int | None = None) -> int:
    """Stream the player's games to out_path; returns the game count."""
    params: dict[str, str] = {"moves": "true", "tags": "true",
                              "clocks": "false", "evals": "false"}
    if since:
        params["since"] = str(since_millis(since))
    if time_classes:
        perfs = sorted({PERF_MAP.get(tc.strip(), tc.strip())
                        for tc in time_classes.split(",") if tc.strip()})
        params["perfType"] = ",".join(perfs)
    if max_games:
        params["max"] = str(max_games)

    url = API.format(u=urllib.parse.quote(username.strip())) + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=UA)

    for attempt in (1, 2):
        try:
            resp = urllib.request.urlopen(req, timeout=60)
            break
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt == 1:
                print("rate limited (429) — waiting 60s per lichess etiquette", file=sys.stderr)
                time.sleep(60)
                continue
            raise

    with resp, open(out_path, "wb") as out:
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            out.write(chunk)
    # Count after the stream closes — "[Event " could straddle a chunk boundary.
    with open(out_path, encoding="utf-8", errors="replace") as fh:
        return sum(1 for line in fh if line.startswith("[Event "))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("username")
    ap.add_argument("-o", "--output", default=None, help="output PGN (default <username>.pgn)")
    ap.add_argument("--since", default=None, help="earliest month, YYYY-MM")
    ap.add_argument("--time-class", default=None,
                    help="comma list to keep (rapid,blitz,bullet,classical,daily); default all")
    ap.add_argument("--max", type=int, default=None, help="cap on number of games")
    args = ap.parse_args()

    user = args.username.strip()
    out_path = args.output or f"{user.lower()}.pgn"
    n = fetch(user, out_path, since=args.since, time_classes=args.time_class,
              max_games=args.max)
    print(f"\nWrote {n} games -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

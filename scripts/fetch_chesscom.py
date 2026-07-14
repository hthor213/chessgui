#!/usr/bin/env python3
"""Fetch a chess.com player's complete public game history as one PGN file.

Uses the public API (api.chess.com/pub) — monthly archives, no auth needed.
Built for rival mode (BACKLOG.md): pull the rival's games, import the PGN via
Database → Import, and the Opening Explorer filtered to their name becomes
their book, rendered.

Usage:
    python3 scripts/fetch_chesscom.py <username> [-o out.pgn]
                                      [--since YYYY-MM] [--time-class rapid,blitz,daily]

Etiquette per chess.com API docs: serial requests, identifying User-Agent.
"""
import argparse
import json
import sys
import time
import urllib.request

API = "https://api.chess.com/pub/player/{u}/games/archives"
UA = {"User-Agent": "chessgui-rival-mode/1.0 (github.com/hthor213/chessgui)"}


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("username")
    ap.add_argument("-o", "--output", default=None, help="output PGN (default <username>.pgn)")
    ap.add_argument("--since", default=None, help="earliest month, YYYY-MM")
    ap.add_argument("--time-class", default=None,
                    help="comma list to keep (rapid,blitz,bullet,daily); default all")
    args = ap.parse_args()

    user = args.username.strip().lower()
    out_path = args.output or f"{user}.pgn"
    keep = set(args.time_class.split(",")) if args.time_class else None

    archives = json.loads(get(API.format(u=user)))["archives"]
    if args.since:
        floor = args.since.replace("-", "/")
        archives = [a for a in archives if a.rsplit("/", 2)[-2] + "/" + a.rsplit("/", 1)[-1] >= floor]
    print(f"{user}: {len(archives)} monthly archives")

    n_games = 0
    with open(out_path, "w", encoding="utf-8") as out:
        for i, url in enumerate(archives):
            month = "/".join(url.rsplit("/", 2)[-2:])
            data = json.loads(get(url))
            games = data.get("games", [])
            kept = 0
            for g in games:
                if keep and g.get("time_class") not in keep:
                    continue
                pgn = g.get("pgn")
                if not pgn:
                    continue  # some variants carry no PGN
                out.write(pgn.rstrip() + "\n\n")
                kept += 1
            n_games += kept
            print(f"  {month}: {kept}/{len(games)} games  (total {n_games})")
            time.sleep(0.5)  # serial + polite

    print(f"\nWrote {n_games} games -> {out_path}")
    print("Import via ChessGUI: Database tab -> Import… -> select the PGN.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

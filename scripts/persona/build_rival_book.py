#!/usr/bin/env python3
"""Build a rival's opening book from their real chess.com PGNs (spec 214, Tier 0).

The rival here is dad, whose games live under two chess.com accounts in
data/rivals/ (thjaltason, thorsenior2). For each game we find which colour the
rival played (by matching the account username to the White/Black header) and
walk the opening: after each of the rival's own moves, up to ply 8, we record
the resulting position. Identical positions are merged and weighted by how many
games reached them, so a weighted sample from the book reproduces the rival's
real opening choices.

The resulting position has the *opponent* to move (the rival just moved), so a
sparring session starts the user on move against one of dad's real lines, with
the user playing the opposite colour.

Only standard games count: Chess960 and any position-setup games are excluded
(the opening tree is meaningless off the standard start). data/rivals/ is
gitignored — dad's games stay local (spec 214 hard rule), and so does the book.

Usage:
    build_rival_book.py                      # default: build data/rivals/dad_book.json
    build_rival_book.py --out PATH SRC...     # SRC = username:path pairs
    build_rival_book.py --self-test           # run the built-in checks, no I/O
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from io import StringIO
from pathlib import Path

import chess
import chess.pgn

# Dad's opening depth is shallow (~3 plies per the dossier); 8 plies of book is
# a generous cap that still stays inside genuine opening theory. GM personas use
# --max-ply 24 (real theory depth, matching exhibition_v2's BOOK_MAX_PLY).
MAX_PLY = 8

REPO_ROOT = Path(__file__).resolve().parents[2]
RIVALS_DIR = REPO_ROOT / "data" / "rivals"

# Default sources: (chess.com username, PGN path). Both are dad's accounts.
DEFAULT_SOURCES = [
    ("thjaltason", RIVALS_DIR / "thjaltason.pgn"),
    ("thorsenior2", RIVALS_DIR / "Thorsenior2.pgn"),
]
DEFAULT_OUT = RIVALS_DIR / "dad_book.json"


@dataclass
class Entry:
    fen: str
    line: str  # SAN with move numbers, e.g. "1.d4 d5 2.Nc3"
    ply: int
    rival_color: str  # "white" | "black" — the colour dad played this game
    weight: int = 0


@dataclass
class BuildStats:
    games: int = 0
    used: int = 0
    skipped_non_standard: int = 0
    skipped_rival_absent: int = 0
    sources: list = field(default_factory=list)


def is_standard_start(game: chess.pgn.Game) -> bool:
    """True only for games that begin from the standard start position. Excludes
    Chess960 (random back rank) and any [SetUp]/[FEN] position-setup game."""
    variant = game.headers.get("Variant", "").strip().lower()
    if variant and variant not in ("standard", "chess", "normal"):
        return False
    fen = game.headers.get("FEN")
    if game.headers.get("SetUp") == "1" or fen:
        if fen:
            try:
                board = chess.Board(fen)
            except ValueError:
                return False
            if board.board_fen() != chess.STARTING_BOARD_FEN:
                return False
    return True


def rival_color(game: chess.pgn.Game, username: str) -> str | None:
    """Which colour the rival played, matching the account username to the
    White/Black headers (case-insensitive). None if the rival is not a player."""
    u = username.strip().lower()
    if game.headers.get("White", "").strip().lower() == u:
        return "white"
    if game.headers.get("Black", "").strip().lower() == u:
        return "black"
    return None


def _san_with_number(ply: int, san: str) -> str:
    """Ply index (0-based) + SAN -> numbered token: white moves get "N.san",
    black moves get the bare san (they follow the white token on the same move)."""
    if ply % 2 == 0:
        return f"{ply // 2 + 1}.{san}"
    return san


def harvest_game(
    game: chess.pgn.Game, color: str, entries: "OrderedDict[tuple[str, str], Entry]",
    max_ply: int = MAX_PLY,
) -> bool:
    """Walk a game's opening and record positions after each of the rival's moves
    (up to max_ply). Returns True if the game contributed at least one position."""
    board = game.board()
    tokens: list[str] = []
    contributed = False
    rival_turn_white = color == "white"
    for ply, move in enumerate(game.mainline_moves()):
        if ply >= max_ply:
            break
        # Whose move is this? White to move on even ply indices.
        mover_is_white = board.turn == chess.WHITE
        try:
            san = board.san(move)
        except (ValueError, AssertionError):
            break  # corrupt PGN move — stop this game's opening here
        tokens.append(_san_with_number(ply, san))
        board.push(move)
        if mover_is_white == rival_turn_white:
            # The rival just moved: record the resulting position (opponent to move).
            fen = board.fen()
            key = (fen, color)
            entry = entries.get(key)
            if entry is None:
                entry = Entry(fen=fen, line=" ".join(tokens), ply=ply + 1, rival_color=color)
                entries[key] = entry
            entry.weight += 1
            contributed = True
    return contributed


def build(sources: list[tuple[str, Path]],
          max_ply: int = MAX_PLY) -> tuple[list[Entry], BuildStats]:
    entries: "OrderedDict[tuple[str, str], Entry]" = OrderedDict()
    stats = BuildStats()
    for username, path in sources:
        src_games = 0
        with open(path, encoding="utf-8", errors="replace") as fh:
            while True:
                game = chess.pgn.read_game(fh)
                if game is None:
                    break
                stats.games += 1
                src_games += 1
                if not is_standard_start(game):
                    stats.skipped_non_standard += 1
                    continue
                color = rival_color(game, username)
                if color is None:
                    stats.skipped_rival_absent += 1
                    continue
                if harvest_game(game, color, entries, max_ply):
                    stats.used += 1
        stats.sources.append({"username": username, "path": str(path), "games": src_games})
    # Most-played lines first — the frontend samples by weight, but a sorted book
    # is easier to eyeball.
    ordered = sorted(entries.values(), key=lambda e: (-e.weight, e.ply, e.line))
    return ordered, stats


def to_document(entries: list[Entry], stats: BuildStats,
                rival: str = "dad", max_ply: int = MAX_PLY) -> dict:
    white = sum(1 for e in entries if e.rival_color == "white")
    black = len(entries) - white
    return {
        "version": 1,
        "generated_at": int(time.time()),
        "max_ply": max_ply,
        "rival": rival,
        "sources": stats.sources,
        "stats": {
            "games_seen": stats.games,
            "games_used": stats.used,
            "skipped_non_standard": stats.skipped_non_standard,
            "skipped_rival_absent": stats.skipped_rival_absent,
            "positions": len(entries),
            "white_positions": white,
            "black_positions": black,
        },
        "entries": [
            {
                "fen": e.fen,
                "line": e.line,
                "ply": e.ply,
                "rival_color": e.rival_color,
                "weight": e.weight,
            }
            for e in entries
        ],
    }


# ---------------------------------------------------------------------------
# Self-test — exercises exclusion, weighting, and the depth cap without touching
# the real (private) PGNs. Run with --self-test; exits non-zero on failure.
# ---------------------------------------------------------------------------

_STD_PGN = """[Event "Std"]
[White "dad"]
[Black "opp"]
[Result "1-0"]

1. d4 d5 2. Nc3 e6 3. Nf3 Nf6 4. e3 Be7 5. Bd3 O-O 6. O-O c5 1-0
"""

# Same opening reached in a second game -> shared positions gain weight.
_STD_PGN_2 = """[Event "Std"]
[White "dad"]
[Black "opp2"]
[Result "0-1"]

1. d4 d5 2. Nc3 c6 0-1
"""

# Dad as Black.
_STD_PGN_BLACK = """[Event "Std"]
[White "opp"]
[Black "dad"]
[Result "0-1"]

1. e4 c5 2. Nf3 d6 0-1
"""

_960_PGN = """[Event "960"]
[Variant "Chess960"]
[SetUp "1"]
[FEN "nrbqkbrn/pppppppp/8/8/8/8/PPPPPPPP/NRBQKBRN w KQkq - 0 1"]
[White "dad"]
[Black "opp"]
[Result "1-0"]

1. g3 g6 2. Bg2 Bg7 1-0
"""


def _read_all(pgn_text: str, username: str) -> list[tuple[str, chess.pgn.Game]]:
    out = []
    fh = StringIO(pgn_text)
    while True:
        g = chess.pgn.read_game(fh)
        if g is None:
            break
        out.append((username, g))
    return out


def self_test() -> int:
    entries: "OrderedDict[tuple[str, str], Entry]" = OrderedDict()
    stats = BuildStats()

    # Feed a mix through the real code path (harvest + exclusion).
    cases = (
        (_STD_PGN, "dad"),
        (_STD_PGN_2, "dad"),
        (_STD_PGN_BLACK, "dad"),
        (_960_PGN, "dad"),
    )
    for text, user in cases:
        for username, game in _read_all(text, user):
            stats.games += 1
            if not is_standard_start(game):
                stats.skipped_non_standard += 1
                continue
            color = rival_color(game, username)
            if color is None:
                stats.skipped_rival_absent += 1
                continue
            harvest_game(game, color, entries)

    ok = True

    def check(cond: bool, msg: str):
        nonlocal ok
        status = "PASS" if cond else "FAIL"
        print(f"  [{status}] {msg}")
        if not cond:
            ok = False

    # 1. Chess960 excluded.
    check(stats.skipped_non_standard == 1, "one Chess960 game excluded")
    # No entry may carry the 960 back-rank signature (nrbqkbrn).
    check(all("nrbqkbrn" not in e.fen for e in entries.values()), "no 960 positions leaked in")

    # 2. Depth cap: every recorded position is within MAX_PLY.
    check(all(e.ply <= MAX_PLY for e in entries.values()), f"all plies <= {MAX_PLY}")

    # 3. Weights: the shared 1.d4 d5 white line (after 1.d4) appears in both
    #    _STD_PGN and _STD_PGN_2, so the position after 1.d4 has weight 2.
    after_d4 = chess.Board()
    after_d4.push_san("d4")
    e = entries.get((after_d4.fen(), "white"))
    check(e is not None and e.weight == 2, "position after 1.d4 (dad=white) has weight 2")

    # 4. rival_color / to-move: after a dad(white) move it is Black to move.
    whites = [e for e in entries.values() if e.rival_color == "white"]
    check(bool(whites) and all(" b " in e.fen for e in whites),
          "dad-white entries all have opponent (Black) to move")
    # Dad-as-black line contributed too, with White to move after dad's reply.
    blacks = [e for e in entries.values() if e.rival_color == "black"]
    check(bool(blacks) and all(" w " in e.fen for e in blacks),
          "dad-black entries all have opponent (White) to move")

    # 5. Weight-sum sanity: total weight == number of rival moves recorded across
    #    the three standard games (dad-white game 1: 3 moves within ply 8 pairs;
    #    game 2: 1; dad-black: 2). White moves at plies 0..7 -> dad white plays at
    #    plies 0,2,4,6 (4 moves) in game1 (d4,Nc3,Nf3,e3,... up to ply8 => 4),
    #    game2 has 1 dad move recorded (d4 only, then c6 is opp). Just assert > 0
    #    and equals the sum of per-entry weights.
    total = sum(e.weight for e in entries.values())
    check(total > 0, f"recorded {total} weighted rival positions")

    print(f"\n  stats: {stats.games} games, {stats.skipped_non_standard} non-standard, "
          f"{len(entries)} unique positions, total weight {total}")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Build a rival opening book from PGNs.")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output JSON path")
    ap.add_argument("--max-ply", type=int, default=MAX_PLY,
                    help=f"book depth in plies (default {MAX_PLY}; GM personas use 24)")
    ap.add_argument("--rival", default="dad",
                    help="label stored in the book's `rival` field")
    ap.add_argument("--self-test", action="store_true", help="run built-in checks and exit")
    ap.add_argument(
        "sources",
        nargs="*",
        help="username:path pairs (default: dad's two chess.com accounts)",
    )
    args = ap.parse_args()

    if args.self_test:
        print("build_rival_book self-test:")
        return self_test()

    if args.sources:
        sources = []
        for spec in args.sources:
            if ":" not in spec:
                ap.error(f"source must be username:path, got {spec!r}")
            user, _, p = spec.partition(":")
            sources.append((user, Path(p)))
    else:
        sources = DEFAULT_SOURCES

    missing = [str(p) for _, p in sources if not Path(p).exists()]
    if missing:
        print(f"error: source PGN(s) not found: {', '.join(missing)}", file=sys.stderr)
        return 1

    entries, stats = build(sources, max_ply=args.max_ply)
    doc = to_document(entries, stats, rival=args.rival, max_ply=args.max_ply)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, indent=1), encoding="utf-8")

    print(f"wrote {args.out}")
    print(f"  {stats.used}/{stats.games} games used "
          f"({stats.skipped_non_standard} non-standard, {stats.skipped_rival_absent} rival absent)")
    print(f"  {doc['stats']['positions']} unique positions "
          f"({doc['stats']['white_positions']} white, {doc['stats']['black_positions']} black)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Export arena games from the arena SQLite DB into a rival opening book
(spec 217 Tier 2, data flywheel step 1).

Reads the server/arena/app/db.py schema (games + moves + users) and emits a
book.json in the build_rival_book.py format — the exact shape merge_books.py
already accepts as its 'arena' source (see the manifest example in that
script's docstring). The rival is the arena PLAYER (mover='player'): dad's
arena games against fixed-strength personas are strictly better rival-model
data than his chess.com archives (spec 217 "Data flywheel").

Per game we replay the stored UCI moves from the standard start (the arena
has no variant/setup games) and, after each of the player's own moves up to
--max-ply, record the resulting position — identical harvest semantics to
build_rival_book.harvest_game, so the two sources merge on the same
(fen, rival_color) identity. SAN in the line is recomputed from UCI during
replay (the DB's san column is display data, not the source of truth). A game
whose stored moves do not replay legally is skipped whole and counted — a
corrupt game must never contribute positions.

Only finished games count by default (an abandoned 2-ply game is noise;
--include-active overrides for mid-batch peeks). --user filters to one
account's games — the arena DB may hold several family members.

The output lands in data/rivals/ (gitignored — arena games are private,
same hard rule as spec 214).

Usage:
    export_arena_book.py DB [--out PATH] [--user EMAIL] [--rival LABEL]
                            [--max-ply N] [--include-active]
    export_arena_book.py --self-test
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import OrderedDict
from pathlib import Path

import chess

from build_rival_book import (
    MAX_PLY, RIVALS_DIR, BuildStats, Entry, _san_with_number, to_document,
)

DEFAULT_OUT = RIVALS_DIR / "dad_arena_book.json"


def load_games(conn: sqlite3.Connection, user_email: str | None,
               include_active: bool) -> list[dict]:
    """Games joined with their mover emails, oldest first (stable output)."""
    q = ("SELECT g.*, u.email AS email FROM games g "
         "JOIN users u ON u.id = g.user_id")
    conds, args = [], []
    if not include_active:
        conds.append("g.status = 'finished'")
    if user_email:
        conds.append("u.email = ?")
        args.append(user_email.lower())
    if conds:
        q += " WHERE " + " AND ".join(conds)
    q += " ORDER BY g.id"
    conn.row_factory = sqlite3.Row
    return [dict(r) for r in conn.execute(q, args).fetchall()]


def load_moves(conn: sqlite3.Connection, game_id: int) -> list[dict]:
    return [dict(r) for r in conn.execute(
        "SELECT ply, uci, mover FROM moves WHERE game_id=? ORDER BY ply",
        (game_id,)).fetchall()]


def harvest_arena_game(
    moves: list[dict], color: str,
    entries: "OrderedDict[tuple[str, str], Entry]", max_ply: int = MAX_PLY,
) -> bool:
    """Replay stored UCI moves and record positions after each player move,
    build_rival_book.harvest_game semantics. Raises ValueError on an illegal
    or gap-toothed move sequence (caller skips the game). Atomic per game:
    `entries` is only touched after the whole replay validates — a game that
    corrupts at ply 9 must not leave its ply-1 position in the book."""
    board = chess.Board()
    tokens: list[str] = []
    harvested: list[tuple[str, str, int]] = []  # (fen, line, ply)
    rival_turn_white = color == "white"
    for i, m in enumerate(moves):
        if m["ply"] != i:
            raise ValueError(f"ply gap: expected {i}, got {m['ply']}")
        if i >= max_ply:
            break
        mover_is_white = board.turn == chess.WHITE
        move = chess.Move.from_uci(m["uci"])  # ValueError on garbage
        if move not in board.legal_moves:
            raise ValueError(f"illegal move {m['uci']} at ply {i}")
        san = board.san(move)
        tokens.append(_san_with_number(i, san))
        board.push(move)
        if mover_is_white == rival_turn_white:
            # Cross-check the DB's mover column against board parity — a
            # mismatch means the game rows are inconsistent, skip it whole.
            if m["mover"] != "player":
                raise ValueError(f"mover mismatch at ply {i}: {m['mover']}")
            harvested.append((board.fen(), " ".join(tokens), i + 1))
    for fen, line, ply in harvested:
        key = (fen, color)
        entry = entries.get(key)
        if entry is None:
            entry = Entry(fen=fen, line=line, ply=ply, rival_color=color)
            entries[key] = entry
        entry.weight += 1
    return bool(harvested)


def build_from_db(db_path: Path, user_email: str | None = None,
                  include_active: bool = False,
                  max_ply: int = MAX_PLY) -> tuple[list[Entry], BuildStats]:
    conn = sqlite3.connect(db_path)
    try:
        games = load_games(conn, user_email, include_active)
        entries: "OrderedDict[tuple[str, str], Entry]" = OrderedDict()
        stats = BuildStats()
        skipped_corrupt = 0
        for g in games:
            stats.games += 1
            try:
                if harvest_arena_game(load_moves(conn, g["id"]),
                                      g["player_color"], entries, max_ply):
                    stats.used += 1
            except ValueError as exc:
                skipped_corrupt += 1
                print(f"  skipping game {g['id']}: {exc}", file=sys.stderr)
        # Reuse the build_rival_book stats/document shape; corrupt games ride
        # in skipped_non_standard (the "excluded, would corrupt the book"
        # bucket) so downstream readers need no new field.
        stats.skipped_non_standard = skipped_corrupt
        stats.sources.append({
            "arena_db": str(db_path),
            "user": user_email or "all",
            "games": len(games),
            "include_active": include_active,
        })
        ordered = sorted(entries.values(),
                         key=lambda e: (-e.weight, e.ply, e.line))
        return ordered, stats
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Self-test — builds a throwaway fixture DB with the real arena schema
# (imported from server/arena/app/db.py, so schema drift fails here first).
# ---------------------------------------------------------------------------

def _fixture_db(path: Path) -> None:
    repo = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(repo / "server" / "arena"))
    from app.db import SCHEMA  # the real schema, not a copy
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)

    def add_game(gid, email, color, status, moves, mover_override=None):
        conn.execute("INSERT OR IGNORE INTO users (email) VALUES (?)", (email,))
        uid = conn.execute("SELECT id FROM users WHERE email=?",
                           (email,)).fetchone()[0]
        conn.execute(
            "INSERT INTO games (id, user_id, persona, player_color, seed, "
            "status, result) VALUES (?,?,?,?,?,?,?)",
            (gid, uid, "gudmundur-peak", color, 1, status,
             "1-0" if status == "finished" else None))
        board = chess.Board()
        player_is_white = color == "white"
        for ply, san in enumerate(moves):
            move = board.parse_san(san)
            mover = ("player" if (board.turn == chess.WHITE) == player_is_white
                     else "persona")
            uci = move.uci()
            if mover_override and ply in mover_override:
                mover = mover_override[ply]
            conn.execute(
                "INSERT INTO moves (game_id, ply, uci, san, mover) "
                "VALUES (?,?,?,?,?)", (gid, ply, uci, san, mover))
            board.push(move)

    # Two finished dad-white games sharing 1.d4 (weight 2 on that node),
    # one finished dad-black game, one ACTIVE game (excluded by default),
    # one other-user game (excluded by --user), one corrupt game.
    add_game(1, "dad@example.com", "white", "finished",
             ["d4", "d5", "Nc3", "e6", "Nf3", "Nf6", "e3", "Be7", "Bd3"])
    add_game(2, "dad@example.com", "white", "finished", ["d4", "d5", "Nf3"])
    add_game(3, "dad@example.com", "black", "finished",
             ["e4", "c5", "Nf3", "d6"])
    add_game(4, "dad@example.com", "white", "active", ["e4", "e5"])
    add_game(5, "other@example.com", "white", "finished", ["c4", "e5"])
    add_game(6, "dad@example.com", "white", "finished", ["d4", "d5", "Nc3"],
             mover_override={2: "persona"})  # inconsistent mover column
    conn.commit()
    conn.close()


def self_test() -> int:
    import tempfile
    ok = True

    def check(cond: bool, msg: str):
        nonlocal ok
        print(f"  [{'PASS' if cond else 'FAIL'}] {msg}")
        if not cond:
            ok = False

    with tempfile.TemporaryDirectory() as td:
        db = Path(td) / "arena.sqlite"
        _fixture_db(db)

        entries, stats = build_from_db(db, user_email="dad@example.com")
        by_key = {(e.fen, e.rival_color): e for e in entries}

        # 1. Finished dad games only: 4 seen (3 clean + 1 corrupt), 3 used.
        check(stats.games == 4 and stats.used == 3,
              f"3 of 4 finished dad games used (got {stats.used}/{stats.games})")
        check(stats.skipped_non_standard == 1, "corrupt game skipped whole")

        # 2. Shared 1.d4 node weighted by both white games.
        after_d4 = chess.Board()
        after_d4.push_san("d4")
        e = by_key.get((after_d4.fen(), "white"))
        check(e is not None and e.weight == 2 and e.line == "1.d4",
              "position after 1.d4 (dad=white) has weight 2")

        # 3. Depth cap + to-move parity (opponent to move after a rival move).
        check(all(e.ply <= MAX_PLY for e in entries), f"all plies <= {MAX_PLY}")
        check(all(" b " in e.fen for e in entries if e.rival_color == "white"),
              "dad-white entries have Black to move")
        check(all(" w " in e.fen for e in entries if e.rival_color == "black"),
              "dad-black entries have White to move")

        # 4. Corrupt game contributed nothing: its 3rd move (Nc3, mover
        #    mislabeled) must not appear, and neither may its earlier plies.
        nc3 = chess.Board()
        for san in ("d4", "d5", "Nc3"):
            nc3.push_san(san)
        e = by_key.get((nc3.fen(), "white"))
        check(e is None or e.weight == 1,
              "corrupt game's positions excluded (only game 1 reaches 2.Nc3)")

        # 5. --include-active pulls in the active game; no user filter pulls
        #    in the other account.
        entries_a, stats_a = build_from_db(db, user_email="dad@example.com",
                                           include_active=True)
        check(stats_a.games == 5 and stats_a.used == 4,
              "active game included with --include-active")
        _, stats_all = build_from_db(db)
        check(stats_all.games == 5, "no --user filter sees all users' games")

        # 6. Output document is a merge_books-consumable book.json.
        doc = to_document(entries, stats, rival="dad")
        check(doc["version"] == 1 and doc["stats"]["positions"] == len(entries),
              "document has build_rival_book shape")
        check(all(set(e) >= {"fen", "line", "ply", "rival_color", "weight"}
                  for e in doc["entries"]), "entries carry the merge identity")
        total = sum(e["weight"] for e in doc["entries"])
        check(total > 0, f"total weight {total} > 0")

    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Export arena games into a rival opening book.")
    ap.add_argument("db", nargs="?", type=Path, help="arena SQLite DB path")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT,
                    help=f"output JSON path (default {DEFAULT_OUT})")
    ap.add_argument("--user", help="only this account's games (email)")
    ap.add_argument("--rival", default="dad",
                    help="label stored in the book's `rival` field")
    ap.add_argument("--max-ply", type=int, default=MAX_PLY,
                    help=f"book depth in plies (default {MAX_PLY})")
    ap.add_argument("--include-active", action="store_true",
                    help="also harvest unfinished games")
    ap.add_argument("--self-test", action="store_true",
                    help="run built-in checks against a fixture DB and exit")
    args = ap.parse_args()

    if args.self_test:
        print("export_arena_book self-test:")
        return self_test()
    if not args.db:
        ap.error("db path required (or --self-test)")
    if not args.db.exists():
        print(f"error: arena DB not found: {args.db}", file=sys.stderr)
        return 1

    entries, stats = build_from_db(args.db, user_email=args.user,
                                   include_active=args.include_active,
                                   max_ply=args.max_ply)
    doc = to_document(entries, stats, rival=args.rival, max_ply=args.max_ply)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, indent=1), encoding="utf-8")

    print(f"wrote {args.out}")
    print(f"  {stats.used}/{stats.games} games used "
          f"({stats.skipped_non_standard} corrupt/skipped)")
    print(f"  {doc['stats']['positions']} unique positions "
          f"({doc['stats']['white_positions']} white, "
          f"{doc['stats']['black_positions']} black)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

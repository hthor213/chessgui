#!/usr/bin/env python3
"""import_puzzles.py — load mine_cliffs.py JSONL into a SQLite `puzzles` table.

Spec 211:66-68 names the table and columns ("fen, trap_uci, refutation_line,
safe_threshold, source_game_id, themes, band_miss_rates, engine_verify_depth,
created_at") but the app DB (src-tauri/src/db.rs) has no puzzles table yet,
so this writes a standalone SQLite file the app can later ATTACH or migrate.
Dedup is UNIQUE(fen, trap_uci) + INSERT OR IGNORE — re-importing a month is
a no-op, and the same rake reached in two games lands once.

Tier-1 leaves `themes` = '[]' and `band_miss_rates` = NULL (Tier-3 / Tier-2
fill them, spec 211:53-63).

Usage:
    python3 scripts/mining/import_puzzles.py puzzles.sqlite \\
        ~/chess-corpus/puzzles/*.cliffs.jsonl
"""

import argparse
import json
import sqlite3
import sys

SCHEMA = """
CREATE TABLE IF NOT EXISTS puzzles (
    id                   INTEGER PRIMARY KEY,
    fen                  TEXT NOT NULL,
    trap_uci             TEXT NOT NULL,
    trap_san             TEXT,
    refutation_line      TEXT NOT NULL,          -- space-separated UCI
    played_reply_san     TEXT,
    safe_threshold       INTEGER NOT NULL,        -- cp window for "correct"
    eval_before_cp       INTEGER,                 -- mover perspective ([%eval])
    eval_after_cp        INTEGER,
    verified_pre_best_cp INTEGER,                 -- engine re-verification
    verified_after_cp    INTEGER,
    n_alternatives       INTEGER,
    mate                 INTEGER NOT NULL DEFAULT 0,
    mover                TEXT,
    ply                  INTEGER,
    band                 TEXT,                    -- mover's 100-Elo band
    white_elo            INTEGER,
    black_elo            INTEGER,
    source_game_id       TEXT,
    site                 TEXT,
    date                 TEXT,
    time_control         TEXT,
    source_file          TEXT,
    themes               TEXT NOT NULL DEFAULT '[]',  -- Tier-3 (spec 211:59)
    band_miss_rates      TEXT,                        -- Tier-2 (spec 211:53)
    engine_verify_depth  INTEGER NOT NULL,
    generator            TEXT,
    created_at           TEXT NOT NULL,
    -- Depth-differential difficulty PRIOR (spec 214): minimal Stockfish depth
    -- at which the trap registers as clearly losing; -1 = swept without
    -- registering, NULL = not annotated. Filled post-import by
    -- depth_differential.py; the generator never emits it.
    visible_from_depth   INTEGER,
    UNIQUE (fen, trap_uci)
);
CREATE INDEX IF NOT EXISTS idx_puzzles_band ON puzzles (band);
"""

COLS = ("fen", "trap_uci", "trap_san", "refutation_line", "played_reply_san",
        "safe_threshold", "eval_before_cp", "eval_after_cp",
        "verified_pre_best_cp", "verified_after_cp", "n_alternatives", "mate",
        "mover", "ply", "band", "white_elo", "black_elo", "source_game_id",
        "site", "date", "time_control", "source_file", "engine_verify_depth",
        "generator", "created_at", "visible_from_depth")


def row_values(rec):
    rec = dict(rec)
    rec["refutation_line"] = " ".join(rec.get("refutation_line") or [])
    rec["safe_threshold"] = rec.pop("safe_threshold_cp")
    rec["mate"] = int(bool(rec.get("mate")))
    return tuple(rec.get(c) for c in COLS)


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("db", help="SQLite file to create/append (e.g. puzzles.sqlite).")
    p.add_argument("jsonl", nargs="+", help="*.cliffs.jsonl from mine_cliffs.py")
    args = p.parse_args()

    con = sqlite3.connect(args.db)
    con.executescript(SCHEMA)
    sql = (f"INSERT OR IGNORE INTO puzzles ({', '.join(COLS)}) "
           f"VALUES ({', '.join('?' * len(COLS))})")
    total = inserted = 0
    for path in args.jsonl:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                total += 1
                cur = con.execute(sql, row_values(json.loads(line)))
                inserted += cur.rowcount
        con.commit()
        print(f"[import_puzzles] {path}: cumulative {inserted}/{total} "
              "inserted (rest were dups)", file=sys.stderr)
    n = con.execute("SELECT COUNT(*) FROM puzzles").fetchone()[0]
    print(f"[import_puzzles] done: {inserted} new rows, {total - inserted} "
          f"duplicates skipped, {n} puzzles total in {args.db}",
          file=sys.stderr)


if __name__ == "__main__":
    main()

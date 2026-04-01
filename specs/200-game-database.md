# 200: Game Database

**Status:** draft
**Depends on:** 016 (game tree — games must be stored/loaded as trees, not flat move lists)

## Goal
SQLite-backed game database for importing, storing, and searching chess game collections. This is the SCID-level feature that differentiates from web-only tools.

## Architecture (informed by ChessX)

ChessX uses an abstract `Database` base class with pluggable backends (PgnDatabase, MemoryDatabase, PolyglotDatabase, CtgDatabase, etc.). We don't need that complexity yet, but the layering is right:

```
┌─────────────────────────────┐
│     Database API (Rust)     │  ← Abstract trait
├─────────────────────────────┤
│  SQLiteDatabase             │  ← Primary backend
│  MemoryDatabase (optional)  │  ← For clipboard / scratch
├─────────────────────────────┤
│  PGN Importer / Exporter    │  ← Batch I/O
│  Lichess API Importer       │  ← Online import
└─────────────────────────────┘
```

### Schema (SQLite)

```sql
-- Core tables
games (
  id INTEGER PRIMARY KEY,
  white TEXT, black TEXT,
  white_elo INTEGER, black_elo INTEGER,
  event TEXT, site TEXT, date TEXT,
  result TEXT,           -- "1-0", "0-1", "1/2-1/2", "*"
  eco TEXT,              -- ECO code (e.g., "B90")
  ply_count INTEGER,
  pgn_moves TEXT,        -- full PGN movetext (with variations + annotations)
  created_at TIMESTAMP
)

-- Position index for position search (the hard part)
positions (
  game_id INTEGER REFERENCES games(id),
  ply INTEGER,
  zobrist INTEGER,       -- 64-bit position hash for fast lookup
  fen TEXT               -- full FEN (for verification after hash match)
)
```

### Position Search Strategy

ChessX's `findPosition()` iterates all games — slow but correct. We should use **Zobrist hashing** for O(1) lookups:
1. On import: compute Zobrist hash for each position in each game, store in `positions` table
2. On search: compute hash for target position, query `positions WHERE zobrist = ?`
3. Verify with FEN comparison (hash collisions are rare but possible)

This is the approach SCID uses and it scales to millions of games.

### Rust-side Implementation

The database lives entirely in Rust (via `rusqlite` or `sqlx`). Tauri commands:
- `db_import_pgn(path: String)` — batch import with progress events
- `db_list_games(filters: GameFilter)` — paginated game list
- `db_load_game(id: i64)` — returns game as PGN movetext
- `db_search_position(fen: String)` — position search via Zobrist
- `db_delete_game(id: i64)`

Frontend receives games as PGN strings and loads them into the GameTree (spec:016).

## Done When
- [ ] Import PGN file(s) into SQLite database (batch, with progress)
- [ ] List games with headers (players, event, result, date, ECO)
- [ ] Search/filter by player name
- [ ] Search/filter by ECO code or opening name
- [ ] Search/filter by date range
- [ ] Position search: find all games containing a given position
- [ ] Click a game to load it into the board for analysis
- [ ] Game count displayed (handle databases with 100K+ games)
- [ ] Multiple databases can be open simultaneously

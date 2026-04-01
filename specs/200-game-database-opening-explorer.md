# 200: Game Database & Opening Explorer

**Status:** draft
**Depends on:** 016 (game tree — games stored/loaded as trees)

## Goal
SQLite-backed game database with position search, plus an opening tree explorer showing move statistics. SCID's killer features in a modern stack.

## Database Architecture

### Schema (SQLite via Rust)
```sql
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

positions (
  game_id INTEGER REFERENCES games(id),
  ply INTEGER,
  zobrist INTEGER,       -- 64-bit position hash for fast lookup
  fen TEXT               -- full FEN (verification after hash match)
)
```

### Position Search
Zobrist hashing for O(1) lookups (SCID's approach):
1. On import: compute Zobrist hash per position, store in `positions` table
2. On search: hash target position, query `WHERE zobrist = ?`
3. Verify with FEN comparison (rare hash collisions)

### Rust Commands
- `db_import_pgn(path)` — batch import with progress events
- `db_list_games(filters)` — paginated game list
- `db_load_game(id)` — returns PGN movetext → loaded into GameTree (spec:016)
- `db_search_position(fen)` — Zobrist position search
- `db_delete_game(id)`

## Opening Tree Explorer

### Data Model
```typescript
interface OpeningMove {
  san: string;           // e.g., "Nf3"
  uci: string;           // e.g., "g1f3"
  count: number;
  whiteWins: number;
  draws: number;
  blackWins: number;
  avgElo?: number;
  performance?: number;
}
```

### Computation
For current position → query all games reaching it → aggregate next moves with W/D/L stats. Async Tauri command so UI doesn't freeze.

### Lichess API Fallback
`GET https://explorer.lichess.ovh/lichess?fen={fen}&speeds=blitz,rapid,classical`
Used when local database is empty or as supplement.

### UI
Horizontal stacked bar chart per move (white/draw/black segments), like Lichess. Clicking a move plays it and updates the tree.

## Done When

### Database (from spec:200)
- [ ] Import PGN file(s) into SQLite database (batch, with progress)
- [ ] List games with headers (players, event, result, date, ECO)
- [ ] Search/filter by player name
- [ ] Search/filter by ECO code or opening name
- [ ] Search/filter by date range
- [ ] Position search: find all games containing a given position
- [ ] Click a game to load it into the board for analysis
- [ ] Game count displayed (handle databases with 100K+ games)
- [ ] Multiple databases can be open simultaneously

### Opening Explorer (from spec:201)
- [ ] Panel shows all moves played from current position in the database
- [ ] Each move shows game count and result percentages (stacked bar)
- [ ] Moves sorted by frequency (configurable: by count, by performance)
- [ ] Clicking a move plays it on the board
- [ ] Updates as user navigates through moves
- [ ] Lichess API fallback when local database is empty
- [ ] Average Elo and performance rating shown per move
- [ ] Tree computation is async — no UI freeze on large databases

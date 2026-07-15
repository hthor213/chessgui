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

Backend in `src-tauri/src/db.rs` (schema v1, streaming import, search, dedup)
with typed TS wrappers in `lib/database.ts`. Database tab UI in
`components/database-tab.tsx` (wired into `app/page.tsx`), drivable headless via
the mock in `lib/database-mock.ts`.

- [x] Import PGN file(s) into SQLite database (batch) — streaming, 1000-games/commit; UI import dialog (paste + file); progress events now streamed over a Tauri Channel per committed batch (`PgnImportProgress` in db.rs, running-count bar in the import dialog — no `total` is knowable for a PGN stream); import moved to `spawn_blocking` like CBH
- [x] List games with headers (players, event, result, date, ECO) — indexed, paginated table with column sort
- [x] Search/filter by player name — either colour, substring; live-debounced filter bar
- [x] Search/filter by ECO code — ECO prefix; opening-name lookup via a bundled compact range table (`lib/eco.ts`, covers all of A00–E99, unit-tested); names shown as tooltips on the game list's ECO column and as a line in the board's game-header card (PGN `Opening` tag wins when present)
- [x] Search/filter by date range — `date_from`/`date_to`
- [x] Position search: find all games containing a given position — Zobrist index + FEN verification; returns the next move per game; "Find current position" action in the tab
- [x] Click a game to load it into the board for analysis — row click → `getGame` → `parsePgnToTrees` → `loadTree` → board
- [x] Game count displayed (handle databases with 100K+ games) — shown in tab header; pagination + backend verified ~15k games/s import & 50k-game search
- [x] Multiple databases can be open simultaneously — backend `DbManager` keeps one connection per path (pass `dbPath`); UI switcher in the Database tab header ("Default" + opened files, native "Open…" picker in Tauri) with the opened list persisted (`lib/db-registry.ts`); all list/search/import/delete calls follow the selected DB

### Opening Explorer (from spec:201)

First seed landed in the Database tab's position search (grouped next-move
breakdown). A dedicated live explorer panel is a later slice.

- [x] Panel shows all moves played from current position in the database — grouped by next move
- [x] Each move shows game count and result percentages (stacked bar) — white/draw/black segments
- [x] Moves sorted by frequency (configurable: by count, by performance) — Count/Perf toggle in the position-search panel; sorting + aggregation in `lib/explorer-stats.ts` (unit-tested)
- [x] Clicking a move plays it on the board — click (or Enter/Space) on a move row calls `playUciMove`, staying on the Database tab so the tree can be walked move-by-move
- [x] Updates as user navigates through moves — debounced auto-search on `currentFen` change; the "Find current position" button is now a manual "Refresh" (e.g. after an import) rather than the only trigger
- [x] Lichess API fallback when local database is empty — when the local search returns 0 games, the panel queries `explorer.lichess.ovh` with a clear "online — Lichess" badge; graceful offline failure message; 64-position in-memory cache (`lib/lichess-explorer.ts`, unit-tested with mocked fetch; online/offline paths driven headless with intercepted network)
- [x] Average Elo and performance rating shown per move — avg Elo plus a per-move performance rating for the side to move (mean opponent rating + FIDE logistic dp, ±800 clamp for perfect scores; `lib/explorer-stats.ts`, unit-tested). Lichess fallback rows show avg rating only — per-game opponent ratings aren't in the aggregate API, so a true performance number can't be computed there
- [x] Tree computation is async — no UI freeze on large databases — all data access is async; Tauri runs the query off the UI thread

// Typed wrappers over the SQLite game-database backend (spec 200).
//
// Mirrors the Rust structs and `db_*` Tauri commands in src-tauri/src/db.rs.
// Struct fields are snake_case to match serde's on-the-wire shape; command
// argument names are camelCase because Tauri maps them to the Rust snake_case
// parameters.
//
// Provider seam (spec 220 step 2): these delegate to the registered
// DatabaseProvider — Tauri `invoke` on desktop, the in-memory mock in a plain
// browser (`pnpm dev` under Playwright, or unit tests) so the whole Database
// tab stays drivable headless.

import { getProviders } from "@/lib/platform"

// ---------------------------------------------------------------------------
// Types mirroring the Rust structs
// ---------------------------------------------------------------------------

/** Outcome of a PGN import. Mirrors Rust `ImportReport`. */
export type ImportReport = {
  imported: number
  dups_skipped: number
  errors: number
}

/**
 * Progress snapshot streamed during a CBH import: once up front (carrying
 * `total`) and then after every imported batch. Mirrors Rust `CbhImportProgress`.
 */
export type CbhImportProgress = {
  processed: number
  total: number
  imported: number
  dups_skipped: number
}

/**
 * Progress snapshot streamed during a PGN import: once up front, after every
 * committed batch, and once at the end. No `total` — a PGN stream's game
 * count is unknown without a pre-scan. Mirrors Rust `PgnImportProgress`.
 */
export type PgnImportProgress = {
  processed: number
  imported: number
  dups_skipped: number
  errors: number
}

/**
 * Outcome of a full CBH import. `convert_errors` are records the CBH decoder
 * could not turn into PGN; `db_errors` are converted games the PGN importer
 * then rejected. Mirrors Rust `CbhImportReport`.
 */
export type CbhImportReport = {
  records: number
  imported: number
  dups_skipped: number
  convert_errors: number
  db_errors: number
  dropped_variations: number
  mainlines_truncated: number
}

/** One row of the game list. Mirrors Rust `GameHeader`. */
export type GameHeader = {
  id: number
  white: string
  black: string
  white_elo: number | null
  black_elo: number | null
  event: string
  site: string
  round: string
  date: string
  eco: string
  result: string
  ply_count: number
  source: string
}

/**
 * Header filters for {@link listGames}. Every field is optional; omitted fields
 * do not constrain the query. `player` matches either colour; `white`/`black`
 * match that colour only; `eco` is a prefix ("B9" → B90..B99); `date_from` /
 * `date_to` bound the (string-sortable) PGN date; `min_elo` requires at least
 * one player at or above the rating. Mirrors Rust `GameFilter`.
 */
export type GameFilter = {
  player?: string
  white?: string
  black?: string
  event?: string
  eco?: string
  date_from?: string
  date_to?: string
  result?: string
  min_elo?: number
}

/** Columns the backend can sort by (whitelisted server-side). */
export type SortColumn =
  | "white"
  | "black"
  | "white_elo"
  | "black_elo"
  | "event"
  | "date"
  | "eco"
  | "result"
  | "ply_count"

export type Sort = { by: SortColumn; dir: "asc" | "desc" }

/**
 * A game reaching a searched position, plus the move played next in it — the
 * raw material the opening explorer aggregates. Mirrors Rust `PositionHit`.
 */
export type PositionHit = {
  game_id: number
  white: string
  black: string
  white_elo: number | null
  black_elo: number | null
  result: string
  date: string
  /** Ply at which the searched position occurred (0 = start position). */
  ply: number
  /** UCI of the move played next, or null if it was the last indexed position. */
  next_uci: string | null
  /** SAN of that same move. */
  next_san: string | null
}

/** Aggregate database counts. Mirrors Rust `DbStats`. */
export type DbStats = {
  games: number
  positions: number
}

/** The function surface both the Tauri path and the mock implement. */
export interface DatabaseApi {
  importPgn(args: {
    source: string
    text?: string
    filePath?: string
    dbPath?: string
  }): Promise<ImportReport>
  listGames(
    filter: GameFilter,
    limit: number,
    offset: number,
    sort?: Sort,
    dbPath?: string,
  ): Promise<GameHeader[]>
  searchPosition(fen: string, limit?: number, dbPath?: string): Promise<PositionHit[]>
  getGame(id: number, dbPath?: string): Promise<string | null>
  deleteGames(ids: number[], dbPath?: string): Promise<number>
  stats(dbPath?: string): Promise<DbStats>
}

// ---------------------------------------------------------------------------
// Provider seam
// ---------------------------------------------------------------------------

// Re-exported for existing importers (components/database-tab.tsx); the
// definition lives with the provider registry.
export { isTauri } from "@/lib/platform"

// ---------------------------------------------------------------------------
// Command wrappers
// ---------------------------------------------------------------------------

/**
 * Import PGN into the database. Provide either `text` (a pasted string) or
 * `filePath` (streamed from disk in Tauri — the browser mock only uses `text`).
 * `source` is recorded per game as provenance. `dbPath` selects a specific
 * database file; omit it for the default one in the app data dir.
 * `onProgress` receives a snapshot up front and after every committed batch
 * (the mock emits a single final snapshot).
 */
export function importPgn(args: {
  source: string
  text?: string
  filePath?: string
  dbPath?: string
  onProgress?: (p: PgnImportProgress) => void
}): Promise<ImportReport> {
  return getProviders().database.importPgn(args)
}

/**
 * Import a ChessBase .cbh database into the game database. `cbhPath` must be a
 * real filesystem path — the Rust decoder reads the sibling .cbg/.cba/… files
 * next to it — so callers obtain it from the native file dialog, not an HTML
 * file input. Native-only: the decoder lives in Rust, so this is not part of
 * {@link DatabaseApi} and has no browser mock; gate on {@link isTauri}.
 * `onProgress` receives a snapshot up front and after every imported batch.
 */
export function importCbh(args: {
  cbhPath: string
  dbPath?: string
  onProgress?: (p: CbhImportProgress) => void
}): Promise<CbhImportReport> {
  return getProviders().database.importCbh(args)
}

/** Paginated, filtered header list. Sort defaults to newest-inserted first. */
export function listGames(
  filter: GameFilter,
  limit: number,
  offset: number,
  sort?: Sort,
  dbPath?: string,
): Promise<GameHeader[]> {
  return getProviders().database.listGames(filter, limit, offset, sort, dbPath)
}

/**
 * Find games reaching the position given by `fen`. Returns, per game, the move
 * played next — ready for opening-explorer aggregation. `limit` caps the number
 * of games returned (default 200 on the backend).
 */
export function searchPosition(
  fen: string,
  limit?: number,
  dbPath?: string,
): Promise<PositionHit[]> {
  return getProviders().database.searchPosition(fen, limit, dbPath)
}

/** Full PGN (tags + movetext) for one game, ready to load into a GameTree. */
export function getGame(id: number, dbPath?: string): Promise<string | null> {
  return getProviders().database.getGame(id, dbPath)
}

/** Delete games by id (their indexed positions cascade). Returns count removed. */
export function deleteGames(ids: number[], dbPath?: string): Promise<number> {
  return getProviders().database.deleteGames(ids, dbPath)
}

/** Aggregate counts for the database. */
export function stats(dbPath?: string): Promise<DbStats> {
  return getProviders().database.stats(dbPath)
}

// Typed wrappers over the SQLite game-database backend (spec 200).
//
// Mirrors the Rust structs and `db_*` Tauri commands in src-tauri/src/db.rs.
// Struct fields are snake_case to match serde's on-the-wire shape; command
// argument names are camelCase because Tauri maps them to the Rust snake_case
// parameters.
//
// Provider seam: in the real desktop app these route to Tauri `invoke`. Outside
// Tauri (a plain browser — e.g. `pnpm dev` under Playwright, or unit tests) they
// route to an in-memory mock so the whole Database tab is drivable headless. The
// mock is loaded via dynamic import, so it stays out of the Tauri bundle.

import { Channel, invoke } from "@tauri-apps/api/core"

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

/** True inside the Tauri webview (its IPC globals are injected before load). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

let mockApiPromise: Promise<DatabaseApi> | null = null
function mockApi(): Promise<DatabaseApi> {
  if (!mockApiPromise) {
    mockApiPromise = import("./database-mock").then((m) => m.mockDatabase)
  }
  return mockApiPromise
}

// ---------------------------------------------------------------------------
// Command wrappers
// ---------------------------------------------------------------------------

/**
 * Import PGN into the database. Provide either `text` (a pasted string) or
 * `filePath` (streamed from disk in Tauri — the browser mock only uses `text`).
 * `source` is recorded per game as provenance. `dbPath` selects a specific
 * database file; omit it for the default one in the app data dir.
 */
export function importPgn(args: {
  source: string
  text?: string
  filePath?: string
  dbPath?: string
}): Promise<ImportReport> {
  if (!isTauri()) return mockApi().then((m) => m.importPgn(args))
  return invoke<ImportReport>("db_import_pgn", {
    source: args.source,
    text: args.text ?? null,
    filePath: args.filePath ?? null,
    dbPath: args.dbPath ?? null,
  })
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
  if (!isTauri()) return Promise.reject(new Error("CBH import requires the desktop app"))
  const channel = new Channel<CbhImportProgress>()
  if (args.onProgress) channel.onmessage = args.onProgress
  return invoke<CbhImportReport>("db_import_cbh", {
    cbhPath: args.cbhPath,
    dbPath: args.dbPath ?? null,
    onProgress: channel,
  })
}

/** Paginated, filtered header list. Sort defaults to newest-inserted first. */
export function listGames(
  filter: GameFilter,
  limit: number,
  offset: number,
  sort?: Sort,
  dbPath?: string,
): Promise<GameHeader[]> {
  if (!isTauri()) return mockApi().then((m) => m.listGames(filter, limit, offset, sort, dbPath))
  return invoke<GameHeader[]>("db_list_games", {
    filter,
    limit,
    offset,
    sortBy: sort?.by ?? null,
    sortDir: sort?.dir ?? null,
    dbPath: dbPath ?? null,
  })
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
  if (!isTauri()) return mockApi().then((m) => m.searchPosition(fen, limit, dbPath))
  return invoke<PositionHit[]>("db_search_position", {
    fen,
    limit: limit ?? null,
    dbPath: dbPath ?? null,
  })
}

/** Full PGN (tags + movetext) for one game, ready to load into a GameTree. */
export function getGame(id: number, dbPath?: string): Promise<string | null> {
  if (!isTauri()) return mockApi().then((m) => m.getGame(id, dbPath))
  return invoke<string | null>("db_get_game", { id, dbPath: dbPath ?? null })
}

/** Delete games by id (their indexed positions cascade). Returns count removed. */
export function deleteGames(ids: number[], dbPath?: string): Promise<number> {
  if (!isTauri()) return mockApi().then((m) => m.deleteGames(ids, dbPath))
  return invoke<number>("db_delete_games", { ids, dbPath: dbPath ?? null })
}

/** Aggregate counts for the database. */
export function stats(dbPath?: string): Promise<DbStats> {
  if (!isTauri()) return mockApi().then((m) => m.stats(dbPath))
  return invoke<DbStats>("db_stats", { dbPath: dbPath ?? null })
}

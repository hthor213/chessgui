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

// Extracted to @chessgui/core (spec 220 step 5); re-exported so existing
// importers keep working.
import type {
  CbhImportProgress,
  CbhImportReport,
  DbStats,
  GameFilter,
  GameHeader,
  ImportReport,
  PgnImportProgress,
  PlayerGameRow,
  PositionHit,
  SaveReport,
  Sort,
  SortColumn,
} from "@chessgui/core/database-types"
export type {
  CbhImportProgress,
  CbhImportReport,
  DbStats,
  GameFilter,
  GameHeader,
  ImportReport,
  PgnImportProgress,
  PlayerGameRow,
  PositionHit,
  SaveReport,
  Sort,
  SortColumn,
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
  searchPositionForPlayer(
    fen: string,
    player: string,
    gameLimit?: number,
    dbPath?: string,
  ): Promise<PositionHit[]>
  listPlayers(prefix: string, limit?: number, dbPath?: string): Promise<string[]>
  playerOpenings(player: string, gameLimit?: number, dbPath?: string): Promise<PlayerGameRow[]>
  getGame(id: number, dbPath?: string): Promise<string | null>
  saveGame(args: { pgn: string; source?: string; dbPath?: string }): Promise<SaveReport>
  deleteGames(ids: number[], dbPath?: string): Promise<number>
  stats(dbPath?: string): Promise<DbStats>
  addTag(id: number, tag: string, dbPath?: string): Promise<void>
  removeTag(id: number, tag: string, dbPath?: string): Promise<void>
  listTags(dbPath?: string): Promise<string[]>
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

/**
 * Cancel the in-flight CBH import. The Rust loop stops at its next batch
 * boundary, keeps every batch already committed, and the pending
 * {@link importCbh} call resolves with `cancelled: true` and honest counts
 * for what landed. No-op when no import is running.
 */
export function cancelCbhImport(): Promise<void> {
  return getProviders().database.cancelCbhImport()
}

/**
 * Merge another ChessGUI database file into the target database (spec 200
 * "merge databases"). Games copy with their indexed positions, material
 * signatures and tags; exact duplicates are skipped via the same dup hash as
 * PGN import. `sourcePath` must be a real filesystem path (the backend
 * ATTACHes the SQLite file), so callers obtain it from the native file
 * dialog — native-only like {@link importCbh}; gate on {@link isTauri}.
 * `onProgress` receives a snapshot up front and after every committed batch.
 */
export function mergeDatabase(args: {
  sourcePath: string
  dbPath?: string
  onProgress?: (p: PgnImportProgress) => void
}): Promise<ImportReport> {
  return getProviders().database.mergeDatabase(args)
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

/**
 * Explorer stats over ONE player's games (spec 225 rival filter / spec 211
 * own-games view): like {@link searchPosition}, but only games where `player`
 * held either colour count. Exact-name match — feed it names from
 * {@link listPlayers}. `gameLimit` caps the candidate games (most recent
 * first, default 2000 on the backend) so the query stays bounded.
 */
export function searchPositionForPlayer(
  fen: string,
  player: string,
  gameLimit?: number,
  dbPath?: string,
): Promise<PositionHit[]> {
  return getProviders().database.searchPositionForPlayer(fen, player, gameLimit, dbPath)
}

/**
 * Distinct player names starting with `prefix`, sorted — feeds the explorer's
 * player datalist. An empty prefix resolves to an empty list (the datalist
 * fills in as the user types; it is never a full-roster dump).
 */
export function listPlayers(prefix: string, limit?: number, dbPath?: string): Promise<string[]> {
  return getProviders().database.listPlayers(prefix, limit, dbPath)
}

/**
 * The player's most recent finished games as light opening-leak rows
 * (spec 211), newest first. Aggregate them with
 * `aggregateOpeningLeaks` from @chessgui/core/opening-leaks.
 */
export function playerOpenings(
  player: string,
  gameLimit?: number,
  dbPath?: string,
): Promise<PlayerGameRow[]> {
  return getProviders().database.playerOpenings(player, gameLimit, dbPath)
}

/** Full PGN (tags + movetext) for one game, ready to load into a GameTree. */
export function getGame(id: number, dbPath?: string): Promise<string | null> {
  return getProviders().database.getGame(id, dbPath)
}

/**
 * Save one game's PGN — the spec-202 "save annotated game" action. Upsert
 * semantics: a game with the same mainline + result gets its headers and
 * movetext (comments, NAGs, `[%…]` tags) refreshed in place; anything else
 * inserts a new row. `source` labels new rows in the game list (default
 * "saved" on the backend).
 */
export function saveGame(args: {
  pgn: string
  source?: string
  dbPath?: string
}): Promise<SaveReport> {
  return getProviders().database.saveGame(args)
}

/** Delete games by id (their indexed positions cascade). Returns count removed. */
export function deleteGames(ids: number[], dbPath?: string): Promise<number> {
  return getProviders().database.deleteGames(ids, dbPath)
}

/** Aggregate counts for the database. */
export function stats(dbPath?: string): Promise<DbStats> {
  return getProviders().database.stats(dbPath)
}

/**
 * Attach a tag to a game (spec 200 tagging/favorites; "favorite" is the
 * star). Adding a tag the game already carries is a no-op.
 */
export function addTag(id: number, tag: string, dbPath?: string): Promise<void> {
  return getProviders().database.addTag(id, tag, dbPath)
}

/** Remove a tag from a game. Removing an absent tag is a no-op. */
export function removeTag(id: number, tag: string, dbPath?: string): Promise<void> {
  return getProviders().database.removeTag(id, tag, dbPath)
}

/** All distinct tags in use, sorted — feeds the tag filter dropdown. */
export function listTags(dbPath?: string): Promise<string[]> {
  return getProviders().database.listTags(dbPath)
}

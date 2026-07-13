// Typed wrappers over the SQLite game-database backend (spec 200).
//
// Mirrors the Rust structs and `db_*` Tauri commands in src-tauri/src/db.rs.
// Struct fields are snake_case to match serde's on-the-wire shape; command
// argument names are camelCase because Tauri maps them to the Rust snake_case
// parameters. No UI here — the database tab consumes these wrappers.

import { invoke } from "@tauri-apps/api/core"

// ---------------------------------------------------------------------------
// Types mirroring the Rust structs
// ---------------------------------------------------------------------------

/** Outcome of a PGN import. Mirrors Rust `ImportReport`. */
export type ImportReport = {
  imported: number
  dups_skipped: number
  errors: number
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

// ---------------------------------------------------------------------------
// Command wrappers
// ---------------------------------------------------------------------------

/**
 * Import PGN into the database. Provide either `text` (a pasted string) or
 * `filePath` (streamed from disk — use this for large files). `source` is
 * recorded per game as provenance. `dbPath` selects a specific database file;
 * omit it for the default one in the app data dir.
 */
export function importPgn(args: {
  source: string
  text?: string
  filePath?: string
  dbPath?: string
}): Promise<ImportReport> {
  return invoke<ImportReport>("db_import_pgn", {
    source: args.source,
    text: args.text ?? null,
    filePath: args.filePath ?? null,
    dbPath: args.dbPath ?? null,
  })
}

/** Paginated, filtered header list, newest-inserted first. */
export function listGames(
  filter: GameFilter,
  limit: number,
  offset: number,
  dbPath?: string,
): Promise<GameHeader[]> {
  return invoke<GameHeader[]>("db_list_games", {
    filter,
    limit,
    offset,
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
  return invoke<PositionHit[]>("db_search_position", {
    fen,
    limit: limit ?? null,
    dbPath: dbPath ?? null,
  })
}

/** Full PGN (tags + movetext) for one game, ready to load into a GameTree. */
export function getGame(id: number, dbPath?: string): Promise<string | null> {
  return invoke<string | null>("db_get_game", { id, dbPath: dbPath ?? null })
}

/** Delete games by id (their indexed positions cascade). Returns count removed. */
export function deleteGames(ids: number[], dbPath?: string): Promise<number> {
  return invoke<number>("db_delete_games", { ids, dbPath: dbPath ?? null })
}

/** Aggregate counts for the database. */
export function stats(dbPath?: string): Promise<DbStats> {
  return invoke<DbStats>("db_stats", { dbPath: dbPath ?? null })
}

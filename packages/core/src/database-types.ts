// Database domain types (spec 200) — extracted to @chessgui/core (spec 220 step 5)
// so the DatabaseProvider interface can reference them from pure code.
// Mirrors the Rust structs in src-tauri/src/db.rs; snake_case is serde's wire shape.

/** Outcome of a PGN import. Mirrors Rust `ImportReport`. */
export type ImportReport = {
  imported: number
  dups_skipped: number
  errors: number
}

/**
 * Outcome of saving one game (spec 202: save the annotated game to the DB).
 * `updated` is true when a game with the same mainline + result already
 * existed and its headers/annotations were refreshed in place.
 * Mirrors Rust `SaveReport`.
 */
export type SaveReport = {
  id: number
  updated: boolean
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

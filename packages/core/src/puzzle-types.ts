// Avoidance-puzzle domain types (spec 211) — extracted to @chessgui/core
// (spec 220 step 5). Mirrors the Rust structs in src-tauri/src/puzzles.rs.

/** One puzzle row. Mirrors Rust `PuzzleRow`; snake_case is serde's wire shape. */
export type PuzzleRow = {
  id: number
  fen: string
  trap_uci: string
  trap_san: string | null
  refutation_line: string[]
  played_reply_san: string | null
  safe_threshold: number
  eval_before_cp: number | null
  eval_after_cp: number | null
  verified_pre_best_cp: number | null
  verified_after_cp: number | null
  n_alternatives: number | null
  mate: boolean
  mover: string | null
  ply: number | null
  band: string | null
  white_elo: number | null
  black_elo: number | null
  source_game_id: string | null
  site: string | null
  date: string | null
  time_control: string | null
  themes: string[]
  band_miss_rates: string | null
  engine_verify_depth: number
}

/** Outcome of a JSONL import. Mirrors Rust `PuzzleImportReport`. */
export type PuzzleImportReport = {
  imported: number
  dups_skipped: number
  errors: number
}

export type PuzzleStats = {
  total: number
  /** Puzzles with trap ply < OPENING_MAX_PLY — the opening-rake pool. */
  opening: number
  bands: { band: string; count: number }[]
}

/** Engine verdict on a candidate move, MOVER-POV (mirrors Rust `MoveCheck`).
 *  `null` at the seam means "no engine available" (plain browser). */
export type MoveCheck = {
  cp_mover: number | null
  mate_mover: number | null
  pv: string[]
  depth: number
}
/** Opening-rake bar (spec 211 "Opening-rake decks"): a rake counts as an
 *  opening rake when its trap ply index is < 20 — "don't be -1 by move 10".
 *  MIRRORS `OPENING_MAX_PLY` in src-tauri/src/puzzles.rs (which uses it for
 *  the stats `opening` count); a change must land in both. */
export const OPENING_MAX_PLY = 20

export interface DeckRequest {
  /** Mover Elo band ("1900" … "2500"), or null for all bands. */
  band: string | null
  count: number
  /** Only puzzles with trap ply < maxPly (opening decks pass
   *  OPENING_MAX_PLY). Unlike the band this is a HARD filter — thin supply
   *  is never topped up from later plies. Omit/null = any phase. */
  maxPly?: number | null
}

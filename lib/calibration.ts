// Typed wrappers over the Eval Calibration backend (spec 213 data collection).
//
// Mirrors the Rust structs and `calibration_*` Tauri commands in
// src-tauri/src/calibration.rs. Struct fields are snake_case to match serde's
// wire shape; command argument names are camelCase (Tauri maps them to the Rust
// snake_case parameters).
//
// Provider seam: inside Tauri these route to `invoke`; outside Tauri (a plain
// browser under Playwright, or unit tests) sampling routes to an in-memory mock
// so the whole Learn flow is drivable headless. The mock is dynamically
// imported so it stays out of the Tauri bundle.

import { invoke, Channel } from "@tauri-apps/api/core"

// ---------------------------------------------------------------------------
// Types mirroring the Rust structs
// ---------------------------------------------------------------------------

/** One position to judge, with its Stockfish ground truth. Mirrors Rust
 *  `CalibrationPosition`. All engine numbers are White-POV. */
export type CalibrationPosition = {
  fen: string
  /** White-POV centipawns; null when the position is a forced mate. */
  sf_cp: number | null
  /** White-POV mate distance (+ = White mates); null when `sf_cp` is set. */
  sf_mate: number | null
  sf_best_uci: string
  sf_best_san: string | null
  /** |eval(pv1) − eval(pv2)| in centipawns; null when unavailable. */
  multipv_gap_cp: number | null
  /** Material balance in points, White minus Black. */
  material: number
  /** |SF eval| band: "0-0.5" | "0.5-1.5" | "1.5-3" | "3+". */
  band: string
  /** "middlegame" | "endgame". */
  phase: string
  game_id: number
  ply: number
  // --- v2: known-Elo game context. NEVER shown in the answering UI (would
  //     anchor the user's eval); revealed only on the results screen. ---
  white_elo: number | null
  black_elo: number | null
  /** Average-Elo band of the source game: "<1600" | "1600-2000" | "2000-2400" | "2400+". */
  elo_band: string
  /** Side to move: "white" | "black" — whose move `played_*` is. */
  to_move: string
  /** The move actually played from this position in the source game. */
  played_uci: string | null
  played_san: string | null
  /** The next up-to-three moves after the played one, SAN. */
  continuation_san: string[]
}

/** A calibration session. Mirrors Rust `CalibrationSession`. */
export type CalibrationSession = {
  version: number
  n: number
  /** Unix-ms creation time; the session's stable id. */
  created_at: number
  stockfish_path: string
  positions: CalibrationPosition[]
}

/** Sampler progress. Mirrors Rust `CalibrationProgress`. */
export type CalibrationProgress = {
  evaluated: number
  accepted: number
  target: number
}

/** The user's response to one position. */
export type CalibrationAnswer = {
  /** Index of the position within the session. */
  index: number
  /** Perceived eval in pawns (+ = White better); null if skipped. */
  eval: number | null
  /** One-or-two-sentence reason. */
  why: string
  /** UCI of the move they'd play, or null if they didn't pick one. */
  move_uci: string | null
  /** Wall time spent on this position, milliseconds. */
  elapsed_ms: number
  skipped: boolean
}

/** Per-band accuracy row. */
export type BandStat = {
  band: string
  count: number
  /** Mean absolute error in pawns, or null when the band has no answers. */
  mae: number | null
}

/** Per-phase accuracy row (middlegame / endgame). Fuller than a band row: a
 *  chess eval skill is per-phase, so we surface correlation and move accuracy
 *  too. `null` metrics mean too few (or no) answers to compute them. */
export type PhaseStat = {
  phase: string
  count: number
  mae: number | null
  pearson: number | null
  bestMoveHitRate: number | null
  /** Positions in this phase on which the user chose a move. */
  moveAnswers: number
}

/** A position the user was furthest off on. */
export type Miss = {
  index: number
  fen: string
  band: string
  userEval: number
  sfEval: number
  absError: number
}

/** Summary statistics for a completed session. */
export type CalibrationSummary = {
  answered: number
  skipped: number
  /** Positions on which the user chose a move. */
  moveAnswers: number
  /** Pearson correlation of user vs Stockfish eval; null if < 2 answers. */
  pearson: number | null
  /** Mean absolute error in pawns; null if no answers. */
  mae: number | null
  /** Fraction of move-answers matching Stockfish's best move; null if none. */
  bestMoveHitRate: number | null
  perBand: BandStat[]
  perPhase: PhaseStat[]
  biggestMisses: Miss[]
}

/** Fewer than this many answers in a phase → its metrics are too thin to read
 *  much into; the UI flags it. */
export const MIN_PHASE_N = 8

/** The research artifact written on completion. Self-contained: it carries the
 *  full session so each file stands alone. Mirrors the schema documented in
 *  docs/research/calibration-data-format.md. */
export type CalibrationResults = {
  version: number
  finished_at: number
  session: CalibrationSession
  answers: CalibrationAnswer[]
  summary: CalibrationSummary
}

/** On-disk schema version this build writes (v2 adds known-Elo game context). */
export const RESULTS_VERSION = 2

// ---------------------------------------------------------------------------
// Provider seam
// ---------------------------------------------------------------------------

/** True inside the Tauri webview (its IPC globals are injected before load). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

// ---------------------------------------------------------------------------
// Command wrappers
// ---------------------------------------------------------------------------

/**
 * Create a stratified calibration session of `n` positions. `onProgress` ticks
 * as Stockfish scores candidates (2–4 minutes for 100 in the real app). Outside
 * Tauri this resolves from an in-memory mock so the flow is drivable headless.
 */
export function sampleSession(
  n: number,
  opts: { dbPath?: string; stockfishPath?: string; movetimeMs?: number } = {},
  onProgress?: (p: CalibrationProgress) => void,
): Promise<CalibrationSession> {
  if (!isTauri()) {
    return import("./calibration-mock").then((m) => m.buildMockSession(n, onProgress))
  }
  const channel = new Channel<CalibrationProgress>()
  if (onProgress) channel.onmessage = onProgress
  return invoke<CalibrationSession>("calibration_sample", {
    n,
    dbPath: opts.dbPath ?? null,
    stockfishPath: opts.stockfishPath ?? null,
    movetimeMs: opts.movetimeMs ?? null,
    onProgress: channel,
  })
}

/**
 * Persist a completed result to the app's calibration directory, returning the
 * written path. Outside Tauri this is a no-op (returns "").
 */
export function saveResults(results: CalibrationResults): Promise<string> {
  if (!isTauri()) return Promise.resolve("")
  return invoke<string>("calibration_save_results", { results })
}

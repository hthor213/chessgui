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
  /** Wall time from position-shown to submit, milliseconds (includes typing). */
  elapsed_ms: number
  /**
   * Think time: position-shown → first input interaction (first keystroke in the
   * eval or why field, or first board move — whichever comes first). This is the
   * meaningful metric — "I've formed a view when I start typing", so typing time
   * is not thinking time. Null if the user never interacted before advancing, or
   * for pre-think_ms (upgraded) answers.
   */
  think_ms: number | null
  /**
   * The user asked not to count their time on this position (e.g. distracted).
   * The answer still counts for eval accuracy; only time analysis ignores it.
   * Set automatically on old answers that predate think_ms.
   */
  time_excluded: boolean
  /**
   * Unix-ms at which the answer was locked — stamped before any post-answer
   * reveal is rendered, so the reveal provably cannot have influenced the
   * answer. 0 for answers that predate this field.
   */
  answer_locked_at: number
  // --- Second look: an optional revision the user makes AFTER locking but
  //     BEFORE any engine feedback. The original eval/why above are immutable;
  //     these record the self-correction (a per-band skill signature). ---
  /** Revised eval in pawns, or null if they didn't revise. */
  revised_eval: number | null
  /** One-line note on what they caught (e.g. "missed the Qe1"), or null. */
  revision_note: string | null
  /** Unix-ms of the revision, or null. */
  revised_at: number | null
  /** AI coach's critique of the written reasoning, attached async after the
   *  reveal; null until it arrives (or if the coach was off / unavailable). */
  coach: CoachFeedback | null
  skipped: boolean
}

/** The AI coach's critique of one answer. Mirrors Rust `CoachFeedback`. */
export type CoachFeedback = {
  /** 2-4 sentence coach note addressed to the user. */
  note: string
  /** Cause labels from the fixed taxonomy (see docs/research/calibration-data-format.md). */
  cause_tags: string[]
  /** "sound" | "partial" | "flawed". */
  reasoning_quality: string
  /** Direction right, magnitude off. */
  scale_error: boolean
}

/** Everything the coach needs about one answered position. Mirrors Rust `CoachInput`. */
export type CoachInput = {
  fen: string
  to_move: string
  sf_cp: number | null
  sf_mate: number | null
  sf_best_san: string | null
  sf_best_uci: string | null
  multipv_gap_cp: number | null
  material: number | null
  user_eval: number | null
  user_why: string
  user_move_uci: string | null
  revised_eval: number | null
  revision_note: string | null
  played_san: string | null
  continuation_san: string[] | null
  white_elo: number | null
  black_elo: number | null
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
  /** Median think time (ms) over time-included, interacted answers; null if none. */
  medianThinkMs: number | null
  /** Answers whose time the user excluded (or that predate think_ms). */
  timeExcludedCount: number
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
  /**
   * Whether the post-answer reveal was shown during this session. A blind
   * session (false) is methodologically distinct data — no feedback between
   * positions — so the mode is recorded with the artifact.
   */
  show_reveal: boolean
  /** Whether AI coach feedback was enabled (off = no API calls were made). */
  show_coach: boolean
  session: CalibrationSession
  /** Answers in presentation order (each carries its `index`), so learning /
   *  drift effects over the session are analysable. */
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

/**
 * Bring a stored answer up to the current schema. Answers written before think_ms
 * existed carry no reliable think time and had their elapsed clock polluted by
 * distraction, so they are marked `time_excluded` on upgrade — the datapoint
 * still counts for eval accuracy, just not for time analysis.
 */
export function normalizeAnswer(a: CalibrationAnswer): CalibrationAnswer {
  const hasThink = "think_ms" in (a as object)
  return {
    ...a,
    think_ms: hasThink ? a.think_ms : null,
    time_excluded: hasThink ? a.time_excluded ?? false : true,
    answer_locked_at: a.answer_locked_at ?? 0,
    revised_eval: a.revised_eval ?? null,
    revision_note: a.revision_note ?? null,
    revised_at: a.revised_at ?? null,
    coach: a.coach ?? null,
  }
}

/**
 * Build the coach's input from a locked answer + its position. Tolerates v1
 * sessions still live in localStorage: their positions predate `to_move` and
 * the other v2 game-context fields, and Rust's `CoachInput` requires `to_move`
 * — a dropped-undefined key fails the whole invoke before any API call. The
 * FEN always carries the side to move, so derive it from there, and send
 * explicit nulls for the v2-only fields.
 */
export function coachInputFor(answer: CalibrationAnswer, position: CalibrationPosition): CoachInput {
  return {
    fen: position.fen,
    to_move: position.fen.split(" ")[1] === "b" ? "black" : "white",
    sf_cp: position.sf_cp,
    sf_mate: position.sf_mate,
    sf_best_san: position.sf_best_san,
    sf_best_uci: position.sf_best_uci,
    multipv_gap_cp: position.multipv_gap_cp,
    material: position.material,
    user_eval: answer.eval,
    user_why: answer.why ?? "",
    user_move_uci: answer.move_uci ?? null,
    revised_eval: answer.revised_eval ?? null,
    revision_note: answer.revision_note ?? null,
    played_san: position.played_san ?? null,
    continuation_san: position.continuation_san ?? null,
    white_elo: position.white_elo ?? null,
    black_elo: position.black_elo ?? null,
  }
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

/**
 * Ask Claude to critique the user's written reasoning for one position. Rejects
 * (with an error message the UI shows as a one-line hint) when there's no API
 * key or the request fails, so it never blocks the reveal. Outside Tauri a mock
 * returns a canned critique.
 */
export function coachFeedback(input: CoachInput): Promise<CoachFeedback> {
  if (!isTauri()) {
    return import("./calibration-mock").then((m) => m.mockCoachFeedback(input))
  }
  return invoke<CoachFeedback>("coach_feedback", { input })
}

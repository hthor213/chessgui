// Typed wrappers over the Eval Calibration backend (spec 213 data collection).
//
// Mirrors the Rust structs and `calibration_*` Tauri commands in
// src-tauri/src/calibration.rs. Struct fields are snake_case to match serde's
// wire shape; command argument names are camelCase (Tauri maps them to the Rust
// snake_case parameters).
//
// Provider seam (spec 220 step 2): these delegate to the registered
// EngineProvider — Tauri `invoke` on desktop; in a plain browser (Playwright,
// unit tests) sampling routes to the in-memory mock so the whole Learn flow
// is drivable headless.

import { getProviders } from "@/lib/platform"

// ---------------------------------------------------------------------------
// Types mirroring the Rust structs
// ---------------------------------------------------------------------------

// Extracted to @chessgui/core (spec 220 step 5); re-exported so existing
// importers keep working. The elicitation constants and session math below
// stay here — core holds the types the platform seam needs.
import type {
  BandStat,
  CalibrationAnswer,
  CalibrationPosition,
  CalibrationProgress,
  CalibrationResults,
  CalibrationSession,
  CalibrationSummary,
  CoachFeedback,
  CoachInput,
  DeckStat,
  EvalRange,
  LabelerProfile,
  Miss,
  PhaseStat,
  ProfilePhaseCell,
} from "@chessgui/core/calibration-types"
export type {
  BandStat,
  CalibrationAnswer,
  CalibrationPosition,
  CalibrationProgress,
  CalibrationResults,
  CalibrationSession,
  CalibrationSummary,
  CoachFeedback,
  CoachInput,
  DeckStat,
  EvalRange,
  LabelerProfile,
  Miss,
  PhaseStat,
  ProfilePhaseCell,
}

// ---------------------------------------------------------------------------
// Range elicitation (spec 213 Phase 0)
// ---------------------------------------------------------------------------


/** The six positive-side log-spaced ranges (Weber-Fechner spacing — nobody
 *  distinguishes 1.6 from 1.8, so a point answer adds pure input noise):
 *  0.1–0.3, 0.3–0.6, 0.6–1, 1–2, 2–4, 4+. The UI mirrors them for Black. */
export const POSITIVE_RANGES: EvalRange[] = [
  { lo: 0.1, hi: 0.3 },
  { lo: 0.3, hi: 0.6 },
  { lo: 0.6, hi: 1 },
  { lo: 1, hi: 2 },
  { lo: 2, hi: 4 },
  { lo: 4, hi: null },
]

/** The level range — fills the ±0.1 gap the mirrored log-spaced ranges leave
 *  around zero ("no one is better"). */
export const LEVEL_RANGE: EvalRange = { lo: -0.1, hi: 0.1 }

/** All thirteen answer ranges, most-Black-favouring first: the mirrored
 *  negatives, the level range, then the positives. */
export const EVAL_RANGES: EvalRange[] = [
  ...POSITIVE_RANGES.map((r): EvalRange => ({
    lo: r.hi == null ? null : -r.hi,
    hi: -(r.lo as number),
  })).reverse(),
  LEVEL_RANGE,
  ...POSITIVE_RANGES,
]

/** Representative point of a range — midpoint, or the finite edge when one
 *  side is unbounded. Used for the derived `eval` on range answers so every
 *  point-based consumer (correlation, scatter, coach fallback) keeps working;
 *  it is derived, NOT what the user asserted — the range is. */
export function rangePoint(r: EvalRange): number {
  if (r.lo == null) return r.hi as number
  if (r.hi == null) return r.lo
  return (r.lo + r.hi) / 2
}

/** The range an answer asserted, or null for point/skipped answers (v1/v2
 *  elicitation or pre-range sessions). Every real range has at least one
 *  finite bound, so both-null unambiguously means "no range". */
export function answerRange(a: CalibrationAnswer): EvalRange | null {
  if (a.eval_lo == null && a.eval_hi == null) return null
  return { lo: a.eval_lo ?? null, hi: a.eval_hi ?? null }
}


/** Fewer than this many answers in a phase → its metrics are too thin to read
 *  much into; the UI flags it. */
export const MIN_PHASE_N = 8

// ---------------------------------------------------------------------------
// Plan elicitation (spec 213 Phase 0)
// ---------------------------------------------------------------------------

/** The v3 decks on which "what's the plan for the side to move?" is asked
 *  before the eval — the spec's own examples ("queenside minority attack",
 *  "trade into the pawn endgame") are conversion/endgame plans, and those are
 *  the decks where plan direction (not tactics) decides the position. Asking
 *  on a deck subset mildly hints the deck (a middlegame with a plan prompt is
 *  conversion), accepted by the spec's "on selected decks, before the eval";
 *  endgame is board-visible anyway. */
export const PLAN_DECKS = ["conversion", "endgame"] as const

/** Whether this position's deck asks for a plan. v1/v2 positions carry no
 *  deck and never ask. */
export function asksPlan(pos: CalibrationPosition): boolean {
  return pos.deck != null && (PLAN_DECKS as readonly string[]).includes(pos.deck)
}



/** On-disk schema version this build writes (v2 added known-Elo game context;
 *  v3 added range elicitation: `elicitation` + per-answer `eval_lo`/`eval_hi`;
 *  v4 adds Phase-A profile lock-in: `lock_in_n` + `profile_prior`, and the
 *  embedded session's positions may be lock-in-reordered relative to the
 *  sampler's `session-*.json`; v5 adds plan elicitation: `plan_decks` +
 *  per-answer `plan`/`plan_b` + coach `plan_grade`; v6 adds Phase-B adaptive
 *  selection: `phase_b` — post-burst positions are model-chosen, so the
 *  embedded session's order diverges further from the sampler artifact). */
export const RESULTS_VERSION = 6

// ---------------------------------------------------------------------------
// Provider seam
// ---------------------------------------------------------------------------

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
    // Pre-range answers were points and STAY points — never reinterpreted as
    // ranges (spec 213: range answers arrive at new-session boundaries only).
    eval_lo: a.eval_lo ?? null,
    eval_hi: a.eval_hi ?? null,
    // Pre-plan answers never asked for a plan; explicit nulls, like the ranges.
    plan: a.plan ?? null,
    plan_b: a.plan_b ?? null,
    revised_eval: a.revised_eval ?? null,
    revision_note: a.revision_note ?? null,
    revised_at: a.revised_at ?? null,
    coach: a.coach ?? null,
    rebuttal: a.rebuttal ?? null,
    coach_reply: a.coach_reply ?? null,
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
    // Explicit nulls (never dropped keys) on point answers; Rust's
    // #[serde(default)] tolerates both.
    user_eval_lo: answer.eval_lo ?? null,
    user_eval_hi: answer.eval_hi ?? null,
    user_why: answer.why ?? "",
    user_plan: answer.plan ?? null,
    user_plan_b: answer.plan_b ?? null,
    user_move_uci: answer.move_uci ?? null,
    revised_eval: answer.revised_eval ?? null,
    revision_note: answer.revision_note ?? null,
    played_san: position.played_san ?? null,
    continuation_san: position.continuation_san ?? null,
    white_elo: position.white_elo ?? null,
    black_elo: position.black_elo ?? null,
    sf_pv_san: position.sf_pv_san ?? null,
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
  return getProviders().engine.calibrationSample(n, opts, onProgress)
}

/**
 * Persist a completed result to the app's calibration directory, returning the
 * written path. Outside Tauri this is a no-op (returns "").
 */
export function saveResults(results: CalibrationResults): Promise<string> {
  return getProviders().engine.calibrationSaveResults(results)
}

/**
 * Load every previously saved results file (oldest first) — the labeler-profile
 * prior for Phase-A lock-in (spec 213 adaptive elicitation): returning users'
 * sessions open with a shorter (or no) lock-in burst. Outside Tauri the mock
 * reads an optional localStorage seed so the flow stays drivable headless.
 */
export function loadPriorResults(): Promise<CalibrationResults[]> {
  return getProviders().engine.calibrationLoadResults()
}

/**
 * Ask Claude to critique the user's written reasoning for one position. Rejects
 * (with an error message the UI shows as a one-line hint) when there's no API
 * key or the request fails, so it never blocks the reveal. Outside Tauri a mock
 * returns a canned critique.
 */
export function coachFeedback(input: CoachInput): Promise<CoachFeedback> {
  return getProviders().engine.coachFeedback(input)
}

/**
 * One follow-up round: send the user's rebuttal to the coach's note and get a
 * single grounded reply. Same degrade-to-hint contract as coachFeedback.
 * Outside Tauri a mock returns a canned reply.
 */
export function coachFollowup(input: CoachInput, note: string, rebuttal: string): Promise<string> {
  return getProviders().engine.coachFollowup(input, note, rebuttal)
}

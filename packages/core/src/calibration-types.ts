// Eval-calibration domain types (spec 213) — extracted to @chessgui/core
// (spec 220 step 5). Mirrors src-tauri/src/calibration.rs; the elicitation
// constants and session math stay in lib/calibration.ts.

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
  // --- v3: training-value stratification + engine line (optional; v1/v2
  //     sessions lack them). ---
  /** Training deck: "conversion" | "critical" | "endgame" | "level". */
  deck?: string
  /** Stockfish's best-play line (PV1), SAN, up to 6 plies. */
  sf_pv_san?: string[]
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
/** One log-spaced answer range in pawns, White-POV. A `null` bound is
 *  unbounded ("+4 or more" → `{ lo: 4, hi: null }`). Every defined range has
 *  at least one finite bound. */
export type EvalRange = { lo: number | null; hi: number | null }
/** The user's response to one position. */
export type CalibrationAnswer = {
  /** Index of the position within the session. */
  index: number
  /** Perceived eval in pawns (+ = White better); null if skipped. On
   *  range-elicitation answers this is a DERIVED representative point
   *  (`rangePoint`) kept for point back-compat — `eval_lo`/`eval_hi` are the
   *  actual assertion. */
  eval: number | null
  /** Range elicitation (spec 213): the asserted range's bounds in pawns,
   *  White-POV; a null side is unbounded ("4+"). Both null/absent = a point
   *  answer (pre-range session) or a skip. Never retrofitted onto stored
   *  point answers. */
  eval_lo?: number | null
  eval_hi?: number | null
  /** One-or-two-sentence reason. */
  why: string
  /** Plan elicitation (spec 213, v5): the user's one-line plan for the side to
   *  move, asked BEFORE the eval on plan decks (see PLAN_DECKS). Null when the
   *  position's deck doesn't ask for one, on skips, and on pre-v5 answers. */
  plan?: string | null
  /** Optional backup plan ("plan B"), same lifecycle as `plan`. */
  plan_b?: string | null
  /** UCI of the move they'd play, or null if they didn't pick one. */
  move_uci: string | null
  /** Line verification, 1-PLY (2026-07-16): White-POV engine eval of the
   *  user's move (searchmoves-restricted, same budget as the stored
   *  best-move eval), attached async at grading time. Null until it arrives,
   *  when no move was chosen, or if the engine was unavailable. */
  played_move_eval_cp?: number | null
  played_move_eval_mate?: number | null
  /** Mover-POV gap of their move vs the stored best move, centipawns
   *  (positive = worse than best); null when either score is a mate. */
  gap_to_best_cp?: number | null
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
  /** The user's reply to the coach's note ("I saw that move but…"), or null.
   *  First-class data: it separates "didn't see it" from "saw it and rejected
   *  it for a reason" — a different error class the note alone can't reach. */
  rebuttal: string | null
  /** The coach's one follow-up reply to the rebuttal, or null. */
  coach_reply: string | null
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
  /** Plan elicitation (spec 213, v5): the coach's grade of the stated plan's
   *  DIRECTION vs the engine line, separate from the eval number — "aligned" |
   *  "partial" | "wrong" | "unclear" | "no_plan". Absent on pre-plan feedback. */
  plan_grade?: string | null
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
  /** Range elicitation: the asserted range's bounds (null side = unbounded;
   *  both null = point answer). The coach critiques what was actually
   *  asserted — the range, not the derived point. */
  user_eval_lo: number | null
  user_eval_hi: number | null
  user_why: string
  /** Plan elicitation (spec 213, v5): the user's stated plan (and optional
   *  plan B) for the side to move; null when the deck didn't ask for one. */
  user_plan: string | null
  user_plan_b: string | null
  user_move_uci: string | null
  /** Line verification, 1-PLY: White-POV engine eval of the user's move and
   *  its mover-POV gap to best, when graded (see CalibrationAnswer). */
  user_move_eval_cp: number | null
  user_move_eval_mate: number | null
  user_move_gap_cp: number | null
  revised_eval: number | null
  revision_note: string | null
  played_san: string | null
  continuation_san: string[] | null
  white_elo: number | null
  black_elo: number | null
  sf_pv_san: string[] | null
}

// ---------------------------------------------------------------------------
// Line verification (2026-07-16) — mirrors Rust verify.rs
// ---------------------------------------------------------------------------

/** The 1-ply engine read of the user's chosen move. Mirrors Rust
 *  `PlayedMoveEval`. Evals are White-POV, like everything else. */
export type PlayedMoveEval = {
  eval_cp: number | null
  eval_mate: number | null
  /** Mover-POV gap to the stored best move, centipawns (positive = worse);
   *  null when either score is a mate. */
  gap_to_best_cp: number | null
}

/** One verified ply of a walked line. Mirrors Rust `VerifiedPly`. */
export type VerifiedPly = {
  san: string
  uci: string
  fen_after: string
  /** White-POV eval of the position AFTER this move. */
  eval_cp: number | null
  eval_mate: number | null
  /** "checkmate" | "stalemate" when this move ends the game; null otherwise. */
  terminal: string | null
}

/** The verdict on a proposed variation. Mirrors Rust `LineVerification`. An
 *  illegal move is a verdict (named here), never a rejection. */
export type LineVerification = {
  legal: boolean
  illegal_at: number | null
  illegal_move: string | null
  start_cp: number | null
  start_mate: number | null
  plies: VerifiedPly[]
  end_cp: number | null
  end_mate: number | null
  delta_cp: number | null
  ends_in_mate: boolean
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

/** Per-deck accuracy row (v3 training-value decks: conversion / critical /
 *  endgame / level). Same depth as a phase row — the deck IS the training
 *  axis, so correlation and move accuracy matter per deck. All counts are 0
 *  on v1/v2 sessions, whose positions carry no deck; the UI hides the table
 *  then. */
export type DeckStat = {
  deck: string
  count: number
  mae: number | null
  pearson: number | null
  bestMoveHitRate: number | null
  /** Positions in this deck on which the user chose a move. */
  moveAnswers: number
}

/** A position the user was furthest off on. */
export type Miss = {
  index: number
  fen: string
  band: string
  /** The asserted point, or the range's derived representative point. */
  userEval: number
  /** The asserted range (range-elicitation sessions), else null. */
  userRange: EvalRange | null
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
  /** v3 training-deck rows; all-zero counts on v1/v2 sessions. */
  perDeck: DeckStat[]
  /** Plan elicitation (spec 213, v5): `given` counts answers that stated a
   *  plan; the grade counts cover only coach-graded ones ("unclear"/"no_plan"
   *  and ungraded answers excluded). All zero on pre-plan sessions. */
  planDirection: { given: number; aligned: number; partial: number; wrong: number }
  biggestMisses: Miss[]
}
// ---------------------------------------------------------------------------
// Labeler profile (spec 213 adaptive elicitation, Phase A)
// ---------------------------------------------------------------------------

/** One phase of the labeler's skill vector. */
export type ProfilePhaseCell = {
  phase: string
  /** Usable (answered, eval-given) answers in this phase, across sessions. */
  count: number
  /** Mean absolute error in pawns, or null with no answers. */
  mae: number | null
  /** Mean signed error (user − SF, pawns; + = White-optimistic), or null. */
  bias: number | null
}

/** The labeler's established profile — who is producing the labels (design doc
 *  §6.1: "a ~1300 with a 1500-ish endgame perceived this as +1.2" is data; an
 *  anonymous "+1.2" is not). Built from saved results files and merged exactly
 *  across sessions; Phase-A lock-in fills whichever phase is least pinned. */
export type LabelerProfile = {
  /** Completed sessions folded into this profile. */
  sessions: number
  /** Usable answers across them. */
  answers: number
  /** Overall mean signed error, or null with no answers. */
  bias: number | null
  /** Population std-dev of the signed error, or null with no answers. */
  sd: number | null
  /** Per-phase skill vector, in PHASES order. */
  per_phase: ProfilePhaseCell[]
}

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
  /**
   * How evals were elicited this session: `"point"` (typed number, v1/v2) or
   * `"range"` (log-spaced range buttons, spec 213 range elicitation). Fixed at
   * session creation and never mixed mid-session — mixing point and range
   * answers muddies the per-player curve. Absent on pre-v3 files ⇒ point.
   */
  elicitation: "point" | "range"
  /**
   * Phase-A profile lock-in (spec 213 adaptive elicitation, v4): how many
   * positions at the head of the session were the lock-in burst — chosen to
   * pin the labeler's least-pinned phase. 0 when the prior profile was
   * already locked. Absent on pre-v4 files (which had no lock-in).
   */
  lock_in_n?: number
  /**
   * Phase A (v4): the labeler profile computed from all PRIOR saved results
   * at session start — the lock-in prior, i.e. who the labeler was believed
   * to be BEFORE this session's answers. Null/absent when there were none.
   */
  profile_prior?: LabelerProfile | null
  /**
   * Plan elicitation (spec 213, v5): the decks on which "what's the plan?" was
   * asked this session ([] = plans not asked, e.g. a resumed pre-plan session
   * — plans switch on at new-session boundaries only). Absent on pre-v5 files.
   */
  plan_decks?: string[]
  /**
   * Phase-B adaptive selection (spec 213 adaptive elicitation, v6): present
   * (non-null) when positions after the lock-in burst were model-chosen —
   * each next slot filled by evaluator-variant disagreement (tier-1 Eval_R
   * swept at `bands`) blended with (phase × |eval| band) coverage sparsity.
   * `spreads` is each position's max−min Eval_R in pawns across `bands` at
   * selection time, aligned with session.positions; a null entry was never
   * scored (tier-1 unavailable, or the prefetcher hadn't reached it).
   * Null/absent = fixed presentation order (pre-v6 file, or a resumed
   * pre-Phase-B session — selection switches on at new-session boundaries
   * only). NOTE the §6.4 caveat: adaptively-ordered answers bias naive
   * sequential statistics; per-cell aggregates should account for this
   * selection record.
   */
  phase_b?: { bands: number[]; spreads: (number | null)[] } | null
  session: CalibrationSession
  /** Answers in presentation order (each carries its `index`), so learning /
   *  drift effects over the session are analysable. */
  answers: CalibrationAnswer[]
  summary: CalibrationSummary
}

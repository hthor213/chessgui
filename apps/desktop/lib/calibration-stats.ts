// Scoring for a completed calibration session: user perception vs Stockfish.
//
// Pure functions, no React or Tauri — unit-tested in __tests__/calibration.test.ts
// and reused by components/calibration-tab.tsx to render the results screen.

import { answerRange, rangePoint } from "./calibration"
import type {
  BandStat,
  CalibrationAnswer,
  CalibrationPosition,
  CalibrationSession,
  CalibrationSummary,
  DeckStat,
  EvalRange,
  Miss,
  PhaseStat,
} from "./calibration"

/** Mate is capped to this many pawns for numeric comparison, so a single mate
 *  score can't dominate the correlation or the error mean. */
export const MATE_PAWNS = 12

/** The four |SF eval| bands, in order — the fixed rows of the per-band table. */
export const BANDS = ["0-0.5", "0.5-1.5", "1.5-3", "3+"] as const

/** The two game phases, in order — the fixed rows of the per-phase table. */
export const PHASES = ["middlegame", "endgame"] as const

/** The v3 training decks, in quota order — the fixed rows of the per-deck
 *  table. Mirrors DECK_LABELS in src-tauri/src/calibration.rs. */
export const DECKS = ["conversion", "critical", "endgame", "level"] as const

/** Stockfish eval for a position, in pawns (White-POV), clamped to ±MATE_PAWNS. */
export function sfEvalPawns(p: CalibrationPosition): number {
  if (p.sf_mate != null && p.sf_mate !== 0) {
    return p.sf_mate > 0 ? MATE_PAWNS : -MATE_PAWNS
  }
  const pawns = (p.sf_cp ?? 0) / 100
  return Math.max(-MATE_PAWNS, Math.min(MATE_PAWNS, pawns))
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** Median of a list, or null if empty. */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Pearson correlation of two equal-length series. Returns null when there are
 * fewer than two points or either series is constant (correlation undefined).
 */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length
  if (n < 2 || ys.length !== n) return null
  const mx = mean(xs)
  const my = mean(ys)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  const denom = Math.sqrt(sxx * syy)
  if (denom === 0) return null
  return sxy / denom
}

/** Range-aware error: 0 when `sfEval` falls inside the asserted range, else
 *  the distance to the nearest range edge (spec 213 range elicitation — the
 *  user asserted an interval, so only leaving it is an error). */
export function rangeError(sfEval: number, r: EvalRange): number {
  if (r.lo != null && sfEval < r.lo) return r.lo - sfEval
  if (r.hi != null && sfEval > r.hi) return sfEval - r.hi
  return 0
}

/** One answered, non-skipped position paired with its numbers. */
export type Scored = {
  index: number
  pos: CalibrationPosition
  answer: CalibrationAnswer
  /** The asserted point, or the range's representative point (derived). */
  userEval: number
  /** The asserted range, or null on point answers. */
  userRange: EvalRange | null
  sfEval: number
  /** Point answers: |user − SF|. Range answers: distance from the range edge,
   *  0 inside. */
  absError: number
}

/** Zip the session's positions with the user's usable (answered, non-skipped,
 *  eval given) responses. */
export function scoredAnswers(
  session: CalibrationSession,
  answers: CalibrationAnswer[],
): Scored[] {
  const out: Scored[] = []
  for (const a of answers) {
    const userRange = answerRange(a)
    const point = a.eval ?? (userRange ? rangePoint(userRange) : null)
    if (a.skipped || point == null) continue
    const pos = session.positions[a.index]
    if (!pos) continue
    const sfEval = sfEvalPawns(pos)
    out.push({
      index: a.index,
      pos,
      answer: a,
      userEval: point,
      userRange,
      sfEval,
      absError: userRange ? rangeError(sfEval, userRange) : Math.abs(point - sfEval),
    })
  }
  return out
}

/** Accuracy metrics over a subset of scored answers — MAE, correlation, and
 *  best-move hit rate, each null when there isn't enough data. */
export function groupStats(scored: Scored[]): {
  count: number
  mae: number | null
  pearson: number | null
  bestMoveHitRate: number | null
  moveAnswers: number
} {
  const withMove = scored.filter((s) => s.answer.move_uci != null)
  const hits = withMove.filter((s) => s.answer.move_uci === s.pos.sf_best_uci).length
  return {
    count: scored.length,
    mae: scored.length ? mean(scored.map((s) => s.absError)) : null,
    pearson: pearson(
      scored.map((s) => s.userEval),
      scored.map((s) => s.sfEval),
    ),
    bestMoveHitRate: withMove.length ? hits / withMove.length : null,
    moveAnswers: withMove.length,
  }
}

/** Full results summary: correlation, error, per-band + per-phase tables, move
 *  hit-rate, and the biggest misses (up to `missCount`, default 10). */
export function summarize(
  session: CalibrationSession,
  answers: CalibrationAnswer[],
  missCount = 10,
): CalibrationSummary {
  const scored = scoredAnswers(session, answers)
  const skipped = answers.filter((a) => a.skipped).length

  const overall = groupStats(scored)

  const perBand: BandStat[] = BANDS.map((band) => {
    const inBand = scored.filter((s) => s.pos.band === band)
    return {
      band,
      count: inBand.length,
      mae: inBand.length ? mean(inBand.map((s) => s.absError)) : null,
    }
  })

  const perPhase: PhaseStat[] = PHASES.map((phase) => ({
    phase,
    ...groupStats(scored.filter((s) => s.pos.phase === phase)),
  }))

  // v3 training decks. Positions from v1/v2 sessions carry no deck, so every
  // row counts 0 there — old sessions keep summarizing (never discarded on a
  // schema upgrade), they just have no deck breakdown to show.
  const perDeck: DeckStat[] = DECKS.map((deck) => ({
    deck,
    ...groupStats(scored.filter((s) => s.pos.deck === deck)),
  }))

  // Think time: median over answers whose time counts and who actually
  // interacted before advancing. Excluded/pre-upgrade answers still count for
  // eval accuracy above; they're only omitted from time analysis here.
  const timeExcludedCount = answers.filter((a) => a.time_excluded).length
  const thinkTimes = answers
    .filter((a) => !a.time_excluded && a.think_ms != null)
    .map((a) => a.think_ms as number)
  const medianThinkMs = median(thinkTimes)

  const biggestMisses: Miss[] = [...scored]
    .sort((a, b) => b.absError - a.absError)
    .slice(0, missCount)
    .map((s) => ({
      index: s.index,
      fen: s.pos.fen,
      band: s.pos.band,
      userEval: s.userEval,
      userRange: s.userRange,
      sfEval: s.sfEval,
      absError: s.absError,
    }))

  return {
    answered: scored.length,
    skipped,
    moveAnswers: overall.moveAnswers,
    pearson: overall.pearson,
    mae: overall.mae,
    bestMoveHitRate: overall.bestMoveHitRate,
    medianThinkMs,
    timeExcludedCount,
    perBand,
    perPhase,
    perDeck,
    biggestMisses,
  }
}

/** Format a pawn eval the way the user types it: signed, one decimal, "0" flat. */
export function formatPawns(v: number): string {
  if (Math.abs(v) < 0.05) return "0"
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`
}

/** Format an asserted range, White-POV: "+1.0 to +2.0", "+4.0 or more",
 *  "-4.0 or less". Bounds keep their sign so the level range reads
 *  "-0.1 to +0.1". */
export function formatRange(r: EvalRange): string {
  const fmt = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`
  if (r.lo == null) return `${fmt(r.hi as number)} or less`
  if (r.hi == null) return `${fmt(r.lo)} or more`
  return `${fmt(r.lo)} to ${fmt(r.hi)}`
}

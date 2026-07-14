// Scoring for a completed calibration session: user perception vs Stockfish.
//
// Pure functions, no React or Tauri — unit-tested in __tests__/calibration.test.ts
// and reused by components/calibration-tab.tsx to render the results screen.

import type {
  BandStat,
  CalibrationAnswer,
  CalibrationPosition,
  CalibrationSession,
  CalibrationSummary,
  Miss,
} from "./calibration"

/** Mate is capped to this many pawns for numeric comparison, so a single mate
 *  score can't dominate the correlation or the error mean. */
export const MATE_PAWNS = 12

/** The four |SF eval| bands, in order — the fixed rows of the per-band table. */
export const BANDS = ["0-0.5", "0.5-1.5", "1.5-3", "3+"] as const

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

/** One answered, non-skipped position paired with its numbers. */
export type Scored = {
  index: number
  pos: CalibrationPosition
  answer: CalibrationAnswer
  userEval: number
  sfEval: number
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
    if (a.skipped || a.eval == null) continue
    const pos = session.positions[a.index]
    if (!pos) continue
    const sfEval = sfEvalPawns(pos)
    out.push({
      index: a.index,
      pos,
      answer: a,
      userEval: a.eval,
      sfEval,
      absError: Math.abs(a.eval - sfEval),
    })
  }
  return out
}

/** Full results summary: correlation, error, per-band table, move hit-rate, and
 *  the biggest misses (up to `missCount`, default 10). */
export function summarize(
  session: CalibrationSession,
  answers: CalibrationAnswer[],
  missCount = 10,
): CalibrationSummary {
  const scored = scoredAnswers(session, answers)
  const skipped = answers.filter((a) => a.skipped).length

  const pearsonR = pearson(
    scored.map((s) => s.userEval),
    scored.map((s) => s.sfEval),
  )
  const mae = scored.length ? mean(scored.map((s) => s.absError)) : null

  // Best-move hit rate over answers that picked a move.
  const withMove = scored.filter((s) => s.answer.move_uci != null)
  const hits = withMove.filter((s) => s.answer.move_uci === s.pos.sf_best_uci).length
  const bestMoveHitRate = withMove.length ? hits / withMove.length : null

  const perBand: BandStat[] = BANDS.map((band) => {
    const inBand = scored.filter((s) => s.pos.band === band)
    return {
      band,
      count: inBand.length,
      mae: inBand.length ? mean(inBand.map((s) => s.absError)) : null,
    }
  })

  const biggestMisses: Miss[] = [...scored]
    .sort((a, b) => b.absError - a.absError)
    .slice(0, missCount)
    .map((s) => ({
      index: s.index,
      fen: s.pos.fen,
      band: s.pos.band,
      userEval: s.userEval,
      sfEval: s.sfEval,
      absError: s.absError,
    }))

  return {
    answered: scored.length,
    skipped,
    moveAnswers: withMove.length,
    pearson: pearsonR,
    mae,
    bestMoveHitRate,
    perBand,
    biggestMisses,
  }
}

/** Format a pawn eval the way the user types it: signed, one decimal, "0" flat. */
export function formatPawns(v: number): string {
  if (Math.abs(v) < 0.05) return "0"
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`
}

// Trajectory projection for the Training tab (spec 215, Tier 2).
//
// Projects the user's measured metric trajectory (dated MetricPoints) toward
// the milestone date, and frames the projected gap as an expected match score
// (the win-prob framing spec 215 borrows from 212's honest-probability idea —
// spec:212's curve itself maps engine EVALS to win-prob and doesn't apply to
// rating gaps, so the rating→expected-score map here is the standard Elo
// logistic, stated as such).
//
// Honest-by-design rules:
// - A projection needs >= 2 measurements at distinct dates; with fewer, every
//   helper returns null and the UI says "not enough data" instead of drawing
//   a line through one point.
// - The fit is a plain least-squares line through the dated points — the
//   simplest model that can be stated in one sentence. The UI labels the
//   result "projection", never "forecast" or a measured value.
// - Nothing here clamps the projected value to look better; the chart clamps
//   only its viewport, never the number.

import type { MetricKey, MetricPoint } from "@/lib/training-program"

const DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Dated points
// ---------------------------------------------------------------------------

export interface TrendPoint {
  /** Epoch ms of the measurement. */
  t: number
  v: number
}

/**
 * Metric-point date label → epoch ms. Monthly labels (YYYY-MM) resolve to the
 * 15th of the month (the cadence is monthly; mid-month is the unbiased pick),
 * full dates (YYYY-MM-DD) to that date. Anything else → null.
 */
export function metricTime(at: string): number | null {
  const trimmed = at.trim()
  let iso: string
  if (/^\d{4}-\d{2}$/.test(trimmed)) iso = `${trimmed}-15`
  else if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) iso = trimmed
  else return null
  const t = Date.parse(`${iso}T00:00:00Z`)
  return Number.isFinite(t) ? t : null
}

/** The dated points of one metric, ascending in time. Points with unparseable
 *  dates are skipped. When one date label carries several values (re-entered
 *  measurements), the LAST one wins — matching latestMetric's append-order rule. */
export function metricTrendPoints(points: MetricPoint[], metric: MetricKey): TrendPoint[] {
  const byTime = new Map<number, number>()
  for (const p of points) {
    if (p.metric !== metric) continue
    const t = metricTime(p.at)
    if (t === null || !Number.isFinite(p.value)) continue
    byTime.set(t, p.value)
  }
  return [...byTime.entries()]
    .map(([t, v]) => ({ t, v }))
    .sort((a, b) => a.t - b.t)
}

// ---------------------------------------------------------------------------
// Linear trend
// ---------------------------------------------------------------------------

export interface Trend {
  /** Least-squares slope, in metric units per day. */
  slopePerDay: number
  /** Value at t = 0 (epoch) — use valueAt, not this, for readable numbers. */
  intercept: number
  n: number
}

/** Least-squares line through the points. Null with < 2 points or when all
 *  points share one date (slope undefined). */
export function fitTrend(pts: TrendPoint[]): Trend | null {
  if (pts.length < 2) return null
  const n = pts.length
  // Center time to keep the normal equations well-conditioned (epoch-ms
  // squares overflow doubles' exact range comfortably but lose precision).
  const tMean = pts.reduce((s, p) => s + p.t, 0) / n
  const vMean = pts.reduce((s, p) => s + p.v, 0) / n
  let num = 0
  let den = 0
  for (const p of pts) {
    const dt = p.t - tMean
    num += dt * (p.v - vMean)
    den += dt * dt
  }
  if (den === 0) return null
  const slopePerMs = num / den
  return {
    slopePerDay: slopePerMs * DAY_MS,
    intercept: vMean - slopePerMs * tMean,
    n,
  }
}

export function valueAt(trend: Trend, t: number): number {
  return trend.intercept + (trend.slopePerDay / DAY_MS) * t
}

// ---------------------------------------------------------------------------
// Projection to the milestone
// ---------------------------------------------------------------------------

export interface Projection {
  /** Measured points the fit ran through (ascending). */
  measured: TrendPoint[]
  trend: Trend | null
  /** Milestone epoch ms, null when no (valid) date is set. */
  targetT: number | null
  /** Projected metric value AT the milestone date; null without trend+date. */
  projected: number | null
}

export function projectMetric(
  points: MetricPoint[],
  metric: MetricKey,
  milestoneISO: string | null,
): Projection {
  const measured = metricTrendPoints(points, metric)
  const trend = fitTrend(measured)
  const targetT = milestoneISO ? metricTime(milestoneISO) : null
  const projected = trend !== null && targetT !== null ? valueAt(trend, targetT) : null
  return { measured, trend, targetT, projected }
}

// ---------------------------------------------------------------------------
// Rating gap → expected score (Elo logistic, stated as the assumption it is)
// ---------------------------------------------------------------------------

/** Standard Elo expected score for a `diff` = (own − opponent) rating gap. */
export function expectedScoreElo(diff: number): number {
  return 1 / (1 + Math.pow(10, -diff / 400))
}

/** "At current pace: X wins in 10 expected" — expected score vs an
 *  `oppElo`-level opponent, scaled to a 10-game match, one decimal. */
export function winsPerTen(ownElo: number, oppElo: number): number {
  return Math.round(expectedScoreElo(ownElo - oppElo) * 100) / 10
}

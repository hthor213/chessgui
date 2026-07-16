// Rolling avoidance-Elo estimate with honest uncertainty (spec 224).
//
// "Unfinished Session: Elo 1238 ± 250" — the Learn surface's answer to "how
// strong am I right now, on the evidence I've actually produced?". The model
// (specs/224-learn-elo-estimate.md "How"): a recency-weighted maximum-
// likelihood PERFORMANCE RATING over the avoidance-puzzle attempt log. Each
// attempt's band is its puzzle rating rᵢ; under the house Elo expected-score
// curve p(θ−rᵢ) = 1/(1+10^(−(θ−rᵢ)/400)) (lib/training-projection.ts
// expectedScoreElo), the estimate θ̂ is the root of the weighted score
// equation Σ wᵢ(xᵢ − pᵢ(θ)) = 0 — the FIDE dp inversion
// (lib/explorer-stats.ts eloDifferenceForScore) generalized to per-puzzle
// ratings with weights.
//
// The whole design tension (224 "Why an adaptive window"): follow a breakout
// fast — an all-time average buries 30 fresh 1850 solves under 200 stale
// 1700 ones — while the ± honestly reports how thin the recent evidence is.
// Hence exponential recency decay inside an ADAPTIVE window, and a sandwich
// (robust) standard error whose effective sample size shrinks with the decay.
//
// Pooling rules (224 "Category handling"): bands are the rating axis, so
// combining across bands IS the estimate — never a solve-rate averaged across
// bands. rake+calm form one avoidance pool. Null-band attempts carry no
// rating and are excluded. Pure module: no React, no storage, no I/O.

// ---------------------------------------------------------------------------
// Tunables (spec 224 "How" — the ~ values, pinned here)
// ---------------------------------------------------------------------------

/** Below this many band-carrying attempts the estimator refuses to guess
 *  (224 "Sparse data refuses to guess"). */
export const MIN_WINDOW = 15

/** Adaptive-window target: smallest recent-N whose standard error is at or
 *  under this many Elo. */
export const SIGMA_TARGET = 180

/** Attempts added on top of the smallest σ-satisfying window (capped by
 *  available data) — keeps the window off the knife edge. */
export const WINDOW_BUFFER = 5

/** 95% band: the reported ± is CI_Z · σ. */
export const CI_Z = 1.96

/** Logistic slope of the Elo curve in natural-log units: d logit(p)/dθ. */
const ELO_K = Math.LN10 / 400

/** MLE search clamp beyond the window's band range — the same ±800 saturation
 *  eloDifferenceForScore applies to a 0% / 100% score. */
const ELO_CLAMP = 800

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal projection of a puzzle-results entry (lib/puzzle-results
 *  PuzzleResultEntry satisfies it structurally). */
export type EloAttempt = {
  /** ISO datetime of the attempt (chronology axis). */
  at: string
  /** Mover-Elo band of the source game, e.g. "1900"; null = no rating. */
  band: string | null
  correct: boolean
}

export type EloEstimate = {
  /** "ok" = a number is warranted; "insufficient" = below MIN_WINDOW. */
  status: "ok" | "insufficient"
  /** MLE performance rating (unrounded); null when insufficient. */
  elo: number | null
  /** Sandwich standard error in Elo; null when insufficient. */
  sigma: number | null
  /** "ok": attempts in the fitted window. "insufficient": usable attempts. */
  n: number
  /** Effective sample size (Σw)²/Σw² of the fitted window; null when
   *  insufficient. The honest "how many puzzles is this really worth". */
  ess: number | null
  /** Band-carrying attempts still needed to reach MIN_WINDOW; 0 when ok. */
  needed: number
}

/** One usable observation: numeric puzzle rating + outcome. */
type Obs = { r: number; x: 0 | 1 }

// ---------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------

/** House Elo expected-score curve (training-projection.ts expectedScoreElo —
 *  restated here because core cannot import the desktop lib). */
export function expectedScoreElo(diff: number): number {
  return 1 / (1 + Math.pow(10, -diff / 400))
}

/**
 * Attempts usable by the fit: band parses to a finite rating and `at` parses
 * to a time (the recency axis). Returned oldest→newest; ties keep log order
 * (the store is an append-only log, so equal timestamps stay chronological).
 */
function usableObs(attempts: readonly EloAttempt[]): Obs[] {
  const timed: { t: number; obs: Obs }[] = []
  for (const a of attempts) {
    if (a.band === null) continue
    const r = Number(a.band)
    if (!Number.isFinite(r)) continue
    const t = Date.parse(a.at)
    if (!Number.isFinite(t)) continue
    timed.push({ t, obs: { r, x: a.correct ? 1 : 0 } })
  }
  // Array.prototype.sort is stable, so same-timestamp entries keep log order.
  return timed.sort((a, b) => a.t - b.t).map((e) => e.obs)
}

/** Exponential recency weights over a window of `n`, newest first:
 *  wₖ = 0.5^(k/n) — half-life ≈ the window size (224 "Recency weighting"). */
function recencyWeights(n: number): number[] {
  const w: number[] = []
  for (let k = 0; k < n; k++) w.push(Math.pow(0.5, k / n))
  return w
}

type WindowFit = { theta: number; sigma: number; ess: number }

/**
 * Recency-weighted MLE over the newest `n` of `obs` (oldest→newest), with the
 * sandwich standard error. The weighted score Σ wᵢ(xᵢ − pᵢ(θ)) is strictly
 * decreasing in θ, so the root is found by bisection over the window's band
 * range ± ELO_CLAMP; an all-solved (all-failed) window saturates at the upper
 * (lower) clamp instead of running to ±∞, exactly like the FIDE dp clamp.
 */
function fitWindow(obs: readonly Obs[], n: number): WindowFit {
  const win = obs.slice(obs.length - n) // oldest→newest within the window
  const w = recencyWeights(n) // w[k] weights the k-th NEWEST
  const weightOf = (i: number) => w[n - 1 - i]

  let lo = Infinity
  let hi = -Infinity
  for (const o of win) {
    lo = Math.min(lo, o.r)
    hi = Math.max(hi, o.r)
  }
  lo -= ELO_CLAMP
  hi += ELO_CLAMP

  const score = (theta: number) => {
    let s = 0
    for (let i = 0; i < win.length; i++) {
      s += weightOf(i) * (win[i].x - expectedScoreElo(theta - win[i].r))
    }
    return s
  }

  let theta: number
  if (score(lo) <= 0) {
    theta = lo // (near-)all-failed: saturate at the lower clamp
  } else if (score(hi) >= 0) {
    theta = hi // (near-)all-solved: saturate at the upper clamp
  } else {
    for (let iter = 0; iter < 60 && hi - lo > 1e-4; iter++) {
      const mid = (lo + hi) / 2
      if (score(mid) > 0) lo = mid
      else hi = mid
    }
    theta = (lo + hi) / 2
  }

  // Sandwich (robust) variance (224 "Uncertainty"): J from Σw·p(1−p), V from
  // Σw²·p(1−p), Var = V/J² — so recency down-weighting genuinely widens the
  // band instead of being ignored.
  let sumW = 0
  let sumW2 = 0
  let j = 0
  let v = 0
  for (let i = 0; i < win.length; i++) {
    const wi = weightOf(i)
    const p = expectedScoreElo(theta - win[i].r)
    const pq = p * (1 - p)
    sumW += wi
    sumW2 += wi * wi
    j += wi * pq
    v += wi * wi * pq
  }
  // J and V each carry one (ln10/400)² factor; Var = V/J² then carries the
  // 1/k² that converts logit curvature back to Elo² units.
  j *= ELO_K * ELO_K
  v *= ELO_K * ELO_K
  const sigma = j > 0 ? Math.sqrt(v / (j * j)) : Infinity
  const ess = sumW2 > 0 ? (sumW * sumW) / sumW2 : 0
  return { theta, sigma, ess }
}

// ---------------------------------------------------------------------------
// The estimator
// ---------------------------------------------------------------------------

/**
 * Rolling performance-rating estimate over the attempt log (spec 224).
 *
 * Adaptive window (224 "Adaptive window size"): the smallest recent-N
 * (N ≥ MIN_WINDOW) whose σ ≤ SIGMA_TARGET, plus WINDOW_BUFFER, capped by the
 * usable data; when no N reaches the target the window is all usable data
 * and the wide σ is reported as-is. The N-scan refits per candidate — O(n²)
 * on a log of hundreds of attempts, microseconds in practice.
 *
 * Below MIN_WINDOW usable attempts: refuses to guess (`status:
 * "insufficient"`, `needed` = the shortfall) rather than overclaim.
 */
export function estimateElo(attempts: readonly EloAttempt[]): EloEstimate {
  const obs = usableObs(attempts)
  if (obs.length < MIN_WINDOW) {
    return {
      status: "insufficient",
      elo: null,
      sigma: null,
      n: obs.length,
      ess: null,
      needed: MIN_WINDOW - obs.length,
    }
  }
  let smallest = obs.length
  for (let n = MIN_WINDOW; n <= obs.length; n++) {
    if (fitWindow(obs, n).sigma <= SIGMA_TARGET) {
      smallest = n
      break
    }
  }
  const n = Math.min(smallest + WINDOW_BUFFER, obs.length)
  const fit = fitWindow(obs, n)
  return { status: "ok", elo: fit.theta, sigma: fit.sigma, n, ess: fit.ess, needed: 0 }
}

/**
 * The Learn-surface line body (spec 224 "UI") — the caller prefixes
 * "Unfinished Session: ". Rounded estimate, rounded 95% half-band:
 * "Elo 1238 ± 250"; below the minimum window: "Elo —, need 3 more puzzles".
 */
export function eloEstimateLine(est: EloEstimate): string {
  if (est.status !== "ok" || est.elo === null || est.sigma === null) {
    const n = Math.max(1, est.needed)
    return `Elo —, need ${n} more puzzle${n === 1 ? "" : "s"}`
  }
  return `Elo ${Math.round(est.elo)} ± ${Math.round(CI_Z * est.sigma)}`
}

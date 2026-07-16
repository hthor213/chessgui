// Spec 224: rolling avoidance-Elo estimate — the specced synthetic sequences
// (specs/224-learn-elo-estimate.md "Behavior properties"): breakout follows
// the new level within ~2 sessions, stagnation holds the mean flat while the
// ± tightens, sparse data refuses to guess. Plus the pooling invariants
// (per-puzzle-rating MLE, null-band exclusion) and the UI line format.

import { describe, it, expect } from "vitest"
import {
  CI_Z,
  MIN_WINDOW,
  SIGMA_TARGET,
  WINDOW_BUFFER,
  eloEstimateLine,
  estimateElo,
  expectedScoreElo,
  type EloAttempt,
} from "@chessgui/core/elo-estimate"

const T0 = Date.parse("2026-01-01T00:00:00Z")

/** `results[i]` at `band`, one attempt per minute starting at minute `startMin`. */
function attempts(band: string | null, results: boolean[], startMin: number): EloAttempt[] {
  return results.map((correct, i) => ({
    at: new Date(T0 + (startMin + i) * 60_000).toISOString(),
    band,
    correct,
  }))
}

/** n results with `pattern` repeated (e.g. [true, false] = alternating 50%). */
function repeat(pattern: boolean[], n: number): boolean[] {
  return Array.from({ length: n }, (_, i) => pattern[i % pattern.length])
}

describe("estimateElo — breakout (200@1700 then 30@1850)", () => {
  // The user's own scenario (224 "Why an adaptive window"): 200 puzzles at
  // ~50% around the 1700 band, then a breakout run of 30 at the 1850 band
  // solving 2 in 3. An all-time average reports ~1710-1730; the estimate must
  // decisively follow the breakout instead.
  const history = [
    ...attempts("1700", repeat([true, false], 200), 0),
    ...attempts("1850", repeat([true, true, false], 30), 200),
  ]

  it("converges decisively toward the 1850 breakout, not the all-time ~1710", () => {
    const est = estimateElo(history)
    expect(est.status).toBe("ok")
    // 2/3 at the 1850 band is a ~1970 performance; anything ≥ 1800 is
    // decisively past what any 1700-dominated average could report.
    expect(est.elo!).toBeGreaterThan(1800)
    expect(est.elo!).toBeLessThan(2150)
    // The window collapsed onto recent evidence — ~2 sessions (30 attempts
    // ≈ two 15-puzzle decks) sufficed; no need for the 200-attempt history.
    expect(est.n).toBeLessThanOrEqual(30)
  })

  it("is already moving after one 15-attempt session", () => {
    const oneSession = history.slice(0, 215)
    const est = estimateElo(oneSession)
    expect(est.status).toBe("ok")
    expect(est.elo!).toBeGreaterThan(1750)
  })

  it("keeps the ± honest about the thin recent evidence (ESS < window n)", () => {
    const est = estimateElo(history)
    expect(est.ess!).toBeGreaterThan(0)
    expect(est.ess!).toBeLessThan(est.n)
    expect(est.sigma!).toBeGreaterThan(0)
  })
})

describe("estimateElo — stagnation (long flat run at one band)", () => {
  it("holds the mean flat at the band while the ± tightens with data", () => {
    // Alternating 50% at 1700: performance = the band itself.
    const at15 = estimateElo(attempts("1700", repeat([true, false], MIN_WINDOW), 0))
    const at30 = estimateElo(attempts("1700", repeat([true, false], 30), 0))
    const at120 = estimateElo(attempts("1700", repeat([true, false], 120), 0))

    // Flat mean: within a few Elo of 1700 throughout (the recency decay on an
    // alternating sequence nudges it by <10).
    expect(Math.abs(at30.elo! - 1700)).toBeLessThan(25)
    expect(Math.abs(at120.elo! - 1700)).toBeLessThan(25)
    expect(Math.abs(at120.elo! - at30.elo!)).toBeLessThan(25)

    // Tightening ±: more history → window grows to its σ-satisfying size →
    // larger ESS, smaller σ.
    expect(at15.status).toBe("ok")
    expect(at120.sigma!).toBeLessThan(at15.sigma!)
    expect(at120.ess!).toBeGreaterThan(at15.ess!)
    expect(at120.sigma!).toBeLessThanOrEqual(SIGMA_TARGET)
  })

  it("caps the window at smallest-σ-satisfying N + buffer, by available data", () => {
    const est = estimateElo(attempts("1700", repeat([true, false], 200), 0))
    // 50% at one band is decisive: the minimum window already meets the σ
    // target, so n = MIN_WINDOW + buffer — old history stops mattering.
    expect(est.n).toBe(MIN_WINDOW + WINDOW_BUFFER)
  })
})

describe("estimateElo — sparse data refuses to guess", () => {
  it("returns the guard status below the minimum window", () => {
    const est = estimateElo(attempts("1900", repeat([true], MIN_WINDOW - 1), 0))
    expect(est.status).toBe("insufficient")
    expect(est.elo).toBeNull()
    expect(est.sigma).toBeNull()
    expect(est.ess).toBeNull()
    expect(est.n).toBe(MIN_WINDOW - 1)
    expect(est.needed).toBe(1)
  })

  it("returns the full shortfall on an empty log", () => {
    const est = estimateElo([])
    expect(est.status).toBe("insufficient")
    expect(est.needed).toBe(MIN_WINDOW)
  })

  it("excludes null-band attempts — they carry no puzzle rating", () => {
    // 10 banded + 20 null-band = still 5 short of the minimum window.
    const est = estimateElo([
      ...attempts("1900", repeat([true, false], 10), 0),
      ...attempts(null, repeat([true], 20), 10),
    ])
    expect(est.status).toBe("insufficient")
    expect(est.n).toBe(10)
    expect(est.needed).toBe(MIN_WINDOW - 10)
  })

  it("excludes unparseable bands and timestamps", () => {
    const junk: EloAttempt[] = [
      { at: "not-a-date", band: "1900", correct: true },
      { at: new Date(T0).toISOString(), band: "?", correct: true },
    ]
    const est = estimateElo([...attempts("1900", repeat([true, false], 14), 0), ...junk])
    expect(est.status).toBe("insufficient")
    expect(est.n).toBe(14)
  })
})

describe("estimateElo — performance-rating invariants", () => {
  it("reproduces the FIDE dp inversion on a single band (≈ r + 400·log10(p/(1−p)))", () => {
    // 75% at the 2000 band → dp = 400·log10(3) ≈ +190.8 → ~2191. The recency
    // decay on an evenly-spread pattern moves it only slightly.
    const est = estimateElo(attempts("2000", repeat([true, true, true, false], 40), 0))
    expect(est.status).toBe("ok")
    expect(Math.abs(est.elo! - (2000 + 400 * Math.log10(3)))).toBeLessThan(40)
  })

  it("pools across bands via per-puzzle ratings, never an averaged solve-rate", () => {
    // 50% at 1900 interleaved with 50% at 2100, symmetric around 2000: the
    // MLE lands at ~2000 because p(+100) + p(−100) = 1 — the rating axis does
    // the combining. (A solve-rate average would be meaningless here.)
    const a = attempts("1900", repeat([true, false], 30), 0)
    const b = attempts("2100", repeat([true, false], 30), 0)
    const interleaved = a.flatMap((e, i) => [e, b[i]])
    const est = estimateElo(interleaved)
    expect(est.status).toBe("ok")
    expect(Math.abs(est.elo! - 2000)).toBeLessThan(30)
    // Sanity: the symmetry the invariant rests on.
    expect(expectedScoreElo(100) + expectedScoreElo(-100)).toBeCloseTo(1, 12)
  })

  it("saturates (wide σ, clamped elo) instead of diverging on an all-solved log", () => {
    const est = estimateElo(attempts("1900", repeat([true], 40), 0))
    expect(est.status).toBe("ok")
    expect(est.elo!).toBeLessThanOrEqual(1900 + 800) // FIDE-style ±800 clamp
    expect(est.sigma!).toBeGreaterThan(SIGMA_TARGET) // honest: 100% pins nothing down
  })

  it("orders recency by timestamp, not array order", () => {
    // Same attempts, array reversed: newest-by-time must still dominate.
    const history = [
      ...attempts("1700", repeat([true, false], 100), 0),
      ...attempts("1850", repeat([true, true, false], 30), 100),
    ]
    const est = estimateElo(history)
    const reversed = estimateElo([...history].reverse())
    expect(reversed.elo!).toBeCloseTo(est.elo!, 6)
  })
})

describe("eloEstimateLine — the Learn-surface line body", () => {
  it("formats the estimate as 'Elo <e> ± <u>' with a 95% half-band", () => {
    const line = eloEstimateLine({
      status: "ok",
      elo: 1238.4,
      sigma: 127.55,
      n: 20,
      ess: 18.2,
      needed: 0,
    })
    expect(line).toBe(`Elo 1238 ± ${Math.round(CI_Z * 127.55)}`)
    expect(line).toBe("Elo 1238 ± 250")
  })

  it("formats the sparse guard as 'Elo —, need <N> more puzzles'", () => {
    expect(
      eloEstimateLine({ status: "insufficient", elo: null, sigma: null, n: 12, ess: null, needed: 3 }),
    ).toBe("Elo —, need 3 more puzzles")
    expect(
      eloEstimateLine({ status: "insufficient", elo: null, sigma: null, n: 14, ess: null, needed: 1 }),
    ).toBe("Elo —, need 1 more puzzle")
  })
})

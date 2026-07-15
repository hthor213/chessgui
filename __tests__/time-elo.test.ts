// Spec 216 tier-0: machine-speed / time-compression Elo model. Curve (prior
// anchors, constant, MEASURED flag), compression→ΔElo as an integral of b over
// the doublings, cross-machine (nps) equivalence, seconds-per-move, and the
// pacing readout/floor. (specs/216-machine-speed-elo-model.md:17-33,71-75.)

import { describe, it, expect } from "vitest"
import {
  DEFAULT_PRIOR_ANCHORS,
  DEFAULT_PRIOR_CURVE,
  FULL_STRENGTH_REASON,
  MOVE_BUDGET,
  POLICY_PERSONA_REASON,
  bAt,
  deltaElo,
  equivalentSeconds,
  paceFloor,
  paceStrength,
  secondsPerMoveOf,
  type EloCurve,
} from "@/lib/time-elo"

const L2 = (x: number) => Math.log2(x)

describe("DEFAULT_PRIOR_CURVE / bAt", () => {
  it("is flagged prior and carries the documented anchors", () => {
    expect(DEFAULT_PRIOR_CURVE.source).toBe("prior")
    expect(DEFAULT_PRIOR_CURVE.b).toBe(DEFAULT_PRIOR_ANCHORS)
    // b ≈ 90 @ 0.1s, 70 @ 1s, 55 @ 10s, 40 @ 60s, 30 @ 240s.
    expect(bAt(DEFAULT_PRIOR_CURVE, L2(0.1))).toBeCloseTo(90, 10)
    expect(bAt(DEFAULT_PRIOR_CURVE, L2(1))).toBeCloseTo(70, 10)
    expect(bAt(DEFAULT_PRIOR_CURVE, L2(10))).toBeCloseTo(55, 10)
    expect(bAt(DEFAULT_PRIOR_CURVE, L2(60))).toBeCloseTo(40, 10)
    expect(bAt(DEFAULT_PRIOR_CURVE, L2(240))).toBeCloseTo(30, 10)
  })

  it("interpolates linearly between anchors and clamps beyond the ends", () => {
    // Halfway (in log₂) between 1s(70) and 10s(55) is 55+15/2 = 62.5.
    const mid = (L2(1) + L2(10)) / 2
    expect(bAt(DEFAULT_PRIOR_CURVE, mid)).toBeCloseTo(62.5, 10)
    // Below 0.1s and above 240s hold flat at the boundary rate.
    expect(bAt(DEFAULT_PRIOR_CURVE, L2(0.01))).toBeCloseTo(90, 10)
    expect(bAt(DEFAULT_PRIOR_CURVE, L2(3600))).toBeCloseTo(30, 10)
  })

  it("treats a constant-b curve as flat everywhere", () => {
    const flat: EloCurve = { source: "measured", b: 60 }
    expect(bAt(flat, L2(0.1))).toBe(60)
    expect(bAt(flat, L2(600))).toBe(60)
  })
})

describe("deltaElo — compression cost", () => {
  it("is zero for no compression (C ≤ 1)", () => {
    expect(deltaElo(DEFAULT_PRIOR_CURVE, 10, 1)).toBe(0)
    expect(deltaElo(DEFAULT_PRIOR_CURVE, 10, 0.5)).toBe(0)
    expect(deltaElo(DEFAULT_PRIOR_CURVE, 10, 0)).toBe(0)
  })

  it("equals b·log₂(C) exactly for a constant curve", () => {
    const flat: EloCurve = { source: "measured", b: 60 }
    expect(deltaElo(flat, 8, 2)).toBeCloseTo(60, 10) // one doubling
    expect(deltaElo(flat, 8, 4)).toBeCloseTo(120, 10) // two doublings
    expect(deltaElo(flat, 8, 8)).toBeCloseTo(180, 10)
  })

  it("integrates b across a single anchor segment (10s → 1s = the 1s..10s span)", () => {
    // base 10s, C 10 → interval [log₂1, log₂10], exactly the 70→55 segment.
    // Area = mean(70,55)·log₂10 = 62.5·3.3219… — NOT the naive rectangle.
    const d = deltaElo(DEFAULT_PRIOR_CURVE, 10, 10)
    expect(d).toBeCloseTo(62.5 * L2(10), 6)
  })

  it("differs from the naive b(base)·log₂(C) when spanning shrinking b", () => {
    const base = 10
    const C = 10
    const integrated = deltaElo(DEFAULT_PRIOR_CURVE, base, C)
    const naive = bAt(DEFAULT_PRIOR_CURVE, L2(base)) * L2(C)
    // b shrinks from 70 (at 1s) to 55 (at 10s); the naive rectangle uses the
    // small end (55) and undercharges. The true area sits above it.
    expect(naive).toBeCloseTo(55 * L2(10), 6)
    expect(integrated).toBeGreaterThan(naive)
    expect(integrated - naive).toBeGreaterThan(1) // materially different, not float noise
  })

  it("sums correctly across multiple anchor segments", () => {
    // base 60s, C 60 → [log₂1, log₂60] spanning 70→55→40.
    const seg1 = ((70 + 55) / 2) * (L2(10) - L2(1))
    const seg2 = ((55 + 40) / 2) * (L2(60) - L2(10))
    expect(deltaElo(DEFAULT_PRIOR_CURVE, 60, 60)).toBeCloseTo(seg1 + seg2, 6)
  })

  it("is monotone: more compression → more Elo lost", () => {
    let prev = -Infinity
    for (let C = 1.1; C <= 16; C += 0.1) {
      const d = deltaElo(DEFAULT_PRIOR_CURVE, 60, C)
      expect(d).toBeGreaterThan(prev)
      prev = d
    }
  })

  it("returns 0 for a non-positive base", () => {
    expect(deltaElo(DEFAULT_PRIOR_CURVE, 0, 4)).toBe(0)
    expect(deltaElo(DEFAULT_PRIOR_CURVE, -5, 4)).toBe(0)
  })
})

describe("equivalentSeconds — cross-machine, equal nodes", () => {
  it("maps to fewer seconds on a faster machine (same node count)", () => {
    // Laptop 22s @ 2M nps; server @ 8M nps (4×) reaches the same nodes in 5.5s.
    expect(equivalentSeconds(DEFAULT_PRIOR_CURVE, 22, 8_000_000, 2_000_000)).toBeCloseTo(5.5, 10)
  })

  it("round-trips through both machines", () => {
    const laptop = 22
    const npsLaptop = 2_000_000
    const npsServer = 8_000_000
    const onServer = equivalentSeconds(DEFAULT_PRIOR_CURVE, laptop, npsServer, npsLaptop)
    const back = equivalentSeconds(DEFAULT_PRIOR_CURVE, onServer, npsLaptop, npsServer)
    expect(back).toBeCloseTo(laptop, 10)
  })

  it("guards a non-positive target nps", () => {
    expect(equivalentSeconds(DEFAULT_PRIOR_CURVE, 22, 0, 2_000_000)).toBe(0)
  })
})

describe("secondsPerMoveOf", () => {
  it("classical 40-in-X → X/40 + increment", () => {
    // 40 moves in 2.5h = 9000s, no increment.
    expect(secondsPerMoveOf({ baseSeconds: 9000, incrementSeconds: 0, movesPerControl: 40 })).toBe(225)
  })

  it("sudden death → base/40 + increment (25+10)", () => {
    expect(secondsPerMoveOf({ baseSeconds: 1500, incrementSeconds: 10 })).toBeCloseTo(47.5, 10)
  })

  it("sudden death blitz (3+2)", () => {
    expect(secondsPerMoveOf({ baseSeconds: 180, incrementSeconds: 2 })).toBeCloseTo(6.5, 10)
  })

  it("defaults the budget to MOVE_BUDGET when movesPerControl is absent", () => {
    expect(MOVE_BUDGET).toBe(40)
    expect(secondsPerMoveOf({ baseSeconds: 400, incrementSeconds: 0 })).toBe(10)
  })
})

describe("paceStrength — pacing-slider readout", () => {
  it("policy personas shed zero Elo with the distinct reason", () => {
    const res = paceStrength(DEFAULT_PRIOR_CURVE, 10, 8, { timeSensitive: false })
    expect(res.deltaElo).toBe(0)
    expect(res.timeSensitive).toBe(false)
    expect(res.reason).toBe(POLICY_PERSONA_REASON)
    expect(res.reason).toBe("no strength change (policy persona)")
  })

  it("search engines at or above budget play at full strength (C ≤ 1)", () => {
    const res = paceStrength(DEFAULT_PRIOR_CURVE, 10, 1)
    expect(res.deltaElo).toBe(0)
    expect(res.timeSensitive).toBe(true)
    expect(res.reason).toBe(FULL_STRENGTH_REASON)
  })

  it("search engines report the curve's ΔElo and the face-value string", () => {
    const d = deltaElo(DEFAULT_PRIOR_CURVE, 10, 8)
    const res = paceStrength(DEFAULT_PRIOR_CURVE, 10, 8)
    expect(res.timeSensitive).toBe(true)
    expect(res.deltaElo).toBeCloseTo(d, 10)
    expect(res.reason).toBe(`≈ face value − ${Math.round(d)} Elo at this pace`)
  })

  it("defaults to time-sensitive when no flag is passed", () => {
    // Same base/C as a persona call, but no opts → charges the search cost.
    expect(paceStrength(DEFAULT_PRIOR_CURVE, 10, 8).deltaElo).toBeGreaterThan(0)
  })
})

describe("paceFloor", () => {
  it("is 1.25× the minimum compute seconds", () => {
    expect(paceFloor(4)).toBeCloseTo(5, 10)
    expect(paceFloor(0.8)).toBeCloseTo(1, 10)
    expect(paceFloor(0)).toBe(0)
  })
})

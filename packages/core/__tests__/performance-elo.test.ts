// Per-game performance Elo (spec 202). Pure scoring: band likelihood under a
// synthetic corpus error model, the ACPL fallback, the honesty gate, and
// forced-move exclusion.

import { describe, it, expect } from "vitest"
import { GameTree } from "@chessgui/core/game-tree"
import {
  estimatePerformance,
  type ErrorModelFit,
} from "@chessgui/core/performance-elo"

const OPENING = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6"] // 8 plies

// Build a mainline with an eval on the root AND every ply — mirrors what
// Analyze Game writes. `cps` is white-POV centipawns: index 0 is the root, then
// one per ply.
function evaledTree(sans: string[], cps: number[]): GameTree {
  const t = GameTree.create()
  t.setEval(t.rootId, { cp: cps[0], depth: 15 })
  sans.forEach((san, i) => {
    const id = t.addMoveSan(san)
    expect(id).not.toBeNull()
    t.setEval(id!, { cp: cps[i + 1], depth: 15 })
  })
  return t
}

// The corpus grid, exactly as scripts/mining/error_model.py counts it.
const PHASES = ["opening", "middlegame", "endgame"]
const CLOCKS = ["600plus", "300-600", "120-300", "60-120", "30-60", "lt30", "none"]
const EVAL_LABELS: string[] = []
for (let lo = -500; lo < 500; lo += 50) {
  const pawns = lo / 100
  EVAL_LABELS.push(`${pawns < 0 ? "" : "+"}${pawns.toFixed(1)}`)
}

/** A dense two-band fit: band "1200" mistakes at `hi`, band "2000" at `lo`. */
function denseFit(hi = 0.3, lo = 0.03): ErrorModelFit {
  const cellsFor = (rate: number): Record<string, number> => {
    const cells: Record<string, number> = {}
    for (const phase of PHASES)
      for (const clock of CLOCKS)
        for (const ev of EVAL_LABELS) cells[`${phase}|${ev}|${clock}`] = rate
    return cells
  }
  return {
    meta: { bands: ["1200", "2000"], global_rate: 0.15 },
    bands: { "1200": { cells: cellsFor(hi) }, "2000": { cells: cellsFor(lo) } },
  }
}

describe("estimatePerformance — corpus band likelihood", () => {
  it("a clean game lands in the low-mistake-rate band, a blundery side in the high one", () => {
    // White drops ~1.5 pawns on every one of its 4 moves (all mistakes); Black
    // holds the (lost) eval steady every move (no mistakes).
    const cps = [0, -150, -150, -300, -300, -450, -450, -600, -600]
    const perf = estimatePerformance(evaledTree(OPENING, cps).mainlineNodes(), denseFit())

    expect(perf.white!.method).toBe("error-model")
    expect(perf.white!.band).toBe(1200) // all-mistakes -> the high-rate band
    expect(perf.black!.band).toBe(2000) // clean -> the low-rate band
    expect(perf.white!.label).toContain("performed like ~1200")
    expect(perf.white!.label).toContain("single game")
    expect(perf.white!.low).toBeLessThanOrEqual(perf.white!.band)
    expect(perf.white!.high).toBeGreaterThanOrEqual(perf.white!.band)
  })

  it("matches the mining cell-key format exactly (else it can't score)", () => {
    // A clean Ruy Lopez: every white eval-before rounds to the +0.0 bucket,
    // every black one to -0.5, all in the opening phase with no clock. A fit
    // holding ONLY those two cells still scores both sides — proving the
    // "phase|eval_bucket_lower|clock" key this module builds is byte-identical
    // to the corpus convention.
    const cps = [20, 25, 20, 28, 22, 26, 20, 24, 22]
    const only: ErrorModelFit = {
      meta: { bands: ["1200", "2000"], global_rate: 0.15 },
      bands: {
        "1200": { cells: { "opening|+0.0|none": 0.3, "opening|-0.5|none": 0.3 } },
        "2000": { cells: { "opening|+0.0|none": 0.03, "opening|-0.5|none": 0.03 } },
      },
    }
    const perf = estimatePerformance(evaledTree(OPENING, cps).mainlineNodes(), only)
    expect(perf.white!.method).toBe("error-model")
    expect(perf.black!.method).toBe("error-model")
    // Clean on both sides -> the low-mistake-rate band.
    expect(perf.white!.band).toBe(2000)
    expect(perf.black!.band).toBe(2000)
  })

  it("falls back to ACPL when no observation lands in a known cell", () => {
    const cps = [20, 25, 20, 28, 22, 26, 20, 24, 22]
    const empty: ErrorModelFit = {
      meta: { bands: ["1200", "2000"], global_rate: 0.15 },
      bands: { "1200": { cells: {} }, "2000": { cells: {} } },
    }
    const perf = estimatePerformance(evaledTree(OPENING, cps).mainlineNodes(), empty)
    expect(perf.white!.method).toBe("acpl")
  })
})

describe("estimatePerformance — ACPL fallback (no fit)", () => {
  it("a near-flawless game lands in the top band with no mistakes", () => {
    const cps = [20, 25, 20, 28, 22, 26, 20, 24, 22]
    const perf = estimatePerformance(evaledTree(OPENING, cps).mainlineNodes())
    expect(perf.white!.method).toBe("acpl")
    expect(perf.white!.band).toBe(2200)
    expect(perf.white!.blunders).toBe(0)
    expect(perf.white!.mistakes).toBe(0)
    expect(perf.white!.label).toContain("~2200+")
    expect(perf.white!.label).toContain("single game")
  })

  it("counts a white blunder and drops white's band below black's", () => {
    const cps = [20, 25, 20, -380, -375, -370, -372, -368, -370]
    const perf = estimatePerformance(evaledTree(OPENING, cps).mainlineNodes())
    expect(perf.white!.blunders).toBe(1)
    expect(perf.white!.band).toBeLessThan(2200)
    expect(perf.black!.blunders).toBe(0)
    expect(perf.black!.band).toBeGreaterThan(perf.white!.band)
  })
})

describe("estimatePerformance — honesty gate", () => {
  it("returns null for both sides when there are too few scored moves", () => {
    const cps = [20, 25, 20]
    const perf = estimatePerformance(evaledTree(["e4", "e5"], cps).mainlineNodes(), denseFit())
    expect(perf.white).toBeNull()
    expect(perf.black).toBeNull()
  })

  it("returns null for a game with no evals at all", () => {
    const t = GameTree.create()
    for (const san of OPENING) t.addMoveSan(san)
    const perf = estimatePerformance(t.mainlineNodes(), denseFit())
    expect(perf.white).toBeNull()
    expect(perf.black).toBeNull()
  })

  it("scores only moves whose before AND after positions both have evals", () => {
    const cps = [20, 25, 20, 28, 22, 26, 20, 24, 22]
    const perf = estimatePerformance(evaledTree(OPENING, cps).mainlineNodes())
    expect(perf.white!.scored).toBe(4)
    expect(perf.black!.scored).toBe(4)
  })
})

describe("estimatePerformance — forced-move exclusion", () => {
  it("does not score a move with exactly one legal reply", () => {
    // Start with White in check and only Kxg1 legal (a forced move). White then
    // walks the king freely (4 free moves); Black walks freely (5 moves).
    const forcedStart = "6k1/8/8/8/8/8/5PPP/6rK w - - 0 1"
    const sans = ["Kxg1", "Kf7", "Kf1", "Ke7", "Ke1", "Kd7", "Kd1", "Kc7", "Kc1", "Kb7"]
    const t = GameTree.create(forcedStart)
    t.setEval(t.rootId, { cp: 200, depth: 12 })
    for (const san of sans) {
      const id = t.addMoveSan(san)
      expect(id).not.toBeNull()
      t.setEval(id!, { cp: 200, depth: 12 })
    }
    const perf = estimatePerformance(t.mainlineNodes(), denseFit())
    // White made 5 moves but the forced Kxg1 is excluded -> 4 scored.
    expect(perf.white!.scored).toBe(4)
    // Black made 5 moves, none forced.
    expect(perf.black!.scored).toBe(5)
  })
})

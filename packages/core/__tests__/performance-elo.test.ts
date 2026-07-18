// Per-game performance Elo (spec 202). Pure scoring: band likelihood under a
// synthetic corpus error model, the ACPL fallback, the honesty gate, and
// forced-move exclusion.

import { describe, it, expect } from "vitest"
import { GameTree } from "@chessgui/core/game-tree"
import { parseEvalTag } from "@chessgui/core/annotations"
import {
  estimatePerformance,
  regularizeFit,
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

/** A dense fit with an explicit per-band (rate, moves), uniform across every
 *  phase/eval/clock cell — so an estimate depends only on the mistake pattern
 *  and the band, not on which cell a move lands in. */
function fitWithBands(spec: { band: string; rate: number; moves: number }[]): ErrorModelFit {
  const cellsFor = (rate: number): Record<string, number> => {
    const cells: Record<string, number> = {}
    for (const phase of PHASES)
      for (const clock of CLOCKS)
        for (const ev of EVAL_LABELS) cells[`${phase}|${ev}|${clock}`] = rate
    return cells
  }
  return {
    meta: { bands: spec.map((s) => s.band), global_rate: 0.15 },
    bands: Object.fromEntries(
      spec.map((s) => [s.band, { cells: cellsFor(s.rate), moves: s.moves }]),
    ),
  }
}

describe("regularizeFit — coverage clamp + monotonicity", () => {
  it("drops bands whose corpus support is below the floor", () => {
    const fit = fitWithBands([
      { band: "1500", rate: 0.3, moves: 10_000_000 },
      { band: "2500", rate: 0.05, moves: 1_000_000 },
      { band: "3200", rate: 0.3, moves: 100 }, // sparse artifact band
    ])
    const reg = regularizeFit(fit)
    expect(reg.meta.bands).toEqual(["1500", "2500"]) // 3200 trimmed
    expect(reg.meta.regularized).toBe(true)
    expect(reg.bands["3200"]).toBeUndefined()
  })

  it("forces every cell curve non-increasing in Elo (kills the top-band uptick)", () => {
    // A hand-built cell that DECREASES then upticks at the top, all bands
    // well-supported so the clamp doesn't hide the monotonization.
    const bands = ["1500", "2000", "2500", "3000"]
    const rates = [0.2, 0.12, 0.04, 0.18] // uptick at 3000
    const fit: ErrorModelFit = {
      meta: { bands, global_rate: 0.15 },
      bands: Object.fromEntries(
        bands.map((b, i) => [b, { cells: { "middlegame|+0.0|none": rates[i] }, moves: 5_000_000 }]),
      ),
    }
    const reg = regularizeFit(fit)
    const curve = reg.meta.bands.map((b) => reg.bands[b].cells["middlegame|+0.0|none"])
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]).toBeLessThanOrEqual(curve[i - 1] + 1e-12)
    }
    // The 2500/3000 violators pool to their mean (0.04+0.18)/2 = 0.11.
    expect(curve[2]).toBeCloseTo(0.11, 6)
    expect(curve[3]).toBeCloseTo(0.11, 6)
  })

  it("keeps the best-supported band even if the floor would drop everything", () => {
    const reg = regularizeFit(fitWithBands([{ band: "3200", rate: 0.3, moves: 100 }]))
    expect(reg.meta.bands).toEqual(["3200"])
  })
})

describe("regularizeFit — the Denny inversion is fixed", () => {
  // Artifact fit: rate decreases, then upticks at the sparse top band.
  const artifactFit = () =>
    fitWithBands([
      { band: "1500", rate: 0.3, moves: 10_000_000 },
      { band: "2500", rate: 0.05, moves: 1_000_000 },
      { band: "3200", rate: 0.3, moves: 100 },
    ])
  // Player A: flawless (0 mistakes over 4 white moves). Player B: 4 blunders.
  const cleanA = [20, 25, 20, 28, 22, 26, 20, 24, 22]
  const blunderB = [0, -150, -150, -300, -300, -450, -450, -600, -600]
  const whiteBand = (cps: number[], fit: ErrorModelFit) =>
    estimatePerformance(evaledTree(OPENING, cps).mainlineNodes(), fit).white!.band

  it("the RAW fit inverts them (fewer mistakes scores LOWER)", () => {
    const raw = artifactFit()
    // B lands on the sparse 3200 uptick, out-ranking the flawless A — the bug.
    expect(whiteBand(blunderB, raw)).toBeGreaterThan(whiteBand(cleanA, raw))
  })

  it("the REGULARIZED fit orders them correctly (fewer mistakes scores >=)", () => {
    const reg = regularizeFit(artifactFit())
    expect(whiteBand(cleanA, reg)).toBeGreaterThanOrEqual(whiteBand(blunderB, reg))
  })

  it("labels a ceiling estimate as an open-ended floor (~X+)", () => {
    const reg = regularizeFit(artifactFit())
    const perf = estimatePerformance(evaledTree(OPENING, cleanA).mainlineNodes(), reg)
    expect(perf.white!.label).toContain(`~${perf.white!.band}+`)
  })
})

describe("parseEvalTag — chess.com depth suffix", () => {
  it("accepts [%eval 0.15,18] (depth ignored) and plain [%eval 0.15]", () => {
    expect(parseEvalTag("[%eval 0.15,18]")).toEqual({ cp: 15, depth: 0 })
    expect(parseEvalTag("[%eval 0.15]")).toEqual({ cp: 15, depth: 0 })
    expect(parseEvalTag("[%eval -1.5,20]")).toEqual({ cp: -150, depth: 0 })
    expect(parseEvalTag("[%eval #-3,25]")).toEqual({ mate: -3, depth: 0 })
  })
})

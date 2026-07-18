// Per-game performance Elo (spec 202) — desktop wiring. The pure math + its
// synthetic-fixture unit tests live in packages/core/__tests__/performance-elo.
// Here we verify the desktop adapter binds the REAL bundled corpus model
// (data/personas/error_model.fit.json): estimates come back from the
// error-model path, move directionally, and stay honesty-gated.

import { describe, it, expect } from "vitest"
import { GameTree } from "@chessgui/core/game-tree"
import { estimatePerformance } from "@/lib/performance-elo"

const OPENING = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6"] // 8 plies

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

describe("estimatePerformance — bundled corpus model", () => {
  it("uses the error-model path and always caveats the single-game sample", () => {
    const cps = [20, 25, 20, 28, 22, 26, 20, 24, 22]
    const perf = estimatePerformance(evaledTree(OPENING, cps).mainlineNodes())
    expect(perf.white!.method).toBe("error-model")
    expect(perf.white!.label).toContain("single game")
    expect(perf.white!.low).toBeLessThanOrEqual(perf.white!.band)
    expect(perf.white!.high).toBeGreaterThanOrEqual(perf.white!.band)
  })

  it("maps a flawless game to a strong band", () => {
    // Zero mistakes on both sides -> the lowest-mistake-rate band. (Fine-grained
    // band-ordering correctness is proven in packages/core against a monotonic
    // synthetic fit; the real corpus is noisy at its extreme bands, so here we
    // only assert the robust direction: clean play scores high.)
    const cps = [20, 25, 20, 28, 22, 26, 20, 24, 22]
    const perf = estimatePerformance(evaledTree(OPENING, cps).mainlineNodes())
    expect(perf.white!.band).toBeGreaterThanOrEqual(2500)
    expect(perf.white!.mistakes).toBe(0)
  })
})

describe("estimatePerformance — honesty gate", () => {
  it("returns null for both sides when there are too few evaluated moves", () => {
    const cps = [20, 25, 20]
    const perf = estimatePerformance(evaledTree(["e4", "e5"], cps).mainlineNodes())
    expect(perf.white).toBeNull()
    expect(perf.black).toBeNull()
  })

  it("returns null for a game with no evals at all", () => {
    const t = GameTree.create()
    for (const san of OPENING) t.addMoveSan(san)
    const perf = estimatePerformance(t.mainlineNodes())
    expect(perf.white).toBeNull()
    expect(perf.black).toBeNull()
  })
})

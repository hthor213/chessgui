// Per-game performance Elo (spec 202) — ACPL/blunder → band mapping and the
// "not enough evals → null" honesty gate. Pure module, no engine.

import { describe, it, expect } from "vitest"
import { GameTree } from "@chessgui/core/game-tree"
import { estimatePerformance } from "@/lib/performance-elo"

const OPENING = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6"] // 8 plies

// Build a mainline with an eval on the root AND every ply — mirrors what
// Analyze Game writes (the root is one of its targets). `cps` is white-POV
// centipawns: index 0 is the root, then one per ply.
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

describe("estimatePerformance — band mapping", () => {
  it("a near-flawless game lands in the top band with no mistakes", () => {
    // Tiny swings around equality: ACPL well under 20 → ~2200+.
    const cps = [20, 25, 20, 28, 22, 26, 20, 24, 22]
    const perf = estimatePerformance(evaledTree(OPENING, cps).mainlineNodes())
    expect(perf.white).not.toBeNull()
    expect(perf.black).not.toBeNull()
    expect(perf.white!.band).toBe(2200)
    expect(perf.white!.blunders).toBe(0)
    expect(perf.white!.mistakes).toBe(0)
    expect(perf.white!.label).toContain("single game")
    expect(perf.white!.label).toContain("~2200+")
  })

  it("counts a white blunder and drops white's band", () => {
    // White's 2nd move (Nf3, ply 3) craters the eval by 400cp → blunder.
    const cps = [20, 25, 20, -380, -375, -370, -372, -368, -370]
    const perf = estimatePerformance(evaledTree(OPENING, cps).mainlineNodes())
    expect(perf.white!.blunders).toBe(1)
    // ACPL is dominated by the 400cp loss over 4 scored moves → ~100 → low band.
    expect(perf.white!.band).toBeLessThan(2200)
    // Black, meanwhile, gained ground and played clean → higher band than white.
    expect(perf.black!.blunders).toBe(0)
    expect(perf.black!.band).toBeGreaterThan(perf.white!.band)
  })
})

describe("estimatePerformance — honesty gate", () => {
  it("returns null for both sides when there are too few evaluated moves", () => {
    // Only 2 plies → each side has 1 scored move, below the minimum.
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

  it("scores only moves whose before AND after positions both have evals", () => {
    // Full game, evals on every node → both sides fully scored (4 each).
    const cps = [20, 25, 20, 28, 22, 26, 20, 24, 22]
    const perf = estimatePerformance(evaledTree(OPENING, cps).mainlineNodes())
    expect(perf.white!.scored).toBe(4)
    expect(perf.black!.scored).toBe(4)
  })
})

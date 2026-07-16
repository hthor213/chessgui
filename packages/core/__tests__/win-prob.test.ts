// Spec 212 tier-1: eval->win-prob curve (from the run's own probability map,
// logistic fallback) and per-move win-prob swing labeling. Synthetic evals per
// the checklist (specs/212-tournament-game-analysis.md:77-78).

import { describe, it, expect } from "vitest"
import {
  DEFAULT_LOGISTIC_K,
  DEFAULT_THRESHOLDS,
  MIN_ANCHOR_GAMES,
  computeMoveSwings,
  decisiveMoment,
  deriveWinProbCurve,
  labelGameMoves,
  winProb,
  type ClockByPly,
  type SwingThresholds,
  type WinProbCurve,
} from "@chessgui/core/win-prob"
import {
  buildProbabilityMap,
  expectedWinPct,
  type EvalMap,
  type GameOutcome,
  type PlyEval,
  type ProbBin,
} from "@chessgui/core/tournament"

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
const START_FEN_BLACK = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1"

function bin(center: number, avgWhiteScore: number, count: number): ProbBin {
  // W/D/L breakdown is not consumed by the curve; only center/count/avgWhiteScore.
  const expectedWhiteScore = expectedWinPct(center)
  return {
    lo: center - 0.125,
    hi: center + 0.125,
    center,
    count,
    whiteWins: 0,
    draws: 0,
    blackWins: 0,
    avgWhiteScore,
    expectedWhiteScore,
    conversionDelta: avgWhiteScore - expectedWhiteScore,
  }
}

function okOutcome(opts: {
  id?: number
  flipped?: boolean
  result?: "1-0" | "0-1" | "1/2-1/2"
  startFen?: string
  moves?: string[]
  evals?: PlyEval[]
  aborted?: boolean
}): GameOutcome {
  const moves = opts.moves ?? []
  return {
    id: opts.id ?? 0,
    flipped: opts.flipped ?? false,
    result: {
      Ok: {
        result: opts.result ?? "1-0",
        termination: "checkmate",
        plies: moves.length,
        start_fen: opts.startFen ?? START_FEN,
        moves,
      },
    },
    evals: opts.evals,
    aborted: opts.aborted,
  }
}

const cp = (ply: number, v: number): PlyEval => ({ ply, cp: v, mate: null })
const mate = (ply: number, v: number): PlyEval => ({ ply, cp: null, mate: v })

// A linear curve over [-8, +8] pawns: winProb(e) = (e + 8) / 16 exactly (binary
// fractions), so threshold-boundary tests are float-exact.
const LINEAR_CURVE: WinProbCurve = {
  anchors: [
    { e: -8, w: 0 },
    { e: 8, w: 1 },
  ],
  k: DEFAULT_LOGISTIC_K,
  source: "map",
}

describe("deriveWinProbCurve — map path", () => {
  it("anchors on well-populated bins and interpolates between them", () => {
    const bins = [bin(-1, 0.3, 20), bin(0, 0.5, 20), bin(1, 0.8, 20)]
    const curve = deriveWinProbCurve(bins)
    expect(curve.source).toBe("map")
    expect(winProb(curve, -1)).toBeCloseTo(0.3, 10)
    expect(winProb(curve, 0)).toBeCloseTo(0.5, 10)
    expect(winProb(curve, 1)).toBeCloseTo(0.8, 10)
    // Midpoint between anchors is linear.
    expect(winProb(curve, 0.5)).toBeCloseTo(0.65, 10)
  })

  it("enforces monotonicity on noisy bins (isotonic regression)", () => {
    // 0.4 -> 0.35 is a small-sample inversion; PAVA pools to 0.375.
    const bins = [bin(-1, 0.4, 10), bin(0, 0.35, 10), bin(1, 0.7, 10)]
    const curve = deriveWinProbCurve(bins)
    expect(curve.source).toBe("map")
    expect(winProb(curve, -1)).toBeCloseTo(0.375, 10)
    expect(winProb(curve, 0)).toBeCloseTo(0.375, 10)
    // Never decreasing anywhere.
    let prev = -Infinity
    for (let e = -4; e <= 4; e += 0.25) {
      const w = winProb(curve, e)
      expect(w).toBeGreaterThanOrEqual(prev - 1e-12)
      prev = w
    }
  })

  it("saturates toward 0/1 beyond the anchored range (logistic tails)", () => {
    const bins = [bin(-1, 0.3, 20), bin(0, 0.5, 20), bin(1, 0.8, 20)]
    const curve = deriveWinProbCurve(bins)
    const atEdge = winProb(curve, 1)
    const far = winProb(curve, 10) // where plyEvalPawns pins mates
    expect(far).toBeGreaterThan(atEdge)
    expect(far).toBeGreaterThan(0.9)
    expect(far).toBeLessThanOrEqual(1)
    expect(winProb(curve, -10)).toBeLessThan(0.1)
    expect(winProb(curve, 50)).toBeLessThanOrEqual(1)
    expect(winProb(curve, -50)).toBeGreaterThanOrEqual(0)
  })

  it("ignores bins below the anchor sample floor", () => {
    const bins = [
      bin(-1, 0.3, 20),
      bin(-0.5, 0.9, MIN_ANCHOR_GAMES - 1), // noisy outlier, too few games
      bin(0, 0.5, 20),
      bin(1, 0.8, 20),
    ]
    const curve = deriveWinProbCurve(bins)
    expect(curve.source).toBe("map")
    expect(curve.anchors.map((a) => a.e)).toEqual([-1, 0, 1])
  })
})

describe("deriveWinProbCurve — logistic fallback", () => {
  it("fits the slope from sparse bins when too few anchors exist", () => {
    // Two bins, both under the anchor minimum, generated from k = 0.5.
    const k = 0.5
    const w = (e: number) => 1 / (1 + Math.exp(-k * e))
    const bins = [bin(-1, w(-1), 3), bin(1, w(1), 3)]
    const curve = deriveWinProbCurve(bins)
    expect(curve.source).toBe("logistic-fit")
    expect(curve.anchors).toHaveLength(0)
    expect(curve.k).toBeCloseTo(0.5, 6)
    expect(winProb(curve, 0)).toBeCloseTo(0.5, 10)
    expect(winProb(curve, 2)).toBeCloseTo(w(2), 6)
  })

  it("uses the documented default slope when there is no data at all", () => {
    const curve = deriveWinProbCurve([])
    expect(curve.source).toBe("logistic-default")
    expect(curve.k).toBe(DEFAULT_LOGISTIC_K)
    expect(winProb(curve, 0)).toBeCloseTo(0.5, 10)
  })

  it("falls back to the default slope when all data sits at eval 0 (normal mode)", () => {
    const curve = deriveWinProbCurve([bin(0, 0.55, 100)])
    expect(curve.source).toBe("logistic-default")
    expect(curve.k).toBe(DEFAULT_LOGISTIC_K)
  })

  it("is symmetric and bounded for extreme cp", () => {
    const curve = deriveWinProbCurve([])
    expect(winProb(curve, 50) + winProb(curve, -50)).toBeCloseTo(1, 10)
    expect(winProb(curve, 50)).toBeLessThanOrEqual(1)
    expect(winProb(curve, 50)).toBeGreaterThan(0.99)
  })
})

describe("computeMoveSwings — labeling", () => {
  it("labels a Black blunder from the mover's perspective", () => {
    // White-POV eval jumps 0 -> +250 across Black's move: Black lost win-prob.
    const outcome = okOutcome({
      moves: ["e2e4", "f7f6", "d2d4"],
      evals: [cp(0, 0), cp(1, 0), cp(2, 250), cp(3, 240)],
    })
    const curve = deriveWinProbCurve([]) // default logistic, k=0.4
    const swings = computeMoveSwings(outcome, curve)
    expect(swings).toHaveLength(3)

    const m2 = swings[1]
    expect(m2.ply).toBe(2)
    expect(m2.uci).toBe("f7f6")
    expect(m2.mover).toBe("black")
    expect(m2.engine).toBe("b") // A is White in an unflipped game
    // sigma(0)=0.5 -> sigma(1.0)=0.7311 White-POV; Black wp 0.5 -> 0.2689.
    expect(m2.wpBefore).toBeCloseTo(0.5, 4)
    expect(m2.wpAfter).toBeCloseTo(0.2689, 3)
    expect(m2.drop).toBeCloseTo(0.2311, 3)
    expect(m2.label).toBe("blunder")

    // A gain is never labeled: White's move 3 profits from the blunder ply 1->2
    // already; ply 2->3 is flat for White.
    expect(swings[0].label).toBeNull()
    // sigma(1.0) - sigma(0.96) = 0.0079: a tiny drift, far below any threshold.
    expect(swings[2].drop).toBeCloseTo(0.0079, 3)
    expect(swings[2].label).toBeNull()
  })

  it("attributes the mover engine correctly in flipped games", () => {
    const outcome = okOutcome({
      flipped: true,
      moves: ["e2e4", "f7f6"],
      evals: [cp(0, 0), cp(1, 0), cp(2, 250)],
    })
    const swings = computeMoveSwings(outcome, deriveWinProbCurve([]))
    expect(swings[0].mover).toBe("white")
    expect(swings[0].engine).toBe("b") // flipped: B is White
    expect(swings[1].mover).toBe("black")
    expect(swings[1].engine).toBe("a")
  })

  it("anchors mover parity to the start FEN's side to move", () => {
    const outcome = okOutcome({
      startFen: START_FEN_BLACK,
      moves: ["e7e5", "g1f3"],
      evals: [cp(0, 30), cp(1, 30), cp(2, 30)],
    })
    const swings = computeMoveSwings(outcome, deriveWinProbCurve([]))
    expect(swings[0].mover).toBe("black")
    expect(swings[1].mover).toBe("white")
  })

  it("applies thresholds at exact boundaries (>=)", () => {
    // LINEAR_CURVE: winProb = (pawns+8)/16, so cp deltas map to exact drops.
    const t: SwingThresholds = { inaccuracy: 0.0625, mistake: 0.125, blunder: 0.25 }
    // White moves: 0cp -> -100cp is a drop of exactly 1/16 = 0.0625.
    const at = okOutcome({ moves: ["f2f3"], evals: [cp(0, 0), cp(1, -100)] })
    expect(computeMoveSwings(at, LINEAR_CURVE, t)[0].label).toBe("inaccuracy")
    // Just under: -99cp -> drop 0.061875 < 0.0625.
    const under = okOutcome({ moves: ["f2f3"], evals: [cp(0, 0), cp(1, -99)] })
    expect(computeMoveSwings(under, LINEAR_CURVE, t)[0].label).toBeNull()
    // Tier boundaries.
    const mistake = okOutcome({ moves: ["f2f3"], evals: [cp(0, 0), cp(1, -200)] })
    expect(computeMoveSwings(mistake, LINEAR_CURVE, t)[0].label).toBe("mistake")
    const blunder = okOutcome({ moves: ["f2f3"], evals: [cp(0, 0), cp(1, -400)] })
    expect(computeMoveSwings(blunder, LINEAR_CURVE, t)[0].label).toBe("blunder")
  })

  it("uses the spec's 5/10/20-point defaults", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ inaccuracy: 0.05, mistake: 0.1, blunder: 0.2 })
    // Drop of exactly 0.125 on the linear curve (-200cp) => mistake by default.
    const outcome = okOutcome({ moves: ["f2f3"], evals: [cp(0, 0), cp(1, -200)] })
    expect(computeMoveSwings(outcome, LINEAR_CURVE)[0].label).toBe("mistake")
  })

  it("treats mate scores as pinned extremes (via plyEvalPawns)", () => {
    // Allowing a mate against you from an equal position is a max-size blunder.
    const outcome = okOutcome({
      moves: ["f2f3", "e7e5"],
      evals: [cp(0, 0), mate(1, -2), mate(2, -1)],
    })
    const swings = computeMoveSwings(outcome, LINEAR_CURVE)
    // -2 mate pins to -10 pawns; clamped into the tails below the linear range.
    expect(swings[0].mover).toBe("white")
    expect(swings[0].label).toBe("blunder")
    expect(swings[0].wpAfter).toBeLessThan(0.05)
    // Mate-in-1 vs mate-in-2 (same sign) is no swing at all.
    expect(swings[1].drop).toBe(0)
    expect(swings[1].label).toBeNull()
  })

  it("skips gaps instead of bridging them", () => {
    const outcome = okOutcome({
      moves: ["e2e4", "e7e5", "g1f3", "b8c6"],
      // ply 2 unscored twice over: missing entry and a null-null entry at ply 3.
      evals: [cp(0, 20), cp(1, 25), { ply: 3, cp: null, mate: null }, cp(4, 30)],
    })
    const swings = computeMoveSwings(outcome, deriveWinProbCurve([]))
    expect(swings.map((s) => s.ply)).toEqual([1]) // only 0->1 has both ends scored
  })

  it("returns [] for games with no evals, Err games and aborted games", () => {
    const noEvals = okOutcome({ moves: ["e2e4"] })
    expect(computeMoveSwings(noEvals, LINEAR_CURVE)).toEqual([])

    const err: GameOutcome = { id: 1, flipped: false, result: { Err: "engine died" } }
    expect(computeMoveSwings(err, LINEAR_CURVE)).toEqual([])

    const aborted = okOutcome({
      moves: ["e2e4"],
      evals: [cp(0, 0), cp(1, -300)],
      aborted: true,
    })
    expect(computeMoveSwings(aborted, LINEAR_CURVE)).toEqual([])
  })

  it("records the mover's clock when per-ply clocks are supplied", () => {
    const clocks: ClockByPly = new Map([
      [1, { wtimeMs: 58_000, btimeMs: 60_000 }],
      [2, { wtimeMs: 58_000, btimeMs: 55_000 }],
    ])
    const outcome = okOutcome({
      moves: ["e2e4", "e7e5"],
      evals: [cp(0, 0), cp(1, 10), cp(2, 10)],
    })
    const swings = computeMoveSwings(outcome, LINEAR_CURVE, DEFAULT_THRESHOLDS, clocks)
    expect(swings[0].clockMs).toBe(58_000) // White's clock after move 1
    expect(swings[1].clockMs).toBe(55_000) // Black's clock after move 2
    // Without clocks the field is null, and PV gap is always null in tier-1.
    const bare = computeMoveSwings(outcome, LINEAR_CURVE)
    expect(bare[0].clockMs).toBeNull()
    expect(bare[0].bestMoveGapCp).toBeNull()
  })
})

describe("labelGameMoves / decisiveMoment", () => {
  const outcome = okOutcome({
    moves: ["e2e4", "f7f6", "d2d4", "g7g5"],
    // Black inaccuracy at ply 2 (-100cp on the linear curve = 1/16), then the
    // game-deciding blunder at ply 4 (-600cp = 6/16, inside the linear range).
    evals: [cp(0, 0), cp(1, 0), cp(2, 100), cp(3, 100), cp(4, 700)],
  })

  it("returns only labeled moves", () => {
    const labeled = labelGameMoves(outcome, LINEAR_CURVE)
    expect(labeled.map((s) => [s.ply, s.label])).toEqual([
      [2, "inaccuracy"],
      [4, "blunder"],
    ])
  })

  it("finds the single largest drop", () => {
    const swings = computeMoveSwings(outcome, LINEAR_CURVE)
    const dm = decisiveMoment(swings)
    expect(dm?.ply).toBe(4)
    expect(dm?.mover).toBe("black")
    expect(dm?.drop).toBeCloseTo(0.375, 10)
  })

  it("returns null when no move lost win-prob", () => {
    const crush = okOutcome({
      moves: ["e2e4", "e7e5"],
      evals: [cp(0, 0), cp(1, 0), cp(2, 0)],
    })
    expect(decisiveMoment(computeMoveSwings(crush, LINEAR_CURVE))).toBeNull()
  })
})

describe("end-to-end: probability map -> curve -> labels", () => {
  // Synthetic 30-game run: 5 starting-eval levels x 6 games, results skewed by
  // the starting eval (the pipeline spec 212 assumes from spec 210).
  function syntheticRun(): { outcomes: GameOutcome[]; evalById: EvalMap } {
    const levels: { e: number; results: ("1-0" | "0-1" | "1/2-1/2")[] }[] = [
      { e: -1.5, results: ["0-1", "0-1", "0-1", "0-1", "0-1", "1/2-1/2"] },
      { e: -0.75, results: ["0-1", "0-1", "0-1", "1/2-1/2", "1/2-1/2", "1-0"] },
      { e: 0, results: ["1-0", "0-1", "1/2-1/2", "1/2-1/2", "1/2-1/2", "0-1"] },
      { e: 0.75, results: ["1-0", "1-0", "1-0", "1/2-1/2", "1/2-1/2", "0-1"] },
      { e: 1.5, results: ["1-0", "1-0", "1-0", "1-0", "1-0", "1/2-1/2"] },
    ]
    const outcomes: GameOutcome[] = []
    const evalById: EvalMap = new Map()
    let id = 0
    for (const { e, results } of levels) {
      for (const r of results) {
        outcomes.push(okOutcome({ id, flipped: id % 2 === 1, result: r }))
        evalById.set(id, { eval: e })
        id++
      }
    }
    return { outcomes, evalById }
  }

  it("derives a monotone map-sourced curve and labels a game with it", () => {
    const { outcomes, evalById } = syntheticRun()
    const bins = buildProbabilityMap(outcomes, evalById)
    const curve = deriveWinProbCurve(bins)
    expect(curve.source).toBe("map")

    // Sanity of the curve itself: monotone, ordered ends, sane middle.
    let prev = -Infinity
    for (let e = -3; e <= 3; e += 0.25) {
      const w = winProb(curve, e)
      expect(w).toBeGreaterThanOrEqual(prev - 1e-12)
      prev = w
    }
    expect(winProb(curve, -1.5)).toBeLessThan(0.25)
    expect(winProb(curve, 1.5)).toBeGreaterThan(0.75)
    expect(winProb(curve, 0)).toBeGreaterThan(0.3)
    expect(winProb(curve, 0)).toBeLessThan(0.7)

    // Label a game against the run-derived curve: White throws away a winning
    // position (+1.5 -> -1.5 across White's move) — the conversion-cliff case
    // the spec calls out (212:26-27).
    const game = okOutcome({
      moves: ["e2e4", "e7e5", "f1c4", "f8c5", "c4f7"],
      evals: [cp(0, 150), cp(1, 150), cp(2, 150), cp(3, 150), cp(4, 150), cp(5, -150)],
    })
    const labeled = labelGameMoves(game, curve)
    expect(labeled).toHaveLength(1)
    expect(labeled[0].ply).toBe(5)
    expect(labeled[0].mover).toBe("white")
    expect(labeled[0].label).toBe("blunder")
    expect(decisiveMoment(computeMoveSwings(game, curve))?.ply).toBe(5)
  })
})

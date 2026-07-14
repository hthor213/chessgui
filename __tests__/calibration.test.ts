import { describe, it, expect } from "vitest"
import {
  MATE_PAWNS,
  pearson,
  sfEvalPawns,
  scoredAnswers,
  summarize,
  formatPawns,
} from "@/lib/calibration-stats"
import type {
  CalibrationAnswer,
  CalibrationPosition,
  CalibrationSession,
} from "@/lib/calibration"

function pos(over: Partial<CalibrationPosition>): CalibrationPosition {
  return {
    fen: "8/8/8/8/8/8/8/8 w - - 0 1",
    sf_cp: 0,
    sf_mate: null,
    sf_best_uci: "e2e4",
    sf_best_san: "e4",
    multipv_gap_cp: null,
    material: 0,
    band: "0-0.5",
    phase: "middlegame",
    game_id: 1,
    ply: 20,
    ...over,
  }
}

function ans(over: Partial<CalibrationAnswer>): CalibrationAnswer {
  return {
    index: 0,
    eval: 0,
    why: "",
    move_uci: null,
    elapsed_ms: 1000,
    skipped: false,
    ...over,
  }
}

function session(positions: CalibrationPosition[]): CalibrationSession {
  return {
    version: 1,
    n: positions.length,
    created_at: 0,
    stockfish_path: "(test)",
    positions,
  }
}

describe("sfEvalPawns", () => {
  it("converts centipawns to pawns", () => {
    expect(sfEvalPawns(pos({ sf_cp: 150 }))).toBeCloseTo(1.5)
    expect(sfEvalPawns(pos({ sf_cp: -75 }))).toBeCloseTo(-0.75)
  })
  it("caps mate scores at ±MATE_PAWNS by sign", () => {
    expect(sfEvalPawns(pos({ sf_cp: null, sf_mate: 3 }))).toBe(MATE_PAWNS)
    expect(sfEvalPawns(pos({ sf_cp: null, sf_mate: -2 }))).toBe(-MATE_PAWNS)
  })
  it("clamps absurd centipawns to the mate cap", () => {
    expect(sfEvalPawns(pos({ sf_cp: 5000 }))).toBe(MATE_PAWNS)
  })
})

describe("pearson", () => {
  it("is +1 for a perfect increasing relationship", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1)
  })
  it("is -1 for a perfect decreasing relationship", () => {
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1)
  })
  it("is null with fewer than two points or a constant series", () => {
    expect(pearson([1], [1])).toBeNull()
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNull()
  })
})

describe("scoredAnswers", () => {
  it("drops skipped and eval-less answers, keeps the rest", () => {
    const s = session([pos({}), pos({}), pos({})])
    const answers = [
      ans({ index: 0, eval: 1.0 }),
      ans({ index: 1, skipped: true, eval: null }),
      ans({ index: 2, eval: null }),
    ]
    const scored = scoredAnswers(s, answers)
    expect(scored).toHaveLength(1)
    expect(scored[0].index).toBe(0)
    expect(scored[0].userEval).toBe(1.0)
  })
})

describe("summarize", () => {
  it("computes MAE, per-band rows, hit rate, and biggest misses", () => {
    const s = session([
      pos({ band: "0-0.5", sf_cp: 20, sf_best_uci: "g1f3" }), // user 0.0 → err 0.2
      pos({ band: "0.5-1.5", sf_cp: 100, sf_best_uci: "d2d4" }), // user 1.0 → err 0.0
      pos({ band: "3+", sf_cp: 400, sf_best_uci: "a2a4" }), // user 1.0 → err 3.0
    ])
    const answers = [
      ans({ index: 0, eval: 0.0, move_uci: "g1f3" }), // move hit
      ans({ index: 1, eval: 1.0, move_uci: "e2e4" }), // move miss
      ans({ index: 2, eval: 1.0, move_uci: null }), // no move
    ]
    const sum = summarize(s, answers)

    expect(sum.answered).toBe(3)
    expect(sum.skipped).toBe(0)
    // MAE = (0.2 + 0.0 + 3.0) / 3
    expect(sum.mae).toBeCloseTo(3.2 / 3)
    // Two answers picked a move; one matched Stockfish.
    expect(sum.moveAnswers).toBe(2)
    expect(sum.bestMoveHitRate).toBeCloseTo(0.5)

    // Per-band table always has the four bands in order.
    expect(sum.perBand.map((b) => b.band)).toEqual(["0-0.5", "0.5-1.5", "1.5-3", "3+"])
    const midBand = sum.perBand.find((b) => b.band === "1.5-3")!
    expect(midBand.count).toBe(0)
    expect(midBand.mae).toBeNull()
    const topBand = sum.perBand.find((b) => b.band === "3+")!
    expect(topBand.count).toBe(1)
    expect(topBand.mae).toBeCloseTo(3.0)

    // Biggest miss is the +4 position the user called +1.
    expect(sum.biggestMisses[0].index).toBe(2)
    expect(sum.biggestMisses[0].absError).toBeCloseTo(3.0)
  })

  it("counts skips and returns null stats with no usable answers", () => {
    const s = session([pos({}), pos({})])
    const answers = [ans({ index: 0, skipped: true, eval: null }), ans({ index: 1, skipped: true, eval: null })]
    const sum = summarize(s, answers)
    expect(sum.answered).toBe(0)
    expect(sum.skipped).toBe(2)
    expect(sum.mae).toBeNull()
    expect(sum.pearson).toBeNull()
    expect(sum.bestMoveHitRate).toBeNull()
  })
})

describe("formatPawns", () => {
  it("signs and rounds, flattening near-zero", () => {
    expect(formatPawns(1.5)).toBe("+1.5")
    expect(formatPawns(-0.7)).toBe("-0.7")
    expect(formatPawns(0.02)).toBe("0")
  })
})

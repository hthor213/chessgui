import { describe, it, expect } from "vitest"
import {
  MATE_PAWNS,
  pearson,
  median,
  sfEvalPawns,
  scoredAnswers,
  summarize,
  groupStats,
  formatPawns,
} from "@/lib/calibration-stats"
import { normalizeAnswer } from "@/lib/calibration"
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
    white_elo: 1800,
    black_elo: 1800,
    elo_band: "1600-2000",
    to_move: "white",
    played_uci: "e2e4",
    played_san: "e4",
    continuation_san: [],
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
    think_ms: 3000,
    time_excluded: false,
    answer_locked_at: 1_000_000,
    revised_eval: null,
    revision_note: null,
    revised_at: null,
    coach: null,
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

describe("groupStats", () => {
  it("computes count, MAE, correlation, and hit rate for a subset", () => {
    const s = session([
      pos({ sf_cp: 100, sf_best_uci: "d2d4" }),
      pos({ sf_cp: 200, sf_best_uci: "a2a4" }),
    ])
    const scored = scoredAnswers(s, [
      ans({ index: 0, eval: 1.0, move_uci: "d2d4" }), // err 0.0, move hit
      ans({ index: 1, eval: 1.0, move_uci: "e2e4" }), // err 1.0, move miss
    ])
    const g = groupStats(scored)
    expect(g.count).toBe(2)
    expect(g.mae).toBeCloseTo(0.5)
    expect(g.moveAnswers).toBe(2)
    expect(g.bestMoveHitRate).toBeCloseTo(0.5)
    // user [1,1] is constant → correlation undefined.
    expect(g.pearson).toBeNull()
  })

  it("returns null metrics for an empty group", () => {
    const g = groupStats([])
    expect(g.count).toBe(0)
    expect(g.mae).toBeNull()
    expect(g.pearson).toBeNull()
    expect(g.bestMoveHitRate).toBeNull()
    expect(g.moveAnswers).toBe(0)
  })
})

describe("summarize — per-phase breakdown", () => {
  it("splits stats by phase and leaves an absent phase empty", () => {
    // All middlegame — a common shape given the endgame sampling gap.
    const s = session([
      pos({ phase: "middlegame", sf_cp: 50, sf_best_uci: "g1f3" }),
      pos({ phase: "middlegame", sf_cp: 150, sf_best_uci: "d2d4" }),
      pos({ phase: "middlegame", sf_cp: 250, sf_best_uci: "a2a4" }),
    ])
    const sum = summarize(s, [
      ans({ index: 0, eval: 0.4, move_uci: "g1f3" }),
      ans({ index: 1, eval: 1.6, move_uci: "d2d4" }),
      ans({ index: 2, eval: 2.6, move_uci: "b1c3" }),
    ])

    expect(sum.perPhase.map((p) => p.phase)).toEqual(["middlegame", "endgame"])
    const mid = sum.perPhase.find((p) => p.phase === "middlegame")!
    expect(mid.count).toBe(3)
    expect(mid.mae).toBeCloseTo(0.1) // each off by ~0.1
    expect(mid.moveAnswers).toBe(3)
    expect(mid.bestMoveHitRate).toBeCloseTo(2 / 3)
    expect(mid.pearson).not.toBeNull()

    const end = sum.perPhase.find((p) => p.phase === "endgame")!
    expect(end.count).toBe(0)
    expect(end.mae).toBeNull()
    expect(end.pearson).toBeNull()
    expect(end.bestMoveHitRate).toBeNull()
  })
})

describe("median", () => {
  it("handles odd, even, and empty", () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBeNull()
  })
})

describe("summarize — think time", () => {
  it("medians only time-included, interacted answers; counts excluded", () => {
    const s = session([pos({}), pos({}), pos({}), pos({})])
    const sum = summarize(s, [
      ans({ index: 0, eval: 0.5, think_ms: 2000 }),
      ans({ index: 1, eval: 0.5, think_ms: 6000 }),
      ans({ index: 2, eval: 0.5, think_ms: 900000, time_excluded: true }), // excluded from time
      ans({ index: 3, eval: 0.5, think_ms: null }), // never interacted
    ])
    // Median over [2000, 6000] = 4000; the 900000 (excluded) and null are omitted.
    expect(sum.medianThinkMs).toBe(4000)
    expect(sum.timeExcludedCount).toBe(1)
    // ...but the excluded answer still counts for eval accuracy.
    expect(sum.answered).toBe(4)
  })

  it("median think is null when no answer has usable time", () => {
    const s = session([pos({})])
    const sum = summarize(s, [ans({ index: 0, eval: 1, think_ms: null })])
    expect(sum.medianThinkMs).toBeNull()
  })
})

describe("normalizeAnswer — retroactive upgrade", () => {
  it("excludes the time of pre-think_ms answers", () => {
    // Simulate an old-schema answer (no think_ms / time_excluded fields).
    const old = { index: 0, eval: 1.2, why: "hi", move_uci: null, elapsed_ms: 339000, skipped: false }
    const up = normalizeAnswer(old as unknown as CalibrationAnswer)
    expect(up.think_ms).toBeNull()
    expect(up.time_excluded).toBe(true)
    // No lock timestamp on old answers → 0 (unknown), not undefined.
    expect(up.answer_locked_at).toBe(0)
    // Second-look + coach fields default to null when absent.
    expect(up.revised_eval).toBeNull()
    expect(up.revision_note).toBeNull()
    expect(up.revised_at).toBeNull()
    expect(up.coach).toBeNull()
    // A current-schema answer is left as-is.
    const cur = ans({ index: 1, think_ms: 5000, time_excluded: false })
    expect(normalizeAnswer(cur).time_excluded).toBe(false)
    expect(normalizeAnswer(cur).think_ms).toBe(5000)
  })
})

describe("formatPawns", () => {
  it("signs and rounds, flattening near-zero", () => {
    expect(formatPawns(1.5)).toBe("+1.5")
    expect(formatPawns(-0.7)).toBe("-0.7")
    expect(formatPawns(0.02)).toBe("0")
  })
})

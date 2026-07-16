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
  formatRange,
  rangeError,
} from "@/lib/calibration-stats"
import {
  normalizeAnswer,
  coachInputFor,
  answerRange,
  rangePoint,
  EVAL_RANGES,
  POSITIVE_RANGES,
  LEVEL_RANGE,
} from "@/lib/calibration"
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
    eval_lo: null,
    eval_hi: null,
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
    rebuttal: null,
    coach_reply: null,
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

describe("summarize — per-deck breakdown (v3)", () => {
  it("groups stats by training deck", () => {
    const s = session([
      pos({ deck: "conversion", sf_cp: 200 }),
      pos({ deck: "conversion", sf_cp: 100 }),
      pos({ deck: "endgame", phase: "endgame", sf_cp: 50 }),
      pos({ deck: "level", sf_cp: 0 }),
    ])
    const sum = summarize(s, [
      ans({ index: 0, eval: 2.0, move_uci: "e2e4" }), // conversion: exact, best-move hit
      ans({ index: 1, eval: 0.0 }), // conversion: off by 1.0
      ans({ index: 2, eval: 0.5 }), // endgame: exact
      ans({ index: 3, eval: 1.0 }), // level: off by 1.0
    ])
    const byDeck = Object.fromEntries(sum.perDeck.map((d) => [d.deck, d]))
    expect(sum.perDeck.map((d) => d.deck)).toEqual(["conversion", "critical", "endgame", "level"])
    expect(byDeck.conversion.count).toBe(2)
    expect(byDeck.conversion.mae).toBeCloseTo(0.5)
    expect(byDeck.conversion.bestMoveHitRate).toBe(1)
    expect(byDeck.critical.count).toBe(0)
    expect(byDeck.critical.mae).toBeNull()
    expect(byDeck.endgame.count).toBe(1)
    expect(byDeck.endgame.mae).toBeCloseTo(0)
    expect(byDeck.level.count).toBe(1)
    expect(byDeck.level.mae).toBeCloseTo(1.0)
  })

  it("summarizes a stored pre-v3 session — no decks, but nothing lost (session history survives schema upgrades)", () => {
    // A v1 position exactly as it sits in an old localStorage/results file:
    // no deck, no sf_pv_san, none of the v2 game-context fields.
    const v1Position = {
      fen: "8/8/8/8/8/8/8/8 w - - 0 1",
      sf_cp: 120,
      sf_mate: null,
      sf_best_uci: "e2e4",
      sf_best_san: "e4",
      multipv_gap_cp: null,
      material: 0,
      band: "0.5-1.5",
      phase: "middlegame",
      game_id: 1,
      ply: 20,
    } as unknown as CalibrationPosition
    const sum = summarize(session([v1Position]), [ans({ index: 0, eval: 1.0 })])
    // The old answer still fully counts for accuracy...
    expect(sum.answered).toBe(1)
    expect(sum.mae).toBeCloseTo(0.2)
    expect(sum.perBand.find((b) => b.band === "0.5-1.5")?.count).toBe(1)
    // ...and every deck row is present but empty (the UI hides the table).
    expect(sum.perDeck).toHaveLength(4)
    expect(sum.perDeck.every((d) => d.count === 0 && d.mae === null)).toBe(true)
    // Point answers are never reinterpreted as ranges (range elicitation is a
    // new-session-boundary feature): scoring stays point-distance, no range.
    expect(sum.biggestMisses[0].userRange).toBeNull()
    expect(sum.biggestMisses[0].absError).toBeCloseTo(0.2)
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

// ---------------------------------------------------------------------------
// Range elicitation (spec 213 Phase 0)
// ---------------------------------------------------------------------------

describe("EVAL_RANGES — log-spaced answer scale", () => {
  it("has 13 ranges: 6 mirrored pairs around the level range, ordered Black→White", () => {
    expect(EVAL_RANGES).toHaveLength(13)
    expect(EVAL_RANGES[6]).toEqual(LEVEL_RANGE)
    // Mirror symmetry: range i is the negation of range 12−i.
    for (let i = 0; i < 6; i++) {
      const neg = EVAL_RANGES[i]
      const pos = EVAL_RANGES[12 - i]
      expect(neg.lo).toBe(pos.hi == null ? null : -pos.hi)
      expect(neg.hi).toBe(-(pos.lo as number))
    }
    // Positive side matches the spec's list: 0.1–0.3, 0.3–0.6, 0.6–1, 1–2, 2–4, 4+.
    expect(POSITIVE_RANGES).toEqual([
      { lo: 0.1, hi: 0.3 },
      { lo: 0.3, hi: 0.6 },
      { lo: 0.6, hi: 1 },
      { lo: 1, hi: 2 },
      { lo: 2, hi: 4 },
      { lo: 4, hi: null },
    ])
  })

  it("tiles the eval axis with no gaps: each range's hi is the next one's lo", () => {
    for (let i = 0; i < EVAL_RANGES.length - 1; i++) {
      expect(EVAL_RANGES[i].hi).toBe(EVAL_RANGES[i + 1].lo)
    }
    // Unbounded tails on both ends.
    expect(EVAL_RANGES[0].lo).toBeNull()
    expect(EVAL_RANGES[12].hi).toBeNull()
  })

  it("every range has at least one finite bound (so answerRange is unambiguous)", () => {
    for (const r of EVAL_RANGES) expect(r.lo != null || r.hi != null).toBe(true)
  })
})

describe("rangePoint", () => {
  it("is the midpoint of a bounded range and the finite edge of an unbounded one", () => {
    expect(rangePoint({ lo: 1, hi: 2 })).toBeCloseTo(1.5)
    expect(rangePoint({ lo: -0.1, hi: 0.1 })).toBeCloseTo(0)
    expect(rangePoint({ lo: 4, hi: null })).toBe(4)
    expect(rangePoint({ lo: null, hi: -4 })).toBe(-4)
  })
})

describe("answerRange", () => {
  it("is null on point and skipped answers, the range otherwise", () => {
    expect(answerRange(ans({ eval: 1.2 }))).toBeNull()
    expect(answerRange(ans({ eval: null, skipped: true }))).toBeNull()
    expect(answerRange(ans({ eval: 1.5, eval_lo: 1, eval_hi: 2 }))).toEqual({ lo: 1, hi: 2 })
    expect(answerRange(ans({ eval: 4, eval_lo: 4, eval_hi: null }))).toEqual({ lo: 4, hi: null })
  })
})

describe("rangeError", () => {
  it("is 0 inside the range (edges inclusive), the edge distance outside", () => {
    const r = { lo: 1, hi: 2 }
    expect(rangeError(1.5, r)).toBe(0)
    expect(rangeError(1, r)).toBe(0)
    expect(rangeError(2, r)).toBe(0)
    expect(rangeError(0.5, r)).toBeCloseTo(0.5)
    expect(rangeError(3.2, r)).toBeCloseTo(1.2)
  })
  it("treats a null bound as unbounded", () => {
    expect(rangeError(11, { lo: 4, hi: null })).toBe(0) // "+4 or more", SF says +11
    expect(rangeError(3, { lo: 4, hi: null })).toBeCloseTo(1)
    expect(rangeError(-9, { lo: null, hi: -4 })).toBe(0)
    expect(rangeError(-2, { lo: null, hi: -4 })).toBeCloseTo(2)
  })
})

describe("scoredAnswers — range answers", () => {
  it("scores against the range edge (0 inside) and carries the range", () => {
    const s = session([
      pos({ sf_cp: 150 }), // inside 1–2
      pos({ sf_cp: 320 }), // above 1–2 by 1.2
      pos({ sf_cp: 600 }), // inside 4+
    ])
    const scored = scoredAnswers(s, [
      ans({ index: 0, eval: 1.5, eval_lo: 1, eval_hi: 2 }),
      ans({ index: 1, eval: 1.5, eval_lo: 1, eval_hi: 2 }),
      ans({ index: 2, eval: 4, eval_lo: 4, eval_hi: null }),
    ])
    expect(scored).toHaveLength(3)
    expect(scored[0].absError).toBe(0)
    expect(scored[0].userRange).toEqual({ lo: 1, hi: 2 })
    expect(scored[1].absError).toBeCloseTo(1.2)
    expect(scored[2].absError).toBe(0)
    // Point answers keep a null range and point-distance error.
    const pointScored = scoredAnswers(session([pos({ sf_cp: 150 })]), [ans({ index: 0, eval: 1.0 })])
    expect(pointScored[0].userRange).toBeNull()
    expect(pointScored[0].absError).toBeCloseTo(0.5)
  })

  it("recovers the derived point from the range if eval is missing", () => {
    const scored = scoredAnswers(session([pos({ sf_cp: 150 })]), [
      ans({ index: 0, eval: null, eval_lo: 1, eval_hi: 2 }),
    ])
    expect(scored).toHaveLength(1)
    expect(scored[0].userEval).toBeCloseTo(1.5)
  })
})

describe("summarize — range session", () => {
  it("MAE is range-aware and misses carry the asserted range", () => {
    const s = session([
      pos({ band: "0.5-1.5", sf_cp: 150 }), // in range → 0
      pos({ band: "3+", sf_cp: 450 }), // asserted 1–2, off by 2.5
    ])
    const sum = summarize(s, [
      ans({ index: 0, eval: 1.5, eval_lo: 1, eval_hi: 2 }),
      ans({ index: 1, eval: 1.5, eval_lo: 1, eval_hi: 2 }),
    ])
    expect(sum.mae).toBeCloseTo(1.25)
    expect(sum.biggestMisses[0].index).toBe(1)
    expect(sum.biggestMisses[0].userRange).toEqual({ lo: 1, hi: 2 })
    expect(sum.biggestMisses[0].absError).toBeCloseTo(2.5)
    // A point-session miss has userRange null (never retrofitted).
    const pointSum = summarize(session([pos({ sf_cp: 300 })]), [ans({ index: 0, eval: 0 })])
    expect(pointSum.biggestMisses[0].userRange).toBeNull()
  })
})

describe("formatRange", () => {
  it("renders bounded, unbounded, and level ranges White-POV", () => {
    expect(formatRange({ lo: 1, hi: 2 })).toBe("+1.0 to +2.0")
    expect(formatRange({ lo: 4, hi: null })).toBe("+4.0 or more")
    expect(formatRange({ lo: null, hi: -4 })).toBe("-4.0 or less")
    expect(formatRange({ lo: -0.1, hi: 0.1 })).toBe("-0.1 to +0.1")
  })
})

describe("normalizeAnswer — retroactive upgrade", () => {
  it("excludes the time of pre-think_ms answers", () => {
    // Simulate an old-schema answer (no think_ms / time_excluded fields).
    const old = { index: 0, eval: 1.2, why: "hi", move_uci: null, elapsed_ms: 339000, skipped: false }
    const up = normalizeAnswer(old as unknown as CalibrationAnswer)
    expect(up.think_ms).toBeNull()
    expect(up.time_excluded).toBe(true)
    // Pre-range point answers gain explicit null bounds — never a retrofitted
    // range (spec 213: ranges apply at new-session boundaries only).
    expect(up.eval_lo).toBeNull()
    expect(up.eval_hi).toBeNull()
    expect(answerRange(up)).toBeNull()
    // No lock timestamp on old answers → 0 (unknown), not undefined.
    expect(up.answer_locked_at).toBe(0)
    // Second-look + coach fields default to null when absent.
    expect(up.revised_eval).toBeNull()
    expect(up.revision_note).toBeNull()
    expect(up.revised_at).toBeNull()
    expect(up.coach).toBeNull()
    // Rebuttal-dialogue fields (2026-07-14) default to null on old answers.
    expect(up.rebuttal).toBeNull()
    expect(up.coach_reply).toBeNull()
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

describe("coachInputFor — v1 session tolerance", () => {
  // A stored v1 position: no to_move, played_*, continuation_san, or Elo fields.
  // Rust's CoachInput requires to_move, so sending undefined (dropped by JSON)
  // made every coach invoke fail with "missing field `to_move`".
  const v1Position = {
    fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
    sf_cp: 35,
    sf_mate: null,
    sf_best_uci: "g8f6",
    sf_best_san: "Nf6",
    multipv_gap_cp: 20,
    material: 0,
    band: "0-0.5",
    phase: "middlegame",
    game_id: 1,
    ply: 6,
  } as unknown as CalibrationPosition

  it("derives to_move from the FEN when the stored position predates the field", () => {
    const input = coachInputFor(ans({ why: "developing" }), v1Position)
    expect(input.to_move).toBe("black")
    const white = coachInputFor(ans({}), { ...v1Position, fen: "8/8/8/8/8/8/8/8 w - - 0 1" })
    expect(white.to_move).toBe("white")
  })

  it("survives a JSON round-trip with every Rust-required field present", () => {
    const wire = JSON.parse(JSON.stringify(coachInputFor(ans({ why: "x" }), v1Position)))
    for (const k of ["fen", "to_move", "user_why"]) expect(k in wire).toBe(true)
    // v2-only fields become explicit nulls, never dropped keys.
    expect(wire.played_san).toBeNull()
    expect(wire.continuation_san).toBeNull()
    expect(wire.white_elo).toBeNull()
    expect(wire.black_elo).toBeNull()
  })

  it("passes v2 fields through when present", () => {
    const input = coachInputFor(ans({}), pos({ played_san: "e4", white_elo: 1900 }))
    expect(input.played_san).toBe("e4")
    expect(input.white_elo).toBe(1900)
    expect(input.to_move).toBe("white")
  })

  it("passes the v3 engine line through, and nulls it when absent", () => {
    const withPv = coachInputFor(ans({}), pos({ sf_pv_san: ["e4", "e5", "Nf3"] }))
    expect(withPv.sf_pv_san).toEqual(["e4", "e5", "Nf3"])
    // A stored position without a PV (v1/v2, or the mock omitting it) → null,
    // never a dropped key (Rust's #[serde(default)] tolerates the null).
    const withoutPv = coachInputFor(ans({}), pos({}))
    expect(withoutPv.sf_pv_san).toBeNull()
  })

  it("carries the asserted range so the coach critiques the range, not the derived point", () => {
    const input = coachInputFor(ans({ eval: 1.5, eval_lo: 1, eval_hi: 2 }), pos({}))
    expect(input.user_eval_lo).toBe(1)
    expect(input.user_eval_hi).toBe(2)
    expect(input.user_eval).toBe(1.5) // the derived point rides along for back-compat
    // Point answers (and pre-range stored answers): explicit nulls on the wire,
    // never dropped keys.
    const wire = JSON.parse(JSON.stringify(coachInputFor(ans({ eval: 0.5 }), pos({}))))
    expect(wire.user_eval_lo).toBeNull()
    expect(wire.user_eval_hi).toBeNull()
    // Unbounded side survives the JSON round-trip as null.
    const open = JSON.parse(JSON.stringify(coachInputFor(ans({ eval: 4, eval_lo: 4, eval_hi: null }), pos({}))))
    expect(open.user_eval_lo).toBe(4)
    expect(open.user_eval_hi).toBeNull()
  })
})

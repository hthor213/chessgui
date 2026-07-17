// Phase-A profile lock-in (spec 213 adaptive elicitation) — the labeler
// profile and the deterministic lock-in reordering of a sampled session.

import { describe, it, expect } from "vitest"
import {
  PROFILE_LOCK_N,
  LOCK_IN_CAP,
  signedError,
  emptyProfile,
  profileOfSession,
  mergeProfiles,
  buildProfileFromResults,
  isRevealResults,
  lockInNeed,
  lockInPlan,
  applyLockIn,
  SPARSITY_WEIGHT,
  disagreementOf,
  cellKey,
  cellCounts,
  countsWithSession,
  phaseBScore,
  pickNext,
  promoteAt,
  phaseBReadout,
} from "@/lib/calibration-profile"
import { scoredAnswers, PHASES } from "@/lib/calibration-stats"
import type {
  CalibrationAnswer,
  CalibrationPosition,
  CalibrationResults,
  CalibrationSession,
  LabelerProfile,
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
    version: 3,
    n: positions.length,
    created_at: 0,
    stockfish_path: "(test)",
    positions,
  }
}

/** n middlegames followed by m endgames (deterministic fixture). */
function mixedPositions(mg: number, eg: number): CalibrationPosition[] {
  return [
    ...Array.from({ length: mg }, (_, i) => pos({ phase: "middlegame", game_id: 100 + i })),
    ...Array.from({ length: eg }, (_, i) => pos({ phase: "endgame", game_id: 200 + i })),
  ]
}

describe("signedError", () => {
  it("is user − SF on point answers (+ = leaned White)", () => {
    const s = session([pos({ sf_cp: 100 })])
    const scored = scoredAnswers(s, [ans({ index: 0, eval: 2.0 })])
    expect(signedError(scored[0])).toBeCloseTo(1.0)
    const under = scoredAnswers(s, [ans({ index: 0, eval: -0.5 })])
    expect(signedError(under[0])).toBeCloseTo(-1.5)
  })

  it("is the signed edge distance on range answers, 0 inside", () => {
    const s = session([pos({ sf_cp: 50 }), pos({ sf_cp: 150 }), pos({ sf_cp: 350 })])
    const scored = scoredAnswers(s, [
      ans({ index: 0, eval: 1.5, eval_lo: 1, eval_hi: 2 }), // SF below range → user too high, +0.5
      ans({ index: 1, eval: 1.5, eval_lo: 1, eval_hi: 2 }), // inside → 0
      ans({ index: 2, eval: 1.5, eval_lo: 1, eval_hi: 2 }), // SF above range → user too low, −1.5
    ])
    expect(signedError(scored[0])).toBeCloseTo(0.5)
    expect(signedError(scored[1])).toBe(0)
    expect(signedError(scored[2])).toBeCloseTo(-1.5)
  })
})

describe("profileOfSession", () => {
  it("builds the per-phase vector with count, MAE, and bias", () => {
    const s = session([
      pos({ phase: "middlegame", sf_cp: 100 }),
      pos({ phase: "middlegame", sf_cp: 0 }),
      pos({ phase: "endgame", sf_cp: 200 }),
      pos({ phase: "endgame", sf_cp: 0 }),
    ])
    const p = profileOfSession(s, [
      ans({ index: 0, eval: 2.0 }), // mg: +1.0
      ans({ index: 1, eval: -1.0 }), // mg: −1.0
      ans({ index: 2, eval: 2.0 }), // eg: 0
      ans({ index: 3, skipped: true, eval: null }), // ignored
    ])
    expect(p.sessions).toBe(1)
    expect(p.answers).toBe(3)
    expect(p.per_phase.map((c) => c.phase)).toEqual([...PHASES])
    const mg = p.per_phase.find((c) => c.phase === "middlegame")!
    expect(mg.count).toBe(2)
    expect(mg.mae).toBeCloseTo(1.0)
    expect(mg.bias).toBeCloseTo(0) // +1 and −1 cancel
    const eg = p.per_phase.find((c) => c.phase === "endgame")!
    expect(eg.count).toBe(1)
    expect(eg.mae).toBeCloseTo(0)
    // Overall: signed errors [1, −1, 0] → bias 0, population sd √(2/3).
    expect(p.bias).toBeCloseTo(0)
    expect(p.sd).toBeCloseTo(Math.sqrt(2 / 3))
  })

  it("is all-null/zero on an unanswered session", () => {
    const p = profileOfSession(session([pos({})]), [])
    expect(p.answers).toBe(0)
    expect(p.bias).toBeNull()
    expect(p.sd).toBeNull()
    expect(p.per_phase.every((c) => c.count === 0 && c.mae === null && c.bias === null)).toBe(true)
  })
})

describe("mergeProfiles", () => {
  it("merging per-session profiles equals computing over the concatenated answers", () => {
    const s1 = session([pos({ phase: "middlegame", sf_cp: 100 }), pos({ phase: "endgame", sf_cp: 0 })])
    const a1 = [ans({ index: 0, eval: 2.5 }), ans({ index: 1, eval: -0.5 })]
    const s2 = session([pos({ phase: "middlegame", sf_cp: -200 }), pos({ phase: "middlegame", sf_cp: 50 })])
    const a2 = [ans({ index: 0, eval: -1.0 }), ans({ index: 1, eval: 1.5 })]

    const merged = mergeProfiles(profileOfSession(s1, a1), profileOfSession(s2, a2))
    // Direct computation over one concatenated session (indices shifted).
    const direct = profileOfSession(session([...s1.positions, ...s2.positions]), [
      ...a1,
      ans({ index: 2, eval: -1.0 }),
      ans({ index: 3, eval: 1.5 }),
    ])
    expect(merged.answers).toBe(direct.answers)
    expect(merged.bias).toBeCloseTo(direct.bias!, 10)
    expect(merged.sd).toBeCloseTo(direct.sd!, 10)
    for (const phase of PHASES) {
      const m = merged.per_phase.find((c) => c.phase === phase)!
      const d = direct.per_phase.find((c) => c.phase === phase)!
      expect(m.count).toBe(d.count)
      if (d.mae == null) expect(m.mae).toBeNull()
      else expect(m.mae).toBeCloseTo(d.mae, 10)
      if (d.bias == null) expect(m.bias).toBeNull()
      else expect(m.bias).toBeCloseTo(d.bias, 10)
    }
    expect(merged.sessions).toBe(2)
  })

  it("merging with the empty profile is the identity", () => {
    const p = profileOfSession(session([pos({ sf_cp: 100 })]), [ans({ index: 0, eval: 0.5 })])
    const m = mergeProfiles(emptyProfile(), p)
    expect(m.answers).toBe(p.answers)
    expect(m.bias).toBeCloseTo(p.bias!)
    expect(m.sd).toBeCloseTo(p.sd!)
  })
})

describe("buildProfileFromResults", () => {
  it("is null with no usable results (fresh labeler ≠ empty profile)", () => {
    expect(buildProfileFromResults([])).toBeNull()
    // Malformed entries are skipped, not fatal.
    expect(buildProfileFromResults([{} as CalibrationResults, null as unknown as CalibrationResults])).toBeNull()
  })

  it("folds a stored v1 results file (point answers, pre-think_ms) — history survives schema upgrades", () => {
    // Shaped exactly like an old results file: v1 positions (no v2/v3 fields),
    // answers without think_ms/range fields.
    const v1Results = {
      version: 1,
      finished_at: 1,
      session: {
        version: 1,
        n: 2,
        created_at: 0,
        stockfish_path: "(old)",
        positions: [
          {
            fen: "8/8/8/8/8/8/8/8 w - - 0 1",
            sf_cp: 100,
            sf_mate: null,
            sf_best_uci: "e2e4",
            sf_best_san: "e4",
            multipv_gap_cp: null,
            material: 0,
            band: "0.5-1.5",
            phase: "middlegame",
            game_id: 1,
            ply: 20,
          },
          {
            fen: "8/8/8/8/8/8/8/8 w - - 0 1",
            sf_cp: 0,
            sf_mate: null,
            sf_best_uci: "e2e4",
            sf_best_san: "e4",
            multipv_gap_cp: null,
            material: 0,
            band: "0-0.5",
            phase: "endgame",
            game_id: 2,
            ply: 60,
          },
        ],
      },
      answers: [
        { index: 0, eval: 1.5, why: "", move_uci: null, elapsed_ms: 5000, skipped: false },
        { index: 1, eval: 0.5, why: "", move_uci: null, elapsed_ms: 5000, skipped: false },
      ],
    } as unknown as CalibrationResults
    const p = buildProfileFromResults([v1Results])!
    expect(p).not.toBeNull()
    expect(p.sessions).toBe(1)
    expect(p.answers).toBe(2)
    expect(p.per_phase.find((c) => c.phase === "middlegame")!.count).toBe(1)
    expect(p.per_phase.find((c) => c.phase === "endgame")!.count).toBe(1)
    expect(p.bias).toBeCloseTo(0.5)
  })
})

describe("blind/reveal split — cross-session aggregates never mix modes", () => {
  // A blind (show_reveal=false) session is methodologically distinct — no
  // feedback between positions (calibration-data-format.md) — so the prior
  // profile and the sparsity counts fold only same-mode sessions.
  const revealResults = {
    show_reveal: true,
    session: session([pos({ sf_cp: 100, band: "0.5-1.5" })]),
    answers: [ans({ index: 0, eval: 1.5 })], // signed error +0.5
  } as unknown as CalibrationResults
  const blindResults = {
    show_reveal: false,
    session: session([pos({ sf_cp: 200, band: "1.5-3", phase: "endgame" })]),
    answers: [ans({ index: 0, eval: 1.0 })], // signed error -1.0
  } as unknown as CalibrationResults
  const preFlagResults = {
    // Predates show_reveal entirely — every pre-flag session was a reveal run.
    session: session([pos({ sf_cp: 0, band: "0-0.5" })]),
    answers: [ans({ index: 0, eval: 0 })], // signed error 0
  } as unknown as CalibrationResults
  const all = [revealResults, blindResults, preFlagResults]

  it("isRevealResults: blind is false, explicit reveal and pre-flag files are true", () => {
    expect(isRevealResults(revealResults)).toBe(true)
    expect(isRevealResults(blindResults)).toBe(false)
    expect(isRevealResults(preFlagResults)).toBe(true)
  })

  it("buildProfileFromResults folds only the asked-for mode; omitted mode keeps the raw union", () => {
    const reveal = buildProfileFromResults(all, true)!
    expect(reveal.sessions).toBe(2) // reveal + pre-flag
    expect(reveal.answers).toBe(2)
    expect(reveal.bias).toBeCloseTo(0.25) // (+0.5 + 0) / 2 — the blind -1.0 never mixes in
    const blind = buildProfileFromResults(all, false)!
    expect(blind.sessions).toBe(1)
    expect(blind.bias).toBeCloseTo(-1.0)
    // No sessions of the asked-for mode ⇒ null (fresh labeler in that mode).
    expect(buildProfileFromResults([blindResults], true)).toBeNull()
    // Back-compat: no mode pools everything.
    expect(buildProfileFromResults(all)!.answers).toBe(3)
  })

  it("cellCounts filters by mode the same way", () => {
    expect(cellCounts(all, true)).toEqual({ "middlegame|0.5-1.5": 1, "middlegame|0-0.5": 1 })
    expect(cellCounts(all, false)).toEqual({ "endgame|1.5-3": 1 })
    expect(cellCounts(all)).toEqual({
      "middlegame|0.5-1.5": 1,
      "middlegame|0-0.5": 1,
      "endgame|1.5-3": 1,
    })
  })
})

describe("lockInNeed", () => {
  it("is the full PROFILE_LOCK_N per phase for a fresh labeler", () => {
    expect(lockInNeed(null)).toEqual(PHASES.map(() => PROFILE_LOCK_N))
  })

  it("credits prior answers per phase, floored at 0", () => {
    const prior: LabelerProfile = {
      sessions: 1,
      answers: 13,
      bias: 0,
      sd: 0.5,
      per_phase: [
        { phase: "middlegame", count: 5, mae: 0.6, bias: 0.1 },
        { phase: "endgame", count: 8, mae: 0.4, bias: 0 },
      ],
    }
    expect(lockInNeed(prior)).toEqual([PROFILE_LOCK_N - 5, 0])
  })
})

describe("lockInPlan / applyLockIn", () => {
  it("fresh labeler: a 16-position burst covering both phases, alternating from the neediest", () => {
    const positions = mixedPositions(20, 20)
    const { order, lockInCount } = lockInPlan(positions, null)
    expect(lockInCount).toBe(2 * PROFILE_LOCK_N) // 16, inside the spec's 10–20 band
    expect(lockInCount).toBeLessThanOrEqual(LOCK_IN_CAP)
    const burst = order.slice(0, lockInCount).map((i) => positions[i].phase)
    expect(burst.filter((p) => p === "middlegame")).toHaveLength(PROFILE_LOCK_N)
    expect(burst.filter((p) => p === "endgame")).toHaveLength(PROFILE_LOCK_N)
    // Equal needs alternate (tie → PHASES order first): mg, eg, mg, eg, …
    expect(burst.slice(0, 4)).toEqual(["middlegame", "endgame", "middlegame", "endgame"])
    // The plan is a permutation: every index exactly once.
    expect([...order].sort((a, b) => a - b)).toEqual(positions.map((_, i) => i))
    // After the burst, the original sampled order is preserved.
    const rest = order.slice(lockInCount)
    expect(rest).toEqual([...rest].sort((a, b) => a - b))
  })

  it("is deterministic: identical inputs give the identical order", () => {
    const positions = mixedPositions(12, 8)
    const a = lockInPlan(positions, null)
    const b = lockInPlan(positions, null)
    expect(a.order).toEqual(b.order)
    expect(a.lockInCount).toBe(b.lockInCount)
  })

  it("returning labeler: only the unpinned phase is drawn, most-needed first", () => {
    const prior: LabelerProfile = {
      sessions: 2,
      answers: 20,
      bias: 0.2,
      sd: 0.7,
      per_phase: [
        { phase: "middlegame", count: 12, mae: 0.8, bias: 0.3 }, // locked
        { phase: "endgame", count: 5, mae: 0.5, bias: 0 }, // needs 3 more
      ],
    }
    const positions = mixedPositions(10, 10)
    const { order, lockInCount } = lockInPlan(positions, prior)
    expect(lockInCount).toBe(3)
    expect(order.slice(0, 3).map((i) => positions[i].phase)).toEqual([
      "endgame",
      "endgame",
      "endgame",
    ])
  })

  it("fully locked profile: no burst, original order untouched", () => {
    const prior: LabelerProfile = {
      sessions: 3,
      answers: 40,
      bias: 0,
      sd: 0.6,
      per_phase: [
        { phase: "middlegame", count: 25, mae: 0.7, bias: 0.1 },
        { phase: "endgame", count: 15, mae: 0.5, bias: -0.1 },
      ],
    }
    const positions = mixedPositions(6, 4)
    const { order, lockInCount } = lockInPlan(positions, prior)
    expect(lockInCount).toBe(0)
    expect(order).toEqual(positions.map((_, i) => i))
  })

  it("a phase the sample can't supply takes what exists — no hang, burst shrinks", () => {
    const positions = mixedPositions(30, 2) // only 2 endgames available
    const { order, lockInCount } = lockInPlan(positions, null)
    expect(lockInCount).toBe(PROFILE_LOCK_N + 2)
    const burst = order.slice(0, lockInCount).map((i) => positions[i].phase)
    expect(burst.filter((p) => p === "endgame")).toHaveLength(2)
    expect([...order].sort((a, b) => a - b)).toEqual(positions.map((_, i) => i))
  })

  it("a session smaller than the burst is consumed whole, once each", () => {
    const positions = mixedPositions(3, 3)
    const { order, lockInCount } = lockInPlan(positions, null)
    expect(lockInCount).toBe(6)
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("applyLockIn reorders the session so answer indices track presentation order", () => {
    const s = session(mixedPositions(10, 10))
    const { session: reordered, lockInCount } = applyLockIn(s, null)
    expect(lockInCount).toBe(16)
    expect(reordered.positions).toHaveLength(20)
    // Same multiset of positions, burst-first order.
    expect(new Set(reordered.positions.map((p) => p.game_id)).size).toBe(20)
    expect(reordered.positions[0].phase).toBe("middlegame")
    expect(reordered.positions[1].phase).toBe("endgame")
    // The original session object is not mutated.
    expect(s.positions[1].phase).toBe("middlegame")
  })
})

// ---------------------------------------------------------------------------
// Phase B — model-driven selection (spec 213 adaptive elicitation)
// ---------------------------------------------------------------------------

describe("disagreementOf", () => {
  it("is the max−min Eval_R spread across the swept bands", () => {
    expect(disagreementOf([1.2, 1.2, 3.1])).toBeCloseTo(1.9)
    expect(disagreementOf([0.5, 0.5])).toBe(0)
    expect(disagreementOf([-1.0, 0.5, 2.0])).toBeCloseTo(3.0)
  })

  it("clamps mate-magnitude points so one blowup can't dominate the ranking", () => {
    // human_search collapses mates to ~±1000 pawns; the spread caps at ±12.
    expect(disagreementOf([1000, 0])).toBe(12)
    expect(disagreementOf([-1000, 1000])).toBe(24)
  })

  it("is null with fewer than two points (a cancelled sweep — retry, don't record)", () => {
    expect(disagreementOf([])).toBeNull()
    expect(disagreementOf([1.0])).toBeNull()
  })
})

describe("cellCounts / countsWithSession", () => {
  it("counts usable answers per phase × band cell across results, skipping skips and malformed files", () => {
    const s = session([
      pos({ phase: "middlegame", band: "0.5-1.5" }),
      pos({ phase: "endgame", band: "3+" }),
      pos({ phase: "middlegame", band: "0.5-1.5" }),
    ])
    const results = [
      {
        session: s,
        answers: [
          ans({ index: 0, eval: 1.0 }),
          ans({ index: 1, eval: 3.0 }),
          ans({ index: 2, eval: null, skipped: true }), // skipped → not a label
        ],
      } as unknown as CalibrationResults,
      {} as CalibrationResults, // malformed → skipped, never fatal
      null as unknown as CalibrationResults,
    ]
    expect(cellCounts(results)).toEqual({ "middlegame|0.5-1.5": 1, "endgame|3+": 1 })
    expect(cellCounts([])).toEqual({})
  })

  it("countsWithSession folds the running session's answers on top of the prior", () => {
    const s = session([pos({ phase: "endgame", band: "3+" }), pos({ phase: "middlegame", band: "0-0.5" })])
    const counts = countsWithSession({ "endgame|3+": 2 }, s, [ans({ index: 0, eval: 3 })])
    expect(counts["endgame|3+"]).toBe(3)
    expect(counts["middlegame|0-0.5"]).toBeUndefined() // unanswered → no label yet
    expect(cellKey(s.positions[1])).toBe("middlegame|0-0.5")
  })
})

describe("phaseBScore / pickNext", () => {
  it("an unlabeled cell is worth SPARSITY_WEIGHT, decaying as labels accumulate", () => {
    expect(phaseBScore(null, 0)).toBe(SPARSITY_WEIGHT)
    expect(phaseBScore(null, 1)).toBe(SPARSITY_WEIGHT / 2)
    expect(phaseBScore(1.5, 3)).toBeCloseTo(1.5 + SPARSITY_WEIGHT / 4)
  })

  it("picks the highest evaluator disagreement when coverage is equal", () => {
    const positions = [pos({ fen: "fenA" }), pos({ fen: "fenB" }), pos({ fen: "fenC" })]
    const spreads = { fenA: 0.4, fenB: 2.5, fenC: 0.5 }
    expect(pickNext(positions, 0, spreads, {})).toBe(1)
  })

  it("an unscored position in a thin cell outranks a small spread in a saturated cell", () => {
    const positions = [
      pos({ fen: "fenA", phase: "middlegame", band: "0.5-1.5" }), // scored, saturated cell
      pos({ fen: "fenB", phase: "endgame", band: "3+" }), // unscored, unseen cell
    ]
    // fenA: 0.3 + 2/6 ≈ 0.63; fenB: 0 + 2 = 2 → sparsity wins.
    const picked = pickNext(positions, 0, { fenA: 0.3 }, { "middlegame|0.5-1.5": 5 })
    expect(picked).toBe(1)
  })

  it("is deterministic — ties keep the earliest remaining position, and `from` bounds the scan", () => {
    const positions = [pos({ fen: "fenA" }), pos({ fen: "fenB" }), pos({ fen: "fenC" })]
    // All identical: the sampled order stands.
    expect(pickNext(positions, 0, {}, {})).toBe(0)
    expect(pickNext(positions, 1, {}, {})).toBe(1)
    // The best candidate BEFORE `from` (already presented) is never re-picked.
    expect(pickNext(positions, 1, { fenA: 9 }, {})).toBe(1)
    // Empty tail: returns `from` (the caller is at the end anyway).
    expect(pickNext(positions, 3, {}, {})).toBe(3)
  })
})

describe("promoteAt", () => {
  it("moves the pick into the slot, preserving everyone else's relative order", () => {
    const s = session([0, 1, 2, 3, 4].map((i) => pos({ game_id: i })))
    const out = promoteAt(s, 2, 4)
    expect(out.positions.map((p) => p.game_id)).toEqual([0, 1, 4, 2, 3])
    // Already-answered slots (below `to`) never move — committed answer
    // indices stay valid.
    expect(out.positions[0].game_id).toBe(0)
    expect(out.positions[1].game_id).toBe(1)
    // The original session is not mutated.
    expect(s.positions.map((p) => p.game_id)).toEqual([0, 1, 2, 3, 4])
  })

  it("is a no-op (same object) when the pick is already in the slot", () => {
    const s = session([pos({}), pos({})])
    expect(promoteAt(s, 1, 1)).toBe(s)
  })
})

describe("phaseBReadout", () => {
  it("is null until anything is labeled", () => {
    expect(phaseBReadout({})).toBeNull()
  })

  it("names the most saturated cell and the bottleneck, deterministically", () => {
    const readout = phaseBReadout({ "middlegame|0.5-1.5": 5, "endgame|3+": 1 })!
    expect(readout).toContain("middlegame 0.5-1.5 is the most saturated (5 labels)")
    // Bottleneck is the first zero-count cell in PHASES × BANDS order.
    expect(readout).toContain("middlegame 0-0.5 is the bottleneck (0)")
  })
})

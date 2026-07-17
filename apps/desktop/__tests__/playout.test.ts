// Verdict math + plumbing for "Play it out" (spec 211 checklist item /
// spec 215 Tier 1 endgame_playout) — lib/playout.

import { describe, it, expect } from "vitest"
import { Chess } from "chessops/chess"
import { parseFen } from "chessops/fen"
import {
  ABANDON_RESULT_LABEL,
  CLAIM_WIN_PROB,
  DEFAULT_PLAYOUT_LEVEL,
  TRAINING_PLAYOUT_DECK,
  VERDICT_LABELS,
  appendPlayoutResult,
  buildPlayoutAbandon,
  buildPlayoutResult,
  claimFor,
  claimedScore,
  egConversion,
  EG_CONVERSION_WINDOW_DAYS,
  evalPawnsOf,
  expectedScoreFor,
  levelForEloBand,
  normalizePlayoutResult,
  outcomeScore,
  pickTrainingPlayout,
  playoutUserSide,
  playoutVerdict,
  removePlayoutResult,
  setPlayoutCountsToward,
  type PlayoutResultEntry,
} from "@/lib/playout"
import { turnOf } from "@/lib/spar"

describe("evalPawnsOf", () => {
  it("converts centipawns to pawns", () => {
    expect(evalPawnsOf(210, null)).toBeCloseTo(2.1)
    expect(evalPawnsOf(-95, null)).toBeCloseTo(-0.95)
  })

  it("pins mates to the tournament mate cap by sign", () => {
    expect(evalPawnsOf(null, 3)).toBe(10)
    expect(evalPawnsOf(null, -2)).toBe(-10)
    // Mate wins over cp when both are somehow present.
    expect(evalPawnsOf(50, -1)).toBe(-10)
  })

  it("degrades to 0 when both fields are null", () => {
    expect(evalPawnsOf(null, null)).toBe(0)
  })
})

describe("playoutUserSide", () => {
  it("assigns the favoured side, regardless of who moves first", () => {
    expect(playoutUserSide(2.1, "white")).toBe("white")
    expect(playoutUserSide(2.1, "black")).toBe("white")
    expect(playoutUserSide(-1.7, "white")).toBe("black")
    expect(playoutUserSide(-1.7, "black")).toBe("black")
  })

  it("gives a dead-level claim to the side to move", () => {
    expect(playoutUserSide(0, "black")).toBe("black")
    expect(playoutUserSide(0, "white")).toBe("white")
  })
})

describe("expectedScoreFor", () => {
  it("is 0.5 at a level eval, for either side", () => {
    expect(expectedScoreFor(0, "white")).toBeCloseTo(0.5)
    expect(expectedScoreFor(0, "black")).toBeCloseTo(0.5)
  })

  it("is symmetric: white's expectation on +e equals black's on -e", () => {
    for (const e of [0.5, 1.5, 3, 10]) {
      expect(expectedScoreFor(e, "white")).toBeCloseTo(expectedScoreFor(-e, "black"))
    }
  })

  it("increases with the favoured side's eval and stays in (0,1)", () => {
    let prev = 0
    for (const e of [0, 0.5, 1, 2, 4, 10]) {
      const p = expectedScoreFor(e, "white")
      expect(p).toBeGreaterThanOrEqual(prev)
      expect(p).toBeGreaterThan(0)
      expect(p).toBeLessThan(1)
      prev = p
    }
  })

  it("the favoured side's expectation is always >= 0.5 (claim precondition)", () => {
    for (const e of [0.1, 0.6, 1.5, 3, 10]) {
      expect(expectedScoreFor(e, playoutUserSide(e, "white"))).toBeGreaterThanOrEqual(0.5)
      expect(expectedScoreFor(-e, playoutUserSide(-e, "white"))).toBeGreaterThanOrEqual(0.5)
    }
  })
})

describe("claimFor", () => {
  it("claims a win for the conversion band (+1.5 to +3) and beyond", () => {
    expect(claimFor(expectedScoreFor(1.5, "white"))).toBe("win")
    expect(claimFor(expectedScoreFor(2, "white"))).toBe("win")
    expect(claimFor(expectedScoreFor(3, "white"))).toBe("win")
    expect(claimFor(expectedScoreFor(-2, "black"))).toBe("win")
  })

  it("claims a hold for the level band (±0.5)", () => {
    expect(claimFor(expectedScoreFor(0, "white"))).toBe("draw")
    expect(claimFor(expectedScoreFor(0.5, "white"))).toBe("draw")
    expect(claimFor(expectedScoreFor(-0.5, "black"))).toBe("draw")
  })

  it("cuts exactly at CLAIM_WIN_PROB", () => {
    expect(claimFor(CLAIM_WIN_PROB)).toBe("win")
    expect(claimFor(CLAIM_WIN_PROB - 1e-9)).toBe("draw")
  })
})

describe("playoutVerdict", () => {
  it("win claimed: win converts, draw holds, loss drops", () => {
    expect(playoutVerdict("win", 1)).toBe("converted")
    expect(playoutVerdict("win", 0.5)).toBe("held")
    expect(playoutVerdict("win", 0)).toBe("dropped")
  })

  it("hold claimed: draw or better converts, loss drops (never 'held')", () => {
    expect(playoutVerdict("draw", 1)).toBe("converted")
    expect(playoutVerdict("draw", 0.5)).toBe("converted")
    expect(playoutVerdict("draw", 0)).toBe("dropped")
  })

  it("claimedScore/outcomeScore agree with the verdict inputs", () => {
    expect(claimedScore("win")).toBe(1)
    expect(claimedScore("draw")).toBe(0.5)
    expect(outcomeScore("win")).toBe(1)
    expect(outcomeScore("draw")).toBe(0.5)
    expect(outcomeScore("loss")).toBe(0)
  })
})

describe("levelForEloBand", () => {
  it("maps the calibration Elo bands into the published Maia set", () => {
    expect(levelForEloBand("<1600")).toBe(1500)
    expect(levelForEloBand("1600-2000")).toBe(1800)
    expect(levelForEloBand("2000-2400")).toBe(1900)
    expect(levelForEloBand("2400+")).toBe(1900)
  })

  it("falls back to the default for unknown bands", () => {
    expect(levelForEloBand("")).toBe(DEFAULT_PLAYOUT_LEVEL)
    expect(levelForEloBand("nonsense")).toBe(DEFAULT_PLAYOUT_LEVEL)
  })
})

describe("buildPlayoutResult", () => {
  const base = {
    source: "calibration" as const,
    fen: "8/8/4k3/8/4K3/8/3R4/8 w - - 0 1",
    evalPawns: 2.1,
    userSide: "white" as const,
    level: 1700,
    mode: "serious" as const,
    plies: 40,
  }

  it("scores a checkmate win as converted on a win claim", () => {
    const e = buildPlayoutResult({
      ...base,
      positionId: "42:31",
      resultLabel: "Checkmate — White wins",
    })
    expect(e).not.toBeNull()
    expect(e!.kind).toBe("playout")
    expect(e!.positionId).toBe("42:31")
    expect(e!.claim).toBe("win")
    expect(e!.result).toBe("win")
    expect(e!.actualScore).toBe(1)
    expect(e!.verdict).toBe("converted")
    expect(e!.expectedScore).toBeCloseTo(expectedScoreFor(2.1, "white"))
  })

  it("scores a stalemate as held on a win claim", () => {
    const e = buildPlayoutResult({ ...base, resultLabel: "Draw — stalemate" })
    expect(e!.result).toBe("draw")
    expect(e!.verdict).toBe("held")
  })

  it("scores a resignation as dropped", () => {
    const e = buildPlayoutResult({ ...base, resultLabel: "You resigned — 0-1" })
    expect(e!.result).toBe("loss")
    expect(e!.verdict).toBe("dropped")
  })

  it("scores the black side correctly", () => {
    const e = buildPlayoutResult({
      ...base,
      evalPawns: -2.1,
      userSide: "black",
      resultLabel: "Checkmate — Black wins",
    })
    expect(e!.claim).toBe("win")
    expect(e!.verdict).toBe("converted")
  })

  it("hold claim: draw agreed converts, loss drops", () => {
    const level = { ...base, evalPawns: 0.2 }
    expect(buildPlayoutResult({ ...level, resultLabel: "Draw agreed — ½–½" })!.verdict).toBe(
      "converted",
    )
    expect(buildPlayoutResult({ ...level, resultLabel: "Checkmate — Black wins" })!.verdict).toBe(
      "dropped",
    )
  })

  it("returns null on an unknown label (record nothing, never guess)", () => {
    expect(buildPlayoutResult({ ...base, resultLabel: "Game ended (not recorded)" })).toBeNull()
  })

  it("declared intent: serious counts by default, explicit toggle respected", () => {
    const label = "Checkmate — White wins"
    expect(buildPlayoutResult({ ...base, resultLabel: label })!.countsTowardTraining).toBe(true)
    expect(
      buildPlayoutResult({ ...base, resultLabel: label, countsTowardTraining: false })!
        .countsTowardTraining,
    ).toBe(false)
  })

  it("probe never counts, even when the toggle claims otherwise", () => {
    const e = buildPlayoutResult({
      ...base,
      mode: "probe",
      resultLabel: "Checkmate — White wins",
      countsTowardTraining: true,
    })!
    expect(e.mode).toBe("probe")
    expect(e.countsTowardTraining).toBe(false)
  })

  it("carries the spar anomaly flags (flag, never drop)", () => {
    const short = buildPlayoutResult({ ...base, plies: 8, resultLabel: "Checkmate — White wins" })!
    expect(short.anomalyFlags).toContain("short_game")
    const resign = buildPlayoutResult({ ...base, plies: 10, resultLabel: "You resigned — 0-1" })!
    expect(resign.anomalyFlags).toContain("early_resign")
    const clean = buildPlayoutResult({ ...base, resultLabel: "Checkmate — White wins" })!
    expect(clean.anomalyFlags).toEqual([])
  })
})

describe("buildPlayoutAbandon (mid-playout exit, spec 215 hardening)", () => {
  const base = {
    source: "training" as const,
    fen: "8/8/4k3/8/4K3/8/3R4/8 w - - 0 1",
    positionId: "kr-vs-k",
    evalPawns: 6.5,
    userSide: "white" as const,
    level: 1700,
    mode: "serious" as const,
    plies: 17,
    elapsedMs: 93_000,
  }

  it("records an abandoned entry with position id, plies, and elapsed time", () => {
    const e = buildPlayoutAbandon(base)
    expect(e.kind).toBe("playout")
    expect(e.verdict).toBe("abandoned")
    expect(e.positionId).toBe("kr-vs-k")
    expect(e.plies).toBe(17)
    expect(e.elapsedMs).toBe(93_000)
    expect(e.resultLabel).toBe(ABANDON_RESULT_LABEL)
    expect(VERDICT_LABELS[e.verdict]).toBe("Abandoned")
  })

  it("has no result to score: result/actualScore null, no anomaly proxies", () => {
    const e = buildPlayoutAbandon(base)
    expect(e.result).toBeNull()
    expect(e.actualScore).toBeNull()
    expect(e.anomalyFlags).toEqual([])
    // The claim itself is still real — it's the position's property.
    expect(e.claim).toBe("win")
    expect(e.expectedScore).toBeCloseTo(expectedScoreFor(6.5, "white"))
  })

  it("never counts toward training, regardless of mode", () => {
    expect(buildPlayoutAbandon(base).countsTowardTraining).toBe(false)
    expect(buildPlayoutAbandon({ ...base, mode: "probe" }).countsTowardTraining).toBe(false)
  })

  it("cannot be reclassified to counting (no result to count)", () => {
    const e = { ...buildPlayoutAbandon(base), id: "ab" }
    const next = setPlayoutCountsToward([e], "ab", true)
    expect(next[0].countsTowardTraining).toBe(false)
    expect(next[0].reclassifiedAt).toBeUndefined()
  })

  it("survives normalizePlayoutResult untouched (null result, empty flags)", () => {
    const e = buildPlayoutAbandon(base)
    const n = normalizePlayoutResult(e)
    expect(n).toEqual(e)
    // Legacy-shaped abandon (flags stripped): no result → no anomaly proxies.
    const stripped = { ...e } as Record<string, unknown>
    delete stripped.anomalyFlags
    expect(normalizePlayoutResult(stripped as unknown as PlayoutResultEntry).anomalyFlags).toEqual(
      [],
    )
  })
})

describe("store operations", () => {
  it("append and remove are pure and id-keyed", () => {
    const a = buildPlayoutResult({
      source: "training",
      fen: "8/8/4k3/8/4K3/8/3R4/8 w - - 0 1",
      evalPawns: 6.5,
      userSide: "white",
      level: 1700,
      mode: "serious",
      plies: 12,
      resultLabel: "Checkmate — White wins",
    })!
    const list = appendPlayoutResult([], a)
    expect(list).toHaveLength(1)
    expect(removePlayoutResult(list, a.id)).toHaveLength(0)
    expect(removePlayoutResult(list, "nope")).toHaveLength(1)
  })
})

describe("setPlayoutCountsToward", () => {
  const entry = (over: Partial<PlayoutResultEntry>): PlayoutResultEntry =>
    ({
      ...buildPlayoutResult({
        source: "training",
        fen: "8/8/4k3/8/4K3/8/3R4/8 w - - 0 1",
        evalPawns: 2.1,
        userSide: "white",
        level: 1700,
        mode: "serious",
        plies: 40,
        resultLabel: "Checkmate — White wins",
      })!,
      ...over,
    })

  it("flips serious games and stamps reclassifiedAt", () => {
    const a = entry({ id: "a" })
    const next = setPlayoutCountsToward([a], "a", false, "2026-07-15T00:00:00Z")
    expect(next[0].countsTowardTraining).toBe(false)
    expect(next[0].reclassifiedAt).toBe("2026-07-15T00:00:00Z")
  })

  it("never flips a probe game to counting", () => {
    const p = entry({ id: "p", mode: "probe", countsTowardTraining: false })
    const next = setPlayoutCountsToward([p], "p", true)
    expect(next[0].countsTowardTraining).toBe(false)
    expect(next[0].reclassifiedAt).toBeUndefined()
  })

  it("is a no-op for other ids and unchanged values", () => {
    const a = entry({ id: "a" })
    expect(setPlayoutCountsToward([a], "other", false)[0]).toBe(a)
    expect(setPlayoutCountsToward([a], "a", true)[0]).toBe(a)
  })
})

describe("normalizePlayoutResult (legacy entries)", () => {
  it("backfills serious/counting and recomputes anomaly flags", () => {
    const legacy = {
      ...buildPlayoutResult({
        source: "calibration",
        fen: "8/8/4k3/8/4K3/8/3R4/8 w - - 0 1",
        evalPawns: 2.1,
        userSide: "white",
        level: 1700,
        mode: "serious",
        plies: 8,
        resultLabel: "Checkmate — White wins",
      })!,
    } as Record<string, unknown>
    delete legacy.mode
    delete legacy.countsTowardTraining
    delete legacy.anomalyFlags
    const n = normalizePlayoutResult(legacy as unknown as PlayoutResultEntry)
    expect(n.mode).toBe("serious")
    expect(n.countsTowardTraining).toBe(true)
    expect(n.anomalyFlags).toContain("short_game")
  })

  it("leaves entries that already carry the fields untouched", () => {
    const e = buildPlayoutResult({
      source: "training",
      fen: "8/8/4k3/8/4K3/8/3R4/8 w - - 0 1",
      evalPawns: 2.1,
      userSide: "white",
      level: 1700,
      mode: "probe",
      plies: 40,
      resultLabel: "Checkmate — White wins",
    })!
    const n = normalizePlayoutResult(e)
    expect(n.mode).toBe("probe")
    expect(n.countsTowardTraining).toBe(false)
    expect(n.anomalyFlags).toEqual(e.anomalyFlags)
  })
})

describe("egConversion (verdict aggregation)", () => {
  const NOW = Date.parse("2026-07-15T12:00:00Z")
  const game = (over: Partial<PlayoutResultEntry>): PlayoutResultEntry => ({
    ...buildPlayoutResult({
      source: "training",
      fen: "8/8/4k3/8/4K3/8/3R4/8 w - - 0 1",
      evalPawns: 2.1, // win claim
      userSide: "white",
      level: 1700,
      mode: "serious",
      plies: 40,
      resultLabel: "Checkmate — White wins",
      at: "2026-07-10T10:00:00Z",
    })!,
    ...over,
  })

  it("computes converted / games over counting win-claim playouts", () => {
    const c = egConversion(
      [game({}), game({ verdict: "held" }), game({ verdict: "dropped" }), game({})],
      NOW,
    )
    expect(c.games).toBe(4)
    expect(c.converted).toBe(2)
    expect(c.held).toBe(1)
    expect(c.dropped).toBe(1)
    expect(c.rate).toBeCloseTo(0.5)
  })

  it("excludes probe, unticked, and hold-claim playouts", () => {
    const c = egConversion(
      [
        game({}),
        game({ mode: "probe", countsTowardTraining: false }),
        game({ countsTowardTraining: false }),
        game({ claim: "draw" }),
      ],
      NOW,
    )
    expect(c.games).toBe(1)
    expect(c.rate).toBe(1)
  })

  it("never aggregates abandons — even hand-flipped to counting", () => {
    const abandon = buildPlayoutAbandon({
      source: "training",
      fen: "8/8/4k3/8/4K3/8/3R4/8 w - - 0 1",
      evalPawns: 2.1, // win claim, like the finished games
      userSide: "white",
      level: 1700,
      mode: "serious",
      plies: 17,
      elapsedMs: 60_000,
      at: "2026-07-10T10:00:00Z",
    })
    const c = egConversion([game({}), abandon, { ...abandon, countsTowardTraining: true }], NOW)
    expect(c.games).toBe(1)
    expect(c.rate).toBe(1)
  })

  it("includes flagged games and reports the count (flag, never drop)", () => {
    const c = egConversion([game({ anomalyFlags: ["short_game"], verdict: "dropped" })], NOW)
    expect(c.games).toBe(1)
    expect(c.flagged).toBe(1)
    expect(c.rate).toBe(0)
  })

  it("windows by date and returns null with nothing to measure", () => {
    const old = game({
      at: new Date(NOW - (EG_CONVERSION_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString(),
    })
    const c = egConversion([old], NOW)
    expect(c.games).toBe(0)
    expect(c.rate).toBeNull()
  })
})

describe("curated training deck", () => {
  it("every position is a legal, non-terminal FEN", () => {
    for (const p of TRAINING_PLAYOUT_DECK) {
      const setup = parseFen(p.fen)
      expect(setup.isErr, `${p.id}: FEN parses`).toBe(false)
      const pos = Chess.fromSetup(setup.unwrap())
      expect(pos.isErr, `${p.id}: position legal`).toBe(false)
      expect(pos.unwrap().isEnd(), `${p.id}: not already over`).toBe(false)
    }
  })

  it("every position claims a win for the user's side (conversion training)", () => {
    for (const p of TRAINING_PLAYOUT_DECK) {
      const side = playoutUserSide(p.evalPawns, turnOf(p.fen))
      expect(claimFor(expectedScoreFor(p.evalPawns, side)), p.id).toBe("win")
    }
  })

  it("pickTrainingPlayout returns a training request for each deck slot", () => {
    for (let i = 0; i < TRAINING_PLAYOUT_DECK.length; i++) {
      const r = pickTrainingPlayout(() => i / TRAINING_PLAYOUT_DECK.length)
      expect(r.source).toBe("training")
      expect(r.fen).toBe(TRAINING_PLAYOUT_DECK[i].fen)
      expect(r.label).toBe(TRAINING_PLAYOUT_DECK[i].name)
      expect(r.positionId).toBe(TRAINING_PLAYOUT_DECK[i].id)
    }
  })
})

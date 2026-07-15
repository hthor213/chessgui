// Verdict math + plumbing for "Play it out" (spec 211 checklist item /
// spec 215 Tier 1 endgame_playout) — lib/playout.

import { describe, it, expect } from "vitest"
import { Chess } from "chessops/chess"
import { parseFen } from "chessops/fen"
import {
  CLAIM_WIN_PROB,
  DEFAULT_PLAYOUT_LEVEL,
  TRAINING_PLAYOUT_DECK,
  appendPlayoutResult,
  buildPlayoutResult,
  claimFor,
  claimedScore,
  evalPawnsOf,
  expectedScoreFor,
  levelForEloBand,
  outcomeScore,
  pickTrainingPlayout,
  playoutUserSide,
  playoutVerdict,
  removePlayoutResult,
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
    plies: 40,
  }

  it("scores a checkmate win as converted on a win claim", () => {
    const e = buildPlayoutResult({ ...base, resultLabel: "Checkmate — White wins" })
    expect(e).not.toBeNull()
    expect(e!.kind).toBe("playout")
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
})

describe("store operations", () => {
  it("append and remove are pure and id-keyed", () => {
    const a = buildPlayoutResult({
      source: "training",
      fen: "8/8/4k3/8/4K3/8/3R4/8 w - - 0 1",
      evalPawns: 6.5,
      userSide: "white",
      level: 1700,
      plies: 12,
      resultLabel: "Checkmate — White wins",
    })!
    const list = appendPlayoutResult([], a)
    expect(list).toHaveLength(1)
    expect(removePlayoutResult(list, a.id)).toHaveLength(0)
    expect(removePlayoutResult(list, "nope")).toHaveLength(1)
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
    }
  })
})

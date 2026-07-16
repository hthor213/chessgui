// Spec 900 tablebase surfacing — the two gates every probe must clear.
// Eligibility (<=7 men) keeps us off the API for positions it can't answer;
// the spec 219 gate pins that tablebase lookups follow the exact same
// active-game lockout semantics as the engine (ambiguity resolves to OFF).
// hooks/use-tablebase.ts checks both before any invoke; the Rust command
// (match_runner.rs tablebase_probe) re-checks the lockout defensively.

import { describe, it, expect } from "vitest"
import {
  TABLEBASE_MAX_MEN,
  fenMenCount,
  tablebaseAllowedForGame,
  tablebaseEligible,
  tbVerdictLabel,
} from "@chessgui/core/tablebase"
import { engineAllowedForGame, type ActiveGameMeta } from "@chessgui/core/active-game"

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
const KQK_FEN = "4k3/8/8/8/8/8/8/4K2Q w - - 0 1"

const meta: ActiveGameMeta = {
  opponent: "rival",
  chesscomUsername: "me",
  gameUrl: "https://www.chess.com/game/daily/1",
  flaggedAt: 0,
}

describe("tablebase eligibility (<=7 men)", () => {
  it("counts men from the piece-placement field only", () => {
    expect(fenMenCount(START_FEN)).toBe(32)
    expect(fenMenCount(KQK_FEN)).toBe(3)
    expect(fenMenCount("8/8/8/8/8/8/8/8 w - - 0 1")).toBe(0)
    expect(fenMenCount("")).toBe(0)
  })

  it("accepts exactly TABLEBASE_MAX_MEN and rejects one more", () => {
    // 7 men: KQRvKQR + a pawn.
    expect(tablebaseEligible("4k3/8/8/8/8/8/P7/RQ2K1qr w - - 0 1")).toBe(true)
    expect(fenMenCount("4k3/8/8/8/8/8/P7/RQ2K1qr w - - 0 1")).toBe(TABLEBASE_MAX_MEN)
    expect(tablebaseEligible("4k3/8/8/8/8/8/PP6/RQ2K1qr w - - 0 1")).toBe(false)
  })

  it("rejects the start position and empty/malformed FENs", () => {
    expect(tablebaseEligible(START_FEN)).toBe(false)
    expect(tablebaseEligible("")).toBe(false)
    expect(tablebaseEligible("   ")).toBe(false)
  })
})

describe("spec 219 lockout gate", () => {
  it("allows a probe only for a known non-active game (null)", () => {
    expect(tablebaseAllowedForGame(null)).toBe(true)
  })

  it("refuses for a flagged active game", () => {
    expect(tablebaseAllowedForGame(meta)).toBe(false)
  })

  it("resolves ambiguity (undefined) to OFF, like the engine gate", () => {
    expect(tablebaseAllowedForGame(undefined)).toBe(false)
  })

  it("never diverges from the engine lockout predicate", () => {
    // Tablebase IS engine-class assistance: same inputs, same answer.
    for (const g of [null, undefined, meta] as const) {
      expect(tablebaseAllowedForGame(g)).toBe(engineAllowedForGame(g))
    }
  })
})

describe("tbVerdictLabel", () => {
  it("orients the side-to-move category to color names", () => {
    expect(tbVerdictLabel("win", "white")).toBe("White wins")
    expect(tbVerdictLabel("win", "black")).toBe("Black wins")
    expect(tbVerdictLabel("loss", "white")).toBe("Black wins")
    expect(tbVerdictLabel("loss", "black")).toBe("White wins")
  })

  it("maps cursed/blessed and unknown categories to draw", () => {
    expect(tbVerdictLabel("cursed-win", "white")).toBe("Draw (50-move rule)")
    expect(tbVerdictLabel("blessed-loss", "black")).toBe("Draw (50-move rule)")
    expect(tbVerdictLabel("draw", "white")).toBe("Draw")
    expect(tbVerdictLabel("maybe-win", "white")).toBe("Draw")
  })
})

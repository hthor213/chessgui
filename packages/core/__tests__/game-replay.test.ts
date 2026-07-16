// SAN reconstruction + move-numbering (spec 218 "Exhibition & tournament"
// checklist item 3 — the exhibition viewer's numbered SAN move list) and the
// existing replay/PGN helpers it's factored out of.

import { describe, it, expect } from "vitest"
import { replayFens, movesToPgn, sansFromUci, numberMoves } from "@chessgui/core/game-replay"

const STANDARD_START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
// 1.e4 e5 2.Nf3
const OPENING = ["e2e4", "e7e5", "g1f3"]
// A Black-to-move start (spec 218's "move numbers ... including a Black-to-
// move start" — mirrors the existing movesToPgn guarantee).
const BLACK_TO_MOVE_FEN = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"

describe("sansFromUci", () => {
  it("reconstructs SAN for a standard-start opening", () => {
    expect(sansFromUci(STANDARD_START, OPENING)).toEqual(["e4", "e5", "Nf3"])
  })

  it("truncates at the first illegal/unparseable move without throwing", () => {
    expect(sansFromUci(STANDARD_START, ["e2e4", "not-a-move", "g1f3"])).toEqual(["e4"])
  })

  it("is empty for an empty move list", () => {
    expect(sansFromUci(STANDARD_START, [])).toEqual([])
  })
})

describe("numberMoves", () => {
  it("pairs SAN into numbered White/Black rows from a standard start", () => {
    const sans = sansFromUci(STANDARD_START, OPENING)
    expect(numberMoves(STANDARD_START, sans)).toEqual([
      { no: 1, white: "e4", black: "e5" },
      { no: 2, white: "Nf3" },
    ])
  })

  it("opens on a bare Black row for a Black-to-move start", () => {
    const sans = sansFromUci(BLACK_TO_MOVE_FEN, ["b8c6"])
    expect(sans).toEqual(["Nc6"])
    expect(numberMoves(BLACK_TO_MOVE_FEN, sans)).toEqual([{ no: 1, black: "Nc6" }])
  })

  it("is empty for an empty SAN list", () => {
    expect(numberMoves(STANDARD_START, [])).toEqual([])
  })
})

describe("movesToPgn still round-trips through the shared sansFromUci path", () => {
  it("produces the same SAN tokens as sansFromUci for a standard game", () => {
    const pgn = movesToPgn(STANDARD_START, OPENING, "*")
    for (const san of sansFromUci(STANDARD_START, OPENING)) {
      expect(pgn).toContain(san)
    }
  })
})

describe("replayFens (unchanged by the sansFromUci refactor)", () => {
  it("still returns one FEN per ply plus the start position", () => {
    expect(replayFens(STANDARD_START, OPENING)).toHaveLength(OPENING.length + 1)
  })
})

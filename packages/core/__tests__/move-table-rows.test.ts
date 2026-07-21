// Row-building and time formatting for the fair-play move table (spec 219 F).
//
// The table is the chess.com Daily shape — one row per move number, White and
// Black side by side — so the pairing logic has to survive the cases a plain
// "chunk the move list in twos" would get wrong: a game that starts with
// Black to move, and variations attached mid-row.

import { describe, expect, it } from "vitest"
import { GameTree } from "../src/game-tree"
import { buildRows, formatMoveTime } from "../../ui/src/move-table"
import { moverIsWhite, moveSlot } from "../src/game-tree"

describe("formatMoveTime — chess.com daily [%clk] is time SPENT", () => {
  it("scales from seconds to days the way the source layout does", () => {
    expect(formatMoveTime(45)).toBe("45s")
    expect(formatMoveTime(60)).toBe("1 min")
    expect(formatMoveTime(31 * 60)).toBe("31 mins")
    expect(formatMoveTime(3600)).toBe("1 hr")
    expect(formatMoveTime(18 * 3600)).toBe("18 hrs")
    expect(formatMoveTime(48 * 3600)).toBe("2 days")
  })

  it("renders nothing for a move with no clock tag", () => {
    expect(formatMoveTime(undefined)).toBe("")
  })
})

describe("buildRows", () => {
  it("pairs White and Black under one move number", () => {
    const tree = GameTree.create()
    tree.addMoveSan("e4")
    tree.addMoveSan("e5")
    tree.addMoveSan("Nf3")

    const rows = buildRows(tree)
    expect(rows).toHaveLength(2)
    expect(rows[0].moveNo).toBe(1)
    expect(rows[0].white?.san).toBe("e4")
    expect(rows[0].black?.san).toBe("e5")
    expect(rows[1].white?.san).toBe("Nf3")
    expect(rows[1].black).toBeUndefined()
  })

  it("handles a game that starts with Black to move — no phantom White cell", () => {
    // A position set up mid-game with Black on move: the first row must have
    // an empty White side rather than shifting every pair by one.
    const tree = GameTree.create(
      "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    )
    tree.addMoveSan("Nc6")
    const rows = buildRows(tree)
    expect(rows[0].white).toBeUndefined()
    expect(rows[0].black?.san).toBe("Nc6")
  })

  it("attaches variations to the move they branch from", () => {
    const tree = GameTree.create()
    tree.addMoveSan("e4")
    const afterE4 = tree.currentId
    tree.addMoveSan("e5")
    tree.goTo(afterE4)
    tree.addMoveSan("c5") // a variation on Black's first move

    const rows = buildRows(tree)
    expect(rows[0].variations).toHaveLength(1)
    expect(rows[0].variations[0].headIds).toHaveLength(1)
    expect(tree.get(rows[0].variations[0].headIds[0])!.san).toBe("c5")
  })

  it("returns nothing for an empty game", () => {
    expect(buildRows(GameTree.create())).toEqual([])
  })
})

describe("moverIsWhite / moveSlot — derived from FEN, not ply parity", () => {
  it("identifies the mover in a normal game", () => {
    const tree = GameTree.create()
    const e4 = tree.addMoveSan("e4")!
    const e5 = tree.addMoveSan("e5")!
    expect(moverIsWhite(tree.get(e4)!)).toBe(true)
    expect(moverIsWhite(tree.get(e5)!)).toBe(false)
    expect(moveSlot(tree.get(e4)!)).toEqual({ isWhite: true, moveNo: 1 })
    expect(moveSlot(tree.get(e5)!)).toEqual({ isWhite: false, moveNo: 1 })
  })

  it("does NOT call Black's move a White move when the game starts on Black's turn", () => {
    // The regression that matters: judgeMove and performance-elo take the
    // mover's colour as the SIGN of the eval swing, so getting this wrong
    // scores blunders as brilliancies.
    const tree = GameTree.create(
      "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 9",
    )
    const nc6 = tree.addMoveSan("Nc6")!
    expect(moverIsWhite(tree.get(nc6)!)).toBe(false)
    // ply === 1 here, which the old parity rule read as White.
    expect(tree.get(nc6)!.ply % 2 === 1).toBe(true)
  })

  it("keeps the real move numbers of a position set up mid-game", () => {
    const tree = GameTree.create(
      "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 9",
    )
    const nc6 = tree.addMoveSan("Nc6")!
    const nf3 = tree.addMoveSan("Nf3")!
    // Set up after 9 moves — numbering continues from 9, not restarted at 1.
    expect(moveSlot(tree.get(nc6)!)).toEqual({ isWhite: false, moveNo: 9 })
    expect(moveSlot(tree.get(nf3)!)).toEqual({ isWhite: true, moveNo: 10 })
  })
})

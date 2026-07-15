import { describe, it, expect } from "vitest"
import { walkPv } from "@/lib/pv-preview"

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

describe("walkPv (spec 011 PV preview)", () => {
  it("walks a legal PV and returns one step per ply", () => {
    const steps = walkPv(START, ["e2e4", "e7e5", "g1f3"])
    expect(steps).toHaveLength(3)
    expect(steps[0].san).toBe("e4")
    expect(steps[1].san).toBe("e5")
    expect(steps[2].san).toBe("Nf3")
    expect(steps[0].fen).toContain("4P3") // pawn on e4
    expect(steps[0].lastMove).toEqual(["e2", "e4"])
    // side to move alternates
    expect(steps[0].fen).toContain(" b ")
    expect(steps[1].fen).toContain(" w ")
  })

  it("stops at the first illegal move (stale PV from another position)", () => {
    const steps = walkPv(START, ["e2e4", "e2e4"])
    expect(steps).toHaveLength(1)
  })

  it("returns [] for a garbled FEN or empty PV", () => {
    expect(walkPv("not a fen", ["e2e4"])).toEqual([])
    expect(walkPv(START, [])).toEqual([])
  })

  it("highlights castling as the king's move (e1g1)", () => {
    // Position where white can castle kingside immediately.
    const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"
    const steps = walkPv(fen, ["e1g1"])
    expect(steps).toHaveLength(1)
    expect(steps[0].san).toBe("O-O")
    expect(steps[0].lastMove).toEqual(["e1", "g1"])
  })
})

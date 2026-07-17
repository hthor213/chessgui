// Player-card content mapping (spec 001) — the fix for the flip/Set-up desync
// where a card kept a fixed "Black on top" label after the board was flipped.
// Both cards must derive their entire content from the board color they are
// handed, so flipping orientation swaps them cleanly.

import { describe, it, expect } from "vitest"
import { playerCardModel, type PlayerCardInput } from "@/lib/player-card"

const base: Omit<PlayerCardInput, "color"> = {
  isPlayMode: false,
  playerColor: "white",
  headers: { White: "Alice", WhiteElo: "2100", Black: "Bob", BlackElo: "1950" },
  engineName: "Stockfish 17",
  humanClock: "5:00",
  engineClock: "4:30",
  performance: { white: null, black: null },
  showPerformance: false,
}

describe("playerCardModel — analyze mode follows the card's color", () => {
  it("shows the header name/Elo for the color it is given", () => {
    const white = playerCardModel({ ...base, color: "white" })
    const black = playerCardModel({ ...base, color: "black" })
    expect(white.name).toBe("Alice")
    expect(white.subtitle).toBe("2100")
    expect(white.avatar).toBe("A")
    expect(black.name).toBe("Bob")
    expect(black.subtitle).toBe("1950")
    expect(white.clock).toBe("--:--")
  })

  it("swaps cleanly when orientation flips (top/bottom get the opposite color)", () => {
    // White at bottom: topColor=black, bottomColor=white.
    const topWhiteBottom = playerCardModel({ ...base, color: "black" })
    const bottomWhiteBottom = playerCardModel({ ...base, color: "white" })
    expect(topWhiteBottom.name).toBe("Bob")
    expect(bottomWhiteBottom.name).toBe("Alice")

    // Flip — black at bottom: topColor=white, bottomColor=black. The names
    // follow the color, so the cards swap rather than desync.
    const topBlackBottom = playerCardModel({ ...base, color: "white" })
    const bottomBlackBottom = playerCardModel({ ...base, color: "black" })
    expect(topBlackBottom.name).toBe("Alice")
    expect(bottomBlackBottom.name).toBe("Bob")
  })

  it("falls back to the color label when a header name is missing", () => {
    const card = playerCardModel({ ...base, color: "white", headers: {} })
    expect(card.name).toBe("White")
    expect(card.subtitle).toBe("---")
    expect(card.avatar).toBe("W")
  })

  it("shows performance only when showPerformance is set", () => {
    const perf = { white: { band: 1600, label: "~1600 performance — single game, rough", acpl: 40, mistakes: 1, blunders: 0, scored: 20 }, black: null }
    expect(playerCardModel({ ...base, color: "white", performance: perf, showPerformance: false }).performance).toBeNull()
    expect(playerCardModel({ ...base, color: "white", performance: perf, showPerformance: true }).performance).toBe(perf.white)
  })
})

describe("playerCardModel — play mode splits by human vs engine", () => {
  it("labels the human's color 'You' with the human clock, the other as the engine", () => {
    const input = { ...base, isPlayMode: true, playerColor: "white" as const }
    const you = playerCardModel({ ...input, color: "white" })
    const eng = playerCardModel({ ...input, color: "black" })
    expect(you.avatar).toBe("You")
    expect(you.name).toBe("You (White)")
    expect(you.clock).toBe("5:00") // human clock
    expect(eng.avatar).toBe("SF")
    expect(eng.name).toBe("Stockfish 17")
    expect(eng.subtitle).toBe("Engine (Black)")
    expect(eng.clock).toBe("4:30") // engine clock
    expect(you.performance).toBeNull()
  })

  it("tracks a manual flip: if the human plays Black, the Black card is 'You'", () => {
    const input = { ...base, isPlayMode: true, playerColor: "black" as const }
    expect(playerCardModel({ ...input, color: "black" }).name).toBe("You (Black)")
    expect(playerCardModel({ ...input, color: "white" }).subtitle).toBe("Engine (White)")
  })
})

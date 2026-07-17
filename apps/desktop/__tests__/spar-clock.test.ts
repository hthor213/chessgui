import { describe, expect, it } from "vitest"
import {
  SPAR_TC_OFF,
  SPAR_TC_PRESETS,
  flagResultLabel,
  personaThinkTimeMs,
  sparTimeControlLabel,
} from "@/lib/spar-clock"
import { advanceClock, flaggedSide, remainingMs, startPlayClock } from "@/lib/play-clock"
import { buildSparResult, resultFromLabel } from "@/lib/spar-results"

// Spec 215 increment TCs in local spar: the spar-specific layer over the
// Play-mode Fischer clock model (exercised end-to-end in play-clock.test.ts) —
// preset list, recorded TC string, the persona's bounded think-time draw, and
// the flag label's round-trip through spar-results' label parser.

const T0 = 1_000_000 // arbitrary epoch base

describe("spar TC presets", () => {
  it("offers off + the three match TCs, off first", () => {
    expect(SPAR_TC_PRESETS.map((p) => p.id)).toEqual(["off", "5+3", "10+5", "15+10"])
    expect(SPAR_TC_OFF).toBe(SPAR_TC_PRESETS[0])
    expect(SPAR_TC_OFF.baseS).toBeNull()
    expect(SPAR_TC_PRESETS.map((p) => [p.baseS, p.incS])).toEqual([
      [null, 0],
      [300, 3],
      [600, 5],
      [900, 10],
    ])
  })

  it("labels read as chess-idiomatic TCs (and Off)", () => {
    expect(SPAR_TC_PRESETS.map((p) => p.label)).toEqual(["Off", "5+3", "10+5", "15+10"])
  })

  it("off produces no clock; timed presets produce a Fischer clock", () => {
    expect(startPlayClock(SPAR_TC_OFF, "white", T0)).toBeNull()
    const clock = startPlayClock(SPAR_TC_PRESETS[1], "white", T0)!
    expect(clock.whiteMs).toBe(300_000)
    expect(clock.blackMs).toBe(300_000)
    expect(clock.incMs).toBe(3_000)
  })

  it("increment is paid per completed move, flag falls at 0", () => {
    const clock = startPlayClock(SPAR_TC_PRESETS[1], "white", T0)!
    // White thinks 10s, moves: charged 10s, paid the 3s increment.
    const after = advanceClock(clock, "black", true, T0 + 10_000)
    expect(after.whiteMs).toBe(293_000)
    expect(after.running).toBe("black")
    // Black burns the whole base: their flag falls, White's doesn't.
    expect(flaggedSide(after, T0 + 10_000 + 299_999)).toBeNull()
    expect(flaggedSide(after, T0 + 10_000 + 300_000)).toBe("black")
    expect(remainingMs(after, "white", T0 + 10_000 + 300_000)).toBe(293_000)
  })
})

describe("sparTimeControlLabel (the recorded TC string)", () => {
  it("is null for off (nothing recorded on unclocked games)", () => {
    expect(sparTimeControlLabel(SPAR_TC_OFF)).toBeNull()
  })

  it("matches the chess-idiomatic label for timed presets", () => {
    expect(sparTimeControlLabel(SPAR_TC_PRESETS[1])).toBe("5+3")
    expect(sparTimeControlLabel(SPAR_TC_PRESETS[2])).toBe("10+5")
    expect(sparTimeControlLabel(SPAR_TC_PRESETS[3])).toBe("15+10")
  })
})

describe("personaThinkTimeMs (bounded draw — no persona time model exists)", () => {
  it("spans [1s, 5% of remaining] with plenty of time left", () => {
    expect(personaThinkTimeMs(600_000, () => 0)).toBe(1_000)
    expect(personaThinkTimeMs(600_000, () => 1)).toBe(30_000)
    expect(personaThinkTimeMs(600_000, () => 0.5)).toBe(15_500)
  })

  it("collapses to the 1s floor when 5% would be under it", () => {
    expect(personaThinkTimeMs(10_000, () => 0)).toBe(1_000)
    expect(personaThinkTimeMs(10_000, () => 1)).toBe(1_000)
  })

  it("never deliberately flags the persona: under 2s the draw is half the rest", () => {
    expect(personaThinkTimeMs(1_000, () => 0)).toBe(500)
    expect(personaThinkTimeMs(1_000, () => 1)).toBe(500)
    expect(personaThinkTimeMs(0, () => 1)).toBe(0)
    expect(personaThinkTimeMs(-5, () => 1)).toBe(0)
  })

  it("stays strictly below the remaining time for any remaining > 0", () => {
    for (const remaining of [1, 100, 1_999, 2_000, 10_000, 60_000, 900_000]) {
      const drawn = personaThinkTimeMs(remaining, () => 1)
      expect(drawn).toBeLessThan(remaining)
      expect(drawn).toBeGreaterThanOrEqual(0)
    }
  })
})

describe("flagResultLabel round-trips through spar-results' label parser", () => {
  it("maps the flagged side to the user's outcome by color", () => {
    expect(resultFromLabel(flagResultLabel("white"), "white")).toBe("loss")
    expect(resultFromLabel(flagResultLabel("white"), "black")).toBe("win")
    expect(resultFromLabel(flagResultLabel("black"), "white")).toBe("win")
    expect(resultFromLabel(flagResultLabel("black"), "black")).toBe("loss")
  })

  it("builds a full result entry carrying the TC", () => {
    const entry = buildSparResult({
      opponent: "maia-1700",
      level: 1700,
      mode: "serious",
      userColor: "white",
      resultLabel: flagResultLabel("white"),
      plies: 60,
      timeControl: "10+5",
    })!
    expect(entry.result).toBe("loss")
    expect(entry.timeControl).toBe("10+5")
  })

  it("omits timeControl entirely on unclocked games", () => {
    const entry = buildSparResult({
      opponent: "maia-1700",
      level: 1700,
      mode: "serious",
      userColor: "white",
      resultLabel: "Checkmate — White wins",
      plies: 60,
      timeControl: null,
    })!
    expect(entry.result).toBe("win")
    expect("timeControl" in entry).toBe(false)
  })
})

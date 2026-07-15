import { describe, it, expect } from "vitest"
import {
  appendSparResult,
  buildSparResult,
  detectAnomalies,
  removeSparResult,
  resultFromLabel,
  setCountsToward,
  sparScore,
  EARLY_RESIGN_PLIES,
  SHORT_GAME_PLIES,
  SPAR_SCORE_WINDOW_DAYS,
  type SparResultEntry,
} from "@/lib/spar-results"

const NOW = Date.parse("2026-07-15T12:00:00Z")

function entry(over: Partial<SparResultEntry>): SparResultEntry {
  return {
    id: Math.random().toString(36).slice(2),
    at: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
    opponent: "Rival",
    level: 1700,
    mode: "serious",
    userColor: "white",
    result: "win",
    resultLabel: "Checkmate — White wins",
    plies: 60,
    countsTowardTraining: true,
    anomalyFlags: [],
    ...over,
  }
}

describe("resultFromLabel", () => {
  it("maps every label the spar screen produces, from the user's POV", () => {
    expect(resultFromLabel("Checkmate — White wins", "white")).toBe("win")
    expect(resultFromLabel("Checkmate — White wins", "black")).toBe("loss")
    expect(resultFromLabel("Checkmate — Black wins", "black")).toBe("win")
    expect(resultFromLabel("Checkmate — Black wins", "white")).toBe("loss")
    expect(resultFromLabel("You resigned — 0-1", "white")).toBe("loss")
    expect(resultFromLabel("You resigned — 1-0", "black")).toBe("loss")
    expect(resultFromLabel("Draw agreed — ½–½", "white")).toBe("draw")
    expect(resultFromLabel("Draw — stalemate", "white")).toBe("draw")
    expect(resultFromLabel("Draw — insufficient material", "black")).toBe("draw")
    expect(resultFromLabel("Draw", "white")).toBe("draw")
  })

  it("returns null on unknown labels (record nothing rather than guess)", () => {
    expect(resultFromLabel("Something new", "white")).toBeNull()
  })
})

describe("detectAnomalies (flag, never drop)", () => {
  it("flags decisive games shorter than the threshold", () => {
    expect(
      detectAnomalies({ result: "loss", resultLabel: "Checkmate — Black wins", plies: SHORT_GAME_PLIES - 1 }),
    ).toContain("short_game")
    expect(
      detectAnomalies({ result: "win", resultLabel: "Checkmate — White wins", plies: SHORT_GAME_PLIES }),
    ).toEqual([])
  })

  it("does not flag short draws (a quick agreed draw is not probe-shaped)", () => {
    expect(detectAnomalies({ result: "draw", resultLabel: "Draw — stalemate", plies: 8 })).toEqual([])
  })

  it("flags early resignations", () => {
    const flags = detectAnomalies({
      result: "loss",
      resultLabel: "You resigned — 0-1",
      plies: EARLY_RESIGN_PLIES - 1,
    })
    expect(flags).toContain("early_resign")
    expect(
      detectAnomalies({ result: "loss", resultLabel: "You resigned — 0-1", plies: EARLY_RESIGN_PLIES }),
    ).toEqual([])
  })
})

describe("buildSparResult", () => {
  it("serious games count toward training by default", () => {
    const e = buildSparResult({
      opponent: "Rival",
      level: 1700,
      mode: "serious",
      userColor: "white",
      resultLabel: "Checkmate — White wins",
      plies: 50,
    })
    expect(e).not.toBeNull()
    expect(e!.result).toBe("win")
    expect(e!.countsTowardTraining).toBe(true)
    expect(e!.anomalyFlags).toEqual([])
  })

  it("probe games never count", () => {
    const e = buildSparResult({
      opponent: "Rival",
      level: 1700,
      mode: "probe",
      userColor: "black",
      resultLabel: "Checkmate — White wins",
      plies: 50,
    })
    expect(e!.countsTowardTraining).toBe(false)
  })

  it("honors an explicit countsTowardTraining override on a serious game (the SparConfig toggle)", () => {
    const off = buildSparResult({
      opponent: "Rival",
      level: 1700,
      mode: "serious",
      userColor: "white",
      resultLabel: "Checkmate — White wins",
      plies: 50,
      countsTowardTraining: false,
    })
    expect(off!.countsTowardTraining).toBe(false)

    const on = buildSparResult({
      opponent: "Rival",
      level: 1700,
      mode: "serious",
      userColor: "white",
      resultLabel: "Checkmate — White wins",
      plies: 50,
      countsTowardTraining: true,
    })
    expect(on!.countsTowardTraining).toBe(true)
  })

  it("forces a probe game's countsTowardTraining false even if the override says true (probe never counts)", () => {
    const e = buildSparResult({
      opponent: "Rival",
      level: 1700,
      mode: "probe",
      userColor: "white",
      resultLabel: "Checkmate — White wins",
      plies: 50,
      countsTowardTraining: true,
    })
    expect(e!.countsTowardTraining).toBe(false)
  })

  it("returns null on an unparseable label", () => {
    expect(
      buildSparResult({
        opponent: "Rival",
        level: 1700,
        mode: "serious",
        userColor: "white",
        resultLabel: "???",
        plies: 10,
      }),
    ).toBeNull()
  })
})

describe("setCountsToward", () => {
  it("reclassifies a serious game and stamps reclassifiedAt", () => {
    const e = entry({ id: "a" })
    const next = setCountsToward([e], "a", false, "2026-07-15T00:00:00Z")
    expect(next[0].countsTowardTraining).toBe(false)
    expect(next[0].reclassifiedAt).toBe("2026-07-15T00:00:00Z")
  })

  it("refuses to flip a probe game to counting (probe never counts)", () => {
    const e = entry({ id: "p", mode: "probe", countsTowardTraining: false })
    const next = setCountsToward([e], "p", true)
    expect(next[0].countsTowardTraining).toBe(false)
    expect(next[0].reclassifiedAt).toBeUndefined()
  })

  it("no-ops when the value is unchanged", () => {
    const e = entry({ id: "a" })
    const next = setCountsToward([e], "a", true)
    expect(next[0]).toBe(e)
  })
})

describe("append/remove", () => {
  it("appends without mutating and removes by id", () => {
    const a = entry({ id: "a" })
    const b = entry({ id: "b" })
    const both = appendSparResult([a], b)
    expect(both).toHaveLength(2)
    expect(removeSparResult(both, "a").map((e) => e.id)).toEqual(["b"])
  })
})

describe("sparScore", () => {
  it("scores wins + half draws over counting games only", () => {
    const entries = [
      entry({ result: "win" }),
      entry({ result: "loss" }),
      entry({ result: "draw" }),
      entry({ result: "win", mode: "probe", countsTowardTraining: false }), // never counts
      entry({ result: "win", countsTowardTraining: false }), // reclassified out
    ]
    const s = sparScore(entries, NOW)
    expect(s.games).toBe(3)
    expect(s.score).toBeCloseTo((1 + 0.5) / 3)
  })

  it("INCLUDES flagged games in the score and reports the flag count", () => {
    const entries = [
      entry({ result: "win" }),
      entry({ result: "loss", anomalyFlags: ["short_game"] }),
    ]
    const s = sparScore(entries, NOW)
    expect(s.games).toBe(2)
    expect(s.flagged).toBe(1)
    expect(s.score).toBeCloseTo(0.5)
  })

  it("ignores games outside the window and returns null with no games", () => {
    const old = entry({
      at: new Date(NOW - (SPAR_SCORE_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString(),
    })
    const s = sparScore([old], NOW)
    expect(s.games).toBe(0)
    expect(s.score).toBeNull()
  })
})

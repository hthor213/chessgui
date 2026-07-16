import { describe, it, expect } from "vitest"
import {
  aggregateHits,
  eloDifferenceForScore,
  moverFromFen,
  sortGroups,
} from "@/lib/explorer-stats"
import type { PositionHit } from "@/lib/database"

function hit(over: Partial<PositionHit>): PositionHit {
  return {
    game_id: 1,
    white: "W",
    black: "B",
    white_elo: null,
    black_elo: null,
    result: "*",
    date: "",
    ply: 0,
    next_uci: "e2e4",
    next_san: "e4",
    ...over,
  }
}

describe("explorer aggregation (spec 200)", () => {
  it("groups by next move with W/D/L", () => {
    const groups = aggregateHits(
      [
        hit({ result: "1-0" }),
        hit({ result: "0-1" }),
        hit({ result: "1/2-1/2" }),
        hit({ next_uci: "d2d4", next_san: "d4", result: "1-0" }),
      ],
      "white",
    )
    const e4 = groups.find((g) => g.san === "e4")!
    expect(e4.total).toBe(3)
    expect(e4.whiteWins).toBe(1)
    expect(e4.draws).toBe(1)
    expect(e4.blackWins).toBe(1)
    expect(groups.find((g) => g.san === "d4")!.total).toBe(1)
  })

  it("computes performance from opponent ratings and achieved score", () => {
    // White to move, scores 100% against 2000-rated opponents → 2000 + 800 cap.
    const groups = aggregateHits(
      [
        hit({ result: "1-0", black_elo: 2000 }),
        hit({ result: "1-0", black_elo: 2000 }),
      ],
      "white",
    )
    expect(groups[0].performance).toBe(2800)
    // 50% score → performance == average opponent rating.
    const even = aggregateHits(
      [
        hit({ result: "1-0", black_elo: 2000 }),
        hit({ result: "0-1", black_elo: 2200 }),
      ],
      "white",
    )
    expect(even[0].performance).toBe(2100)
  })

  it("uses the mover's opponents: black to move reads white_elo", () => {
    const groups = aggregateHits(
      [hit({ result: "0-1", white_elo: 2400, black_elo: 1000 })],
      "black",
    )
    // Black scored 100% vs a 2400 → 2400 + 800.
    expect(groups[0].performance).toBe(3200)
  })

  it("returns null performance when no opponent ratings are known", () => {
    const groups = aggregateHits([hit({ result: "1-0" })], "white")
    expect(groups[0].performance).toBeNull()
    expect(groups[0].avgElo).toBeNull()
  })

  it("averages Elo across both colours", () => {
    const groups = aggregateHits(
      [hit({ white_elo: 2000, black_elo: 2200 })],
      "white",
    )
    expect(groups[0].avgElo).toBe(2100)
  })
})

describe("eloDifferenceForScore", () => {
  it("is 0 at 50% and symmetric", () => {
    expect(eloDifferenceForScore(0.5)).toBeCloseTo(0)
    expect(eloDifferenceForScore(0.75)).toBeCloseTo(-eloDifferenceForScore(0.25))
  })
  it("clamps perfect scores to ±800", () => {
    expect(eloDifferenceForScore(1)).toBe(800)
    expect(eloDifferenceForScore(0)).toBe(-800)
  })
})

describe("sortGroups", () => {
  const groups = aggregateHits(
    [
      hit({ result: "1/2-1/2", black_elo: 2000 }), // e4: perf 2000, count 2
      hit({ result: "1/2-1/2", black_elo: 2000 }),
      hit({ next_uci: "d2d4", next_san: "d4", result: "1-0", black_elo: 2000 }), // d4: perf 2800, count 1
      hit({ next_uci: "c2c4", next_san: "c4" }), // c4: perf null
    ],
    "white",
  )
  it("by count: most games first", () => {
    expect(sortGroups(groups, "count").map((g) => g.san)).toEqual(["e4", "d4", "c4"])
  })
  it("by performance: highest first, unknown last", () => {
    expect(sortGroups(groups, "performance").map((g) => g.san)).toEqual(["d4", "e4", "c4"])
  })
})

describe("moverFromFen", () => {
  it("reads the side to move", () => {
    expect(moverFromFen("8/8/8/8/8/8/8/8 w - - 0 1")).toBe("white")
    expect(moverFromFen("8/8/8/8/8/8/8/8 b - - 0 1")).toBe("black")
  })
})

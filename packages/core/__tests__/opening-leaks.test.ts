// Opening-leak aggregation (spec 211): the GUI port of leak_report.py's
// (ECO × colour) grouping, ranked by results because the database stores no
// per-move evals (the CLI report ranks by eval bled — see opening-leaks.ts).

import { describe, it, expect } from "vitest"
import { aggregateOpeningLeaks } from "../src/opening-leaks"
import type { PlayerGameRow } from "../src/database-types"

let nextId = 1
function row(
  color: "white" | "black",
  eco: string,
  result: string,
  overrides: Partial<PlayerGameRow> = {},
): PlayerGameRow {
  return {
    game_id: nextId++,
    color,
    eco,
    result,
    date: "2026.01.01",
    opponent: "Opp",
    opponent_elo: null,
    ...overrides,
  }
}

describe("aggregateOpeningLeaks", () => {
  it("groups by ECO x colour and scores from the player's perspective", () => {
    const rows = [
      // B90 as white: win, loss, draw -> 50%
      row("white", "B90", "1-0"),
      row("white", "B90", "0-1"),
      row("white", "B90", "1/2-1/2"),
      // B90 as black is a SEPARATE group: three losses -> 0%
      row("black", "B90", "1-0"),
      row("black", "B90", "1-0"),
      row("black", "B90", "1-0"),
    ]
    const out = aggregateOpeningLeaks(rows)
    expect(out).toHaveLength(2)
    // Worst score first: the black group leads.
    expect(out[0]).toMatchObject({
      eco: "B90",
      color: "black",
      games: 3,
      wins: 0,
      draws: 0,
      losses: 3,
      scorePct: 0,
    })
    expect(out[1]).toMatchObject({
      eco: "B90",
      color: "white",
      games: 3,
      wins: 1,
      draws: 1,
      losses: 1,
      scorePct: 50,
    })
  })

  it("drops groups under the min-games threshold (CLI --min-games)", () => {
    const rows = [
      row("white", "C50", "0-1"), // one-off loss: not ranked
      row("black", "D35", "0-1"),
      row("black", "D35", "0-1"),
      row("black", "D35", "1/2-1/2"),
    ]
    const out = aggregateOpeningLeaks(rows)
    expect(out).toHaveLength(1)
    expect(out[0].eco).toBe("D35")
    // As black, "0-1" is the player's win.
    expect(out[0]).toMatchObject({ wins: 2, draws: 1, losses: 0 })
  })

  it("scores results by the held colour, not the result string", () => {
    const rows = [
      row("black", "E60", "0-1"),
      row("black", "E60", "0-1"),
      row("black", "E60", "1-0"),
    ]
    const [g] = aggregateOpeningLeaks(rows)
    expect(g).toMatchObject({ wins: 2, losses: 1, draws: 0 })
    expect(g.scorePct).toBeCloseTo(66.7)
  })

  it("skips unfinished/unknown results and blanks the missing ECO honestly", () => {
    const rows = [
      row("white", "", "1-0"),
      row("white", "", "1-0"),
      row("white", "", "0-1"),
      row("white", "", "*"), // live game: never counted (spec 219 discipline)
      row("white", "", "abandoned"),
    ]
    const out = aggregateOpeningLeaks(rows)
    expect(out).toHaveLength(1)
    expect(out[0].eco).toBe("?")
    expect(out[0].games).toBe(3)
  })

  it("ranks worst score first, repetition breaking ties", () => {
    const mk = (eco: string, results: string[]) => results.map((r) => row("white", eco, r))
    const rows = [
      ...mk("A00", ["1-0", "1-0", "1-0"]), // 100%
      ...mk("B20", ["0-1", "0-1", "0-1"]), // 0%, 3 games
      ...mk("C60", ["0-1", "0-1", "0-1", "0-1"]), // 0%, 4 games — most repeated
      ...mk("D10", ["1/2-1/2", "0-1", "0-1"]), // ~16.7%
    ]
    const out = aggregateOpeningLeaks(rows)
    expect(out.map((g) => g.eco)).toEqual(["C60", "B20", "D10", "A00"])
  })

  it("returns nothing for no input", () => {
    expect(aggregateOpeningLeaks([])).toEqual([])
  })
})

// Tournament pairing/seeding logic — especially "Current position" mode
// (play the analyze-board position through, engine A on a chosen side).

import { describe, it, expect } from "vitest"
import {
  buildSeeds,
  buildSpecs,
  seedsForGames,
  TIME_CONTROLS,
  type Seed,
} from "@/lib/tournament"

const FEN_AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1"
const SF = "/opt/stockfish"
const RK = "/opt/reckless"

describe("buildSeeds — current position mode", () => {
  it("repeats the given FEN for every seed with eval 0", () => {
    const seeds = buildSeeds("current", 3, [], -2, 2, FEN_AFTER_E4)
    expect(seeds).toHaveLength(3)
    for (const s of seeds) {
      expect(s.fen).toBe(FEN_AFTER_E4)
      expect(s.eval).toBe(0)
    }
  })

  it("falls back to null FEN (standard start) when no FEN is supplied", () => {
    const seeds = buildSeeds("current", 2, [])
    expect(seeds.every((s) => s.fen === null)).toBe(true)
  })
})

describe("buildSpecs — color-flipped pairing", () => {
  const seeds: Seed[] = [{ fen: FEN_AFTER_E4, eval: 0 }]

  it("default order: engine A is White in the first game of each pair", () => {
    const { specs, evalById } = buildSpecs(seeds, SF, RK, 600_000, 5_000, 400, true)
    expect(specs).toHaveLength(2)
    expect(specs[0]).toMatchObject({
      id: 0,
      white_path: SF,
      black_path: RK,
      flipped: false,
      start_fen: FEN_AFTER_E4,
      base_ms: 600_000,
      inc_ms: 5_000,
    })
    expect(specs[1]).toMatchObject({
      id: 1,
      white_path: RK,
      black_path: SF,
      flipped: true,
      start_fen: FEN_AFTER_E4,
    })
    expect(evalById.get(0)?.eval).toBe(0)
    expect(evalById.get(1)?.eval).toBe(0)
  })

  it("flipFirst: engine A is Black in the first game, White in the second", () => {
    const { specs } = buildSpecs(seeds, SF, RK, 600_000, 5_000, 400, true, true)
    expect(specs).toHaveLength(2)
    // flipped always means "engine A is Black", regardless of pair order.
    expect(specs[0]).toMatchObject({ white_path: RK, black_path: SF, flipped: true })
    expect(specs[1]).toMatchObject({ white_path: SF, black_path: RK, flipped: false })
  })

  it("every pair keeps flipping across multiple seeds (odd/even game index)", () => {
    const many: Seed[] = Array.from({ length: 3 }, () => ({ fen: FEN_AFTER_E4, eval: 0 }))
    const { specs } = buildSpecs(many, SF, RK, 1000, 0, 400, false, true)
    expect(specs).toHaveLength(6)
    for (let i = 0; i < specs.length; i++) {
      const flipped = i % 2 === 0 // flipFirst=true: odd games (index 0,2,4) flipped
      expect(specs[i].flipped).toBe(flipped)
      expect(specs[i].white_path).toBe(flipped ? RK : SF)
      expect(specs[i].black_path).toBe(flipped ? SF : RK)
    }
  })
})

describe("current-position mode defaults", () => {
  it("2 games need exactly 1 seed (one flipped pair)", () => {
    expect(seedsForGames(2)).toBe(1)
  })

  it("has a 10m+5s rapid preset for the default time control", () => {
    const rapid = TIME_CONTROLS.find((t) => t.id === "rapid")
    expect(rapid).toMatchObject({ baseMs: 600_000, incMs: 5_000 })
  })
})

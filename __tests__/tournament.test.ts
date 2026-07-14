// Tournament pairing/seeding logic — especially "Current position" mode
// (play the analyze-board position through, engine A on a chosen side).

import { describe, it, expect } from "vitest"
import {
  buildSeeds,
  buildSpecs,
  seedsForGames,
  summarizeErrors,
  plyEvalPawns,
  gameEvalSeries,
  averageEvalByPly,
  evalBarDefaultForBaseMs,
  MATE_EVAL_PAWNS,
  TIME_CONTROLS,
  type GameOutcome,
  type PlyEval,
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

describe("summarizeErrors — surfacing per-game failure reasons", () => {
  const ok = (id: number): GameOutcome => ({
    id,
    flipped: false,
    result: { Ok: { result: "1-0", termination: "checkmate", plies: 30, start_fen: "", moves: [] } },
  })
  const err = (id: number, message: string): GameOutcome => ({
    id,
    flipped: false,
    result: { Err: message },
  })

  it("dedups identical error strings and counts them, most frequent first", () => {
    const spawn = "Failed to start engine '/opt/reckless': No such file or directory (os error 2)"
    const fen = "Illegal start position: invalid castling rights"
    const groups = summarizeErrors([
      err(0, spawn),
      err(1, spawn),
      err(2, fen),
      ok(3),
    ])
    expect(groups).toEqual([
      { message: spawn, count: 2 },
      { message: fen, count: 1 },
    ])
  })

  it("returns an empty list when no games errored", () => {
    expect(summarizeErrors([ok(0), ok(1)])).toEqual([])
  })
})

describe("plyEvalPawns — White-POV pawn value", () => {
  it("scales centipawns by 1/100", () => {
    expect(plyEvalPawns({ ply: 1, cp: 34, mate: null })).toBeCloseTo(0.34)
    expect(plyEvalPawns({ ply: 2, cp: -150, mate: null })).toBeCloseTo(-1.5)
  })

  it("maps a mate to +/-MATE_EVAL_PAWNS by sign", () => {
    expect(plyEvalPawns({ ply: 5, cp: null, mate: 3 })).toBe(MATE_EVAL_PAWNS)
    expect(plyEvalPawns({ ply: 6, cp: null, mate: -2 })).toBe(-MATE_EVAL_PAWNS)
  })

  it("is null when the ply has no score", () => {
    expect(plyEvalPawns({ ply: 0, cp: null, mate: null })).toBeNull()
  })
})

describe("averageEvalByPly — engine-A-POV normalization", () => {
  // Helper: a completed game carrying only per-ply evals (the rest is unused here).
  const gameWithEvals = (flipped: boolean, evals: PlyEval[]): GameOutcome => ({
    id: 0,
    flipped,
    result: { Ok: { result: "1/2-1/2", termination: "draw", plies: evals.length, start_fen: "", moves: [] } },
    evals,
  })

  it("folds color-flipped pairs onto A's perspective instead of cancelling", () => {
    // Same ply, mirror-image White-POV evals: A as White is +2, A as Black
    // faces a White eval of -2 (i.e. A is +2 from its own side). The raw
    // White-POV mean would be 0; the A-POV mean must be +2.
    const a = gameWithEvals(false, [{ ply: 1, cp: 200, mate: null }])
    const b = gameWithEvals(true, [{ ply: 1, cp: -200, mate: null }])
    const avg = averageEvalByPly([a, b])
    expect(avg).toHaveLength(1)
    expect(avg[0]).toMatchObject({ ply: 1, n: 2 })
    expect(avg[0].mean).toBeCloseTo(2.0)
  })

  it("clamps each contribution so one blowout can't dominate the mean", () => {
    const a = gameWithEvals(false, [{ ply: 1, cp: 5000, mate: null }]) // +50 pawns
    const b = gameWithEvals(false, [{ ply: 1, cp: 0, mate: null }])
    const avg = averageEvalByPly([a, b])
    // +50 clamps to +MATE_EVAL_PAWNS, so the mean is (10 + 0) / 2 = 5, not 25.
    expect(avg[0].mean).toBeCloseTo(MATE_EVAL_PAWNS / 2)
  })

  it("skips unscored plies and omits plies with no games", () => {
    const a = gameWithEvals(false, [
      { ply: 0, cp: 0, mate: null },
      { ply: 1, cp: null, mate: null }, // no score → skipped
    ])
    const avg = averageEvalByPly([a])
    expect(avg.map((p) => p.ply)).toEqual([0])
  })
})

describe("gameEvalSeries — per-game White-POV curve", () => {
  it("maps every recorded ply, preserving null gaps", () => {
    const o: GameOutcome = {
      id: 3,
      flipped: true, // per-game graph is White-POV: flipped must NOT affect it
      result: { Ok: { result: "0-1", termination: "checkmate", plies: 2, start_fen: "", moves: [] } },
      evals: [
        { ply: 0, cp: 0, mate: null },
        { ply: 1, cp: null, mate: null },
        { ply: 2, cp: -80, mate: null },
      ],
    }
    expect(gameEvalSeries(o)).toEqual([
      { ply: 0, pawns: 0 },
      { ply: 1, pawns: null },
      { ply: 2, pawns: -0.8 },
    ])
  })

  it("is empty for an outcome with no evals", () => {
    const o: GameOutcome = { id: 1, flipped: false, result: { Err: "boom" } }
    expect(gameEvalSeries(o)).toEqual([])
  })
})

describe("evalBarDefaultForBaseMs — auto-check the eval bar for slow TCs", () => {
  it("is on at exactly 60s and above, off below", () => {
    expect(evalBarDefaultForBaseMs(59_999)).toBe(false)
    expect(evalBarDefaultForBaseMs(60_000)).toBe(true)
    expect(evalBarDefaultForBaseMs(300_000)).toBe(true)
  })

  it("matches the intent across the built-in TC presets", () => {
    const byId = Object.fromEntries(TIME_CONTROLS.map((t) => [t.id, t.baseMs]))
    expect(evalBarDefaultForBaseMs(byId.fast)).toBe(false) // 10s
    expect(evalBarDefaultForBaseMs(byId.standard)).toBe(true) // 60s
    expect(evalBarDefaultForBaseMs(byId.long)).toBe(true) // 300s
    expect(evalBarDefaultForBaseMs(byId.rapid)).toBe(true) // 600s
  })
})

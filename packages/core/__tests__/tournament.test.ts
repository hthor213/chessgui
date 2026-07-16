// Tournament pairing/seeding logic — especially "Current position" mode
// (play the analyze-board position through, engine A on a chosen side).

import { describe, it, expect } from "vitest"
import {
  buildSeeds,
  parseOpeningPositions,
  buildSpecs,
  buildParticipantSpecs,
  buildExhibitionSpec,
  newPersonaSeed,
  seedsForGames,
  summarizeErrors,
  plyEvalPawns,
  gameEvalSeries,
  averageEvalByPly,
  evalBarDefaultForBaseMs,
  buildProbabilityMap,
  buildEngineWDL,
  buildEngineCurves,
  expectedWinPct,
  buildTournamentResultExport,
  MATE_EVAL_PAWNS,
  TIME_CONTROLS,
  type GameOutcome,
  type Participant,
  type PlyEval,
  type Seed,
  type EvalMap,
} from "@chessgui/core/tournament"

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

// spec 218 "Exhibition & tournament" checklist item 1: the Participant-aware
// spec builders (the wire shape the tournament/exhibition dropdown sends).
describe("buildParticipantSpecs — Participant-aware color-flipped pairing", () => {
  const seeds: Seed[] = [{ fen: FEN_AFTER_E4, eval: 0 }]
  const uciA: Participant = { id: "engine-stockfish", displayName: "Stockfish 18", kind: "uci", enginePath: SF }
  const uciB: Participant = { id: "engine-reckless", displayName: "Reckless", kind: "uci", enginePath: RK }
  const persona: Participant = {
    id: "kasparov",
    displayName: "Garry Kasparov",
    kind: "persona",
    personaConfig: { level: 1900, temperature: 0.5, alpha: 1.0, lambda: 0.75, topK: 4, verifyDepth: 12, weights: "bt3" },
  }

  it("mirrors buildSpecs' pairing: A white in game 1, B white in game 2", () => {
    const { specs, evalById } = buildParticipantSpecs(seeds, uciA, uciB, 600_000, 5_000, 400, true)
    expect(specs).toHaveLength(2)
    expect(specs[0]).toMatchObject({ id: 0, flipped: false, white: uciA, black: uciB })
    expect(specs[1]).toMatchObject({ id: 1, flipped: true, white: uciB, black: uciA })
    expect(evalById.get(0)?.eval).toBe(0)
  })

  it("fills legacy white_path/black_path from a UCI participant's enginePath", () => {
    const { specs } = buildParticipantSpecs(seeds, uciA, uciB, 600_000, 5_000, 400, true)
    expect(specs[0].white_path).toBe(SF)
    expect(specs[0].black_path).toBe(RK)
  })

  it("leaves the legacy path empty for a persona side (the runner resolves it server-side)", () => {
    const { specs } = buildParticipantSpecs(seeds, persona, uciA, 600_000, 5_000, 400, true)
    expect(specs[0].white_path).toBe("")
    expect(specs[0].white).toEqual(persona)
  })

  it("flipFirst reverses each pair's order, same semantics as buildSpecs", () => {
    const { specs } = buildParticipantSpecs(seeds, uciA, uciB, 600_000, 5_000, 400, true, true)
    expect(specs[0]).toMatchObject({ flipped: true, white: uciB, black: uciA })
    expect(specs[1]).toMatchObject({ flipped: false, white: uciA, black: uciB })
  })

  // HONESTY GATE (spec 218 item 1): a GM persona's wire config must carry
  // `weights` — this locks that the builder never strips it in transit.
  it("passes a GM persona's weights:'bt3' through untouched", () => {
    const { specs } = buildParticipantSpecs(seeds, persona, uciA, 600_000, 5_000, 400, true)
    expect(specs[0].white?.personaConfig?.weights).toBe("bt3")
    expect(specs[0].white?.personaConfig?.level).toBe(1900)
  })
})

describe("buildExhibitionSpec — the exhibition's batch-of-1 (spec 218 item 3)", () => {
  const uciA: Participant = { id: "engine-stockfish", displayName: "Stockfish", kind: "uci", enginePath: SF }
  const uciB: Participant = { id: "engine-reckless", displayName: "Reckless", kind: "uci", enginePath: RK }

  it("builds exactly one unflipped GameSpec, id 0", () => {
    const { spec, evalById } = buildExhibitionSpec(
      { fen: FEN_AFTER_E4, eval: 0.3 },
      uciA,
      uciB,
      600_000,
      5_000,
      400,
      true,
    )
    expect(spec).toMatchObject({ id: 0, flipped: false, white: uciA, black: uciB, start_fen: FEN_AFTER_E4 })
    expect(evalById.get(0)?.eval).toBe(0.3)
  })
})

describe("newPersonaSeed — per-run persona base seed", () => {
  it("stays below 2^53 so it survives the JSON round-trip to Rust", () => {
    for (let i = 0; i < 20; i++) {
      expect(newPersonaSeed()).toBeLessThan(2 ** 53)
      expect(Number.isInteger(newPersonaSeed())).toBe(true)
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

  it("excludes aborted (stopped) games from the failure list", () => {
    const aborted: GameOutcome = {
      id: 5,
      flipped: false,
      result: { Err: "cancelled" },
      aborted: true,
    }
    expect(summarizeErrors([ok(0), aborted])).toEqual([])
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

  it("excludes aborted games (their evals are partial)", () => {
    const live = gameWithEvals(false, [{ ply: 1, cp: 300, mate: null }])
    const aborted: GameOutcome = {
      ...gameWithEvals(false, [{ ply: 1, cp: -900, mate: null }]),
      aborted: true,
    }
    const avg = averageEvalByPly([live, aborted])
    // Only the live game contributes: mean = +3.0, n = 1.
    expect(avg).toEqual([{ ply: 1, mean: 3.0, n: 1 }])
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

// spec 210 Phase 5 tick-pass caveat (2026-07-15): "zero coverage today" for
// buildProbabilityMap/buildEngineWDL/buildEngineCurves. Closed here.
describe("expectedWinPct — classical Elo-naive pawns->win% (conversion_delta baseline)", () => {
  it("is 0.5 at eval 0 regardless of slope", () => {
    expect(expectedWinPct(0)).toBeCloseTo(0.5)
  })

  it("increases monotonically with a positive White-POV eval", () => {
    expect(expectedWinPct(1)).toBeGreaterThan(expectedWinPct(0.5))
    expect(expectedWinPct(0.5)).toBeGreaterThan(expectedWinPct(0))
  })

  it("is symmetric: expected(-e) = 1 - expected(e)", () => {
    expect(expectedWinPct(1.3) + expectedWinPct(-1.3)).toBeCloseTo(1)
  })
})

describe("buildProbabilityMap — eval-bucket W/D/L + conversion_delta", () => {
  const gameFor = (id: number, result: "1-0" | "0-1" | "1/2-1/2"): GameOutcome => ({
    id,
    flipped: false,
    result: { Ok: { result, termination: "checkmate", plies: 10, start_fen: "", moves: [] } },
  })

  it("buckets by starting eval and computes avg White score + conversionDelta", () => {
    // All three qualifying games share one bin: [0, 0.25), center 0.125.
    const evalById: EvalMap = new Map([
      [0, { eval: 0.1 }],
      [1, { eval: 0.1 }],
      [2, { eval: 0.1 }],
    ])
    const outcomes: GameOutcome[] = [
      gameFor(0, "1-0"), // White (advantaged side) wins
      gameFor(1, "1/2-1/2"),
      gameFor(2, "0-1"), // White loses
    ]
    const bins = buildProbabilityMap(outcomes, evalById, 0, 0.25)
    expect(bins).toHaveLength(1)
    const b = bins[0]
    expect(b).toMatchObject({ count: 3, whiteWins: 1, draws: 1, blackWins: 1 })
    expect(b.center).toBeCloseTo(0.125)
    expect(b.avgWhiteScore).toBeCloseTo(0.5) // (1 + 0.5 + 0) / 3
    expect(b.expectedWhiteScore).toBeCloseTo(expectedWinPct(0.125))
    expect(b.conversionDelta).toBeCloseTo(b.avgWhiteScore - b.expectedWhiteScore)
  })

  it("skips Err games and games with no evalById entry", () => {
    const evalById: EvalMap = new Map([[0, { eval: 0.1 }]]) // id 1 and 2 unmapped
    const outcomes: GameOutcome[] = [
      gameFor(0, "1-0"),
      { id: 1, flipped: false, result: { Err: "boom" } }, // errored
      gameFor(2, "1-0"), // no eval entry
    ]
    const bins = buildProbabilityMap(outcomes, evalById, 0, 0.25)
    expect(bins).toHaveLength(1)
    expect(bins[0].count).toBe(1)
  })

  it("omits empty bins and sorts ascending by eval", () => {
    const evalById: EvalMap = new Map([
      [0, { eval: 1.1 }],
      [1, { eval: -1.1 }],
    ])
    const outcomes: GameOutcome[] = [gameFor(0, "1-0"), gameFor(1, "0-1")]
    const bins = buildProbabilityMap(outcomes, evalById, -1.25, 1.25)
    // Only the two occupied bins, nothing in between.
    expect(bins.map((b) => b.count)).toEqual([1, 1])
    expect(bins[0].lo).toBeLessThan(bins[1].lo)
  })
})

describe("buildEngineWDL — per-engine W/D/L from ITS OWN perspective eval", () => {
  // Engine A is White (unflipped), White wins: A's perspective eval is the
  // raw eval (+1.0), a win; B's perspective eval is mirrored (-1.0), a loss.
  const evalById: EvalMap = new Map([[0, { eval: 1.0 }]])
  const outcomes: GameOutcome[] = [
    {
      id: 0,
      flipped: false,
      result: { Ok: { result: "1-0", termination: "checkmate", plies: 10, start_fen: "", moves: [] } },
    },
  ]

  it("engine A: win recorded at its own +1.0 perspective bin", () => {
    const bins = buildEngineWDL(outcomes, evalById, "a", -1.25, 1.25)
    const bin = bins.find((b) => b.lo <= 1.0 && 1.0 < b.hi)
    expect(bin).toBeDefined()
    expect(bin).toMatchObject({ count: 1, whiteWins: 1, draws: 0, blackWins: 0 })
    expect(bin!.avgWhiteScore).toBeCloseTo(1)
  })

  it("engine B: loss recorded at its own -1.0 perspective bin (mirrored)", () => {
    const bins = buildEngineWDL(outcomes, evalById, "b", -1.25, 1.25)
    const bin = bins.find((b) => b.lo <= -1.0 && -1.0 < b.hi)
    expect(bin).toBeDefined()
    expect(bin).toMatchObject({ count: 1, whiteWins: 0, draws: 0, blackWins: 1 })
    expect(bin!.avgWhiteScore).toBeCloseTo(0)
  })

  it("a draw counts as a draw for BOTH engines regardless of perspective", () => {
    const drawOutcome: GameOutcome[] = [
      {
        id: 0,
        flipped: false,
        result: { Ok: { result: "1/2-1/2", termination: "draw", plies: 10, start_fen: "", moves: [] } },
      },
    ]
    const aBins = buildEngineWDL(drawOutcome, evalById, "a", -1.25, 1.25)
    const bBins = buildEngineWDL(drawOutcome, evalById, "b", -1.25, 1.25)
    expect(aBins.find((b) => b.lo <= 1.0 && 1.0 < b.hi)).toMatchObject({ draws: 1 })
    expect(bBins.find((b) => b.lo <= -1.0 && -1.0 < b.hi)).toMatchObject({ draws: 1 })
  })
})

describe("buildEngineCurves — per-engine score curve over starting eval", () => {
  it("mirrors A's and B's perspective eval + score for a single unflipped win", () => {
    const evalById: EvalMap = new Map([[0, { eval: 1.0 }]])
    const outcomes: GameOutcome[] = [
      {
        id: 0,
        flipped: false, // A is White
        result: { Ok: { result: "1-0", termination: "checkmate", plies: 10, start_fen: "", moves: [] } },
      },
    ]
    const bins = buildEngineCurves(outcomes, evalById, -1.25, 1.25)
    const aBin = bins.find((b) => b.lo <= 1.0 && 1.0 < b.hi)
    const bBin = bins.find((b) => b.lo <= -1.0 && -1.0 < b.hi)
    expect(aBin?.a).toMatchObject({ games: 1, avgScore: 1 })
    expect(bBin?.b).toMatchObject({ games: 1, avgScore: 0 })
  })

  it("folds a flipped game onto the same perspective axis as an unflipped one", () => {
    // Two games, same starting White-POV eval magnitude, colors flipped: A is
    // White and wins in game 0, A is Black and wins (as Black) in game 1. From
    // A's OWN perspective both are a "+1.0, A won" sample, so they land in the
    // SAME bin instead of cancelling like the raw White-POV numbers would.
    const evalById: EvalMap = new Map([
      [0, { eval: 1.0 }],
      [1, { eval: -1.0 }],
    ])
    const outcomes: GameOutcome[] = [
      {
        id: 0,
        flipped: false,
        result: { Ok: { result: "1-0", termination: "checkmate", plies: 10, start_fen: "", moves: [] } },
      },
      {
        id: 1,
        flipped: true, // A is Black
        result: { Ok: { result: "0-1", termination: "checkmate", plies: 10, start_fen: "", moves: [] } }, // A (Black) wins
      },
    ]
    const bins = buildEngineCurves(outcomes, evalById, -1.25, 1.25)
    const aBin = bins.find((b) => b.lo <= 1.0 && 1.0 < b.hi)
    expect(aBin?.a).toMatchObject({ games: 2, avgScore: 1 })
  })
})

describe("buildTournamentResultExport — JSON export shape (spec 210 TournamentResult)", () => {
  it("maps ProbBin fields onto EvalBucket percentages (0..100) and preserves run config", () => {
    const evalById: EvalMap = new Map([[0, { eval: 0.1 }]])
    const outcomes: GameOutcome[] = [
      {
        id: 0,
        flipped: false,
        result: { Ok: { result: "1-0", termination: "checkmate", plies: 10, start_fen: "", moves: [] } },
      },
    ]
    const bins = buildProbabilityMap(outcomes, evalById, 0, 0.25)
    const exported = buildTournamentResultExport(
      "Stockfish",
      "Reckless",
      1,
      "eval",
      [-2, 2],
      bins,
      "2026-07-15T00:00:00.000Z",
    )
    expect(exported.engineA).toBe("Stockfish")
    expect(exported.engineB).toBe("Reckless")
    expect(exported.totalGames).toBe(1)
    expect(exported.startMode).toBe("eval")
    expect(exported.evalRange).toEqual([-2, 2])
    expect(exported.completedAt).toBe("2026-07-15T00:00:00.000Z")
    expect(exported.buckets).toHaveLength(1)
    expect(exported.buckets[0]).toMatchObject({ games: 1, winPct: 100, drawPct: 0, lossPct: 0 })
  })
})

describe("parseOpeningPositions — user-picked EPD/FEN files (spec 210 Phase 3)", () => {
  const START_BOARD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"

  it("parses full-FEN lines verbatim, one position per line", () => {
    const text = `${START_BOARD} w KQkq - 0 1\n${START_BOARD} b KQkq - 3 12\n`
    const parsed = parseOpeningPositions(text, "book.fen")
    expect(parsed.positions.map((p) => p.fen)).toEqual([
      `${START_BOARD} w KQkq - 0 1`,
      `${START_BOARD} b KQkq - 3 12`,
    ])
    expect(parsed.tagged).toBe(0)
    expect(parsed.skipped).toBe(0)
    // Untagged lines get eval 0 (Book mode's balance filter accepts them).
    expect(parsed.positions.every((p) => p.eval_cp === 0 && p.eval_pawns === 0)).toBe(true)
    expect(parsed.positions.every((p) => p.source === "book.fen")).toBe(true)
  })

  it("completes bare 4-field EPD with ' 0 1' counters so the FEN is runnable", () => {
    const parsed = parseOpeningPositions(`${START_BOARD} w KQkq -\n`, "uho.epd")
    expect(parsed.positions).toHaveLength(1)
    expect(parsed.positions[0].fen).toBe(`${START_BOARD} w KQkq - 0 1`)
  })

  it("reads the EPD `ce` opcode as side-to-move centipawns, stored White-POV", () => {
    const text = [
      `${START_BOARD} w KQkq - ce 90;`, // White to move, +90 stm = +90 White
      `${START_BOARD} b KQkq - hmvc 0; ce 90;`, // Black to move: +90 stm = -90 White
      `${START_BOARD} b KQkq - ce -25;`, // Black to move: -25 stm = +25 White
    ].join("\n")
    const parsed = parseOpeningPositions(text, "uho.epd")
    expect(parsed.tagged).toBe(3)
    expect(parsed.positions.map((p) => p.eval_cp)).toEqual([90, -90, 25])
    expect(parsed.positions.map((p) => p.eval_pawns)).toEqual([0.9, -0.9, 0.25])
  })

  it("skips comment lines silently and counts unparseable lines without failing", () => {
    const text = [
      "# UHO 2024 sample",
      "// generator note",
      "; another comment",
      "",
      `${START_BOARD} w KQkq -`,
      "this is not a position",
      "8/8/8 w - -", // wrong rank count
      `${START_BOARD} x KQkq -`, // bad side to move
    ].join("\n")
    const parsed = parseOpeningPositions(text, "mixed.epd")
    expect(parsed.positions).toHaveLength(1)
    expect(parsed.skipped).toBe(3)
  })

  it("handles CRLF line endings and interleaved FEN/EPD lines", () => {
    const text = `${START_BOARD} w KQkq - 0 1\r\n${START_BOARD} b KQkq - ce 40;\r\n`
    const parsed = parseOpeningPositions(text, "crlf.epd")
    expect(parsed.positions).toHaveLength(2)
    expect(parsed.positions[1].eval_cp).toBe(-40) // Black to move, stm -> White POV
    expect(parsed.tagged).toBe(1)
  })

  it("feeds buildSeeds book mode directly (balanced filter accepts |eval| <= 0.5)", () => {
    const text = [
      `${START_BOARD} w KQkq - ce 30;`,
      `${START_BOARD} w KQkq - ce 240;`, // too imbalanced for book mode
    ].join("\n")
    const { positions } = parseOpeningPositions(text, "uho.epd")
    const seeds = buildSeeds("book", 4, positions)
    expect(seeds).toHaveLength(4)
    // Only the balanced position qualifies; the pool cycles it.
    expect(seeds.every((s) => s.fen === `${START_BOARD} w KQkq - 0 1`)).toBe(true)
  })
})

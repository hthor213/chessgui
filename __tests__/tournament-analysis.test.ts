// Spec 212 tier-1 consumers: fixture outcomes with known answers for every
// aggregation (error profiles + delta, band trajectories, seed breakdown,
// termination quality, annotated-PGN handoff) plus the win-prob labeler's two
// closed gaps (persisted clocks fallback, evaluator-PV best-move gap).

import { describe, it, expect } from "vitest"
import {
  analyzeGame,
  annotatedGamePgn,
  buildBandTrajectories,
  buildErrorProfiles,
  buildSeedBreakdown,
  buildTerminationQuality,
  errorProfileDelta,
  fenMaterial,
  fenPhase,
  gamePhases,
  per100,
  swingComment,
  LABEL_NAG,
} from "@/lib/tournament-analysis"
import {
  computeMoveSwings,
  DEFAULT_LOGISTIC_K,
  type WinProbCurve,
} from "@/lib/win-prob"
import {
  STANDARD_START_FEN,
  type EvalMap,
  type GameOutcome,
  type PlyEval,
} from "@/lib/tournament"
import { parsePgnToTrees } from "@/lib/pgn"

// Linear curve over [-8, +8]: winProb(e) = (e + 8) / 16 exactly, so a 400cp
// White-POV swing is a float-exact 0.25 win-prob drop (= blunder threshold).
const LINEAR_CURVE: WinProbCurve = {
  anchors: [
    { e: -8, w: 0 },
    { e: 8, w: 1 },
  ],
  k: DEFAULT_LOGISTIC_K,
  source: "map",
}

const cp = (ply: number, v: number, best?: string): PlyEval => ({
  ply,
  cp: v,
  mate: null,
  ...(best !== undefined ? { best } : {}),
})

function okOutcome(opts: {
  id?: number
  flipped?: boolean
  result?: "1-0" | "0-1" | "1/2-1/2"
  termination?: string
  startFen?: string
  moves?: string[]
  evals?: PlyEval[]
  clocksMs?: [number, number][]
  aborted?: boolean
}): GameOutcome {
  const moves = opts.moves ?? []
  return {
    id: opts.id ?? 0,
    flipped: opts.flipped ?? false,
    result: {
      Ok: {
        result: opts.result ?? "1-0",
        termination: opts.termination ?? "checkmate",
        plies: moves.length,
        start_fen: opts.startFen ?? STANDARD_START_FEN,
        moves,
        ...(opts.clocksMs ? { clocks_ms: opts.clocksMs } : {}),
      },
    },
    evals: opts.evals,
    aborted: opts.aborted,
  }
}

const OPENING_MOVES = ["e2e4", "e7e5", "g1f3", "b8c6"]

// White (engine a, unflipped) blunders 400cp at ply 3; Black is error-free.
// evals: 0,0,0,-400,-400 — the only drop is White's move to ply 3.
function whiteBlunderGame(id = 0, extra: Partial<Parameters<typeof okOutcome>[0]> = {}) {
  return okOutcome({
    id,
    result: "0-1",
    moves: OPENING_MOVES,
    evals: [cp(0, 0), cp(1, 0), cp(2, 0), cp(3, -400), cp(4, -400)],
    ...extra,
  })
}

// K+R vs K endgame seed (material 5 → endgame); White (a) blunders its +4.
const KRK_FEN = "8/8/4k3/8/8/4K3/8/R7 w - - 0 40"
function endgameBlunderGame(id = 0, flipped = false) {
  return okOutcome({
    id,
    flipped,
    result: "1/2-1/2",
    termination: "stalemate",
    startFen: KRK_FEN,
    moves: ["a1a8"],
    evals: [cp(0, 400), cp(1, 0)],
  })
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

describe("game phases (material + ply heuristic)", () => {
  it("counts non-pawn material", () => {
    expect(fenMaterial(STANDARD_START_FEN)).toBe(2 * (9 + 10 + 6 + 6)) // 62/side... both sides
    expect(fenMaterial(KRK_FEN)).toBe(5)
  })

  it("classifies opening / middlegame / endgame", () => {
    expect(fenPhase(STANDARD_START_FEN)).toBe("opening")
    // Full material but fullmove 11 → middlegame.
    expect(
      fenPhase("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 11"),
    ).toBe("middlegame")
    // Low material dominates ply: an early K+R ending is an endgame.
    expect(fenPhase("8/8/4k3/8/8/4K3/8/R7 w - - 0 3")).toBe("endgame")
  })

  it("returns the phase each move was played FROM", () => {
    const phases = gamePhases(STANDARD_START_FEN, OPENING_MOVES)
    expect(phases).toEqual(["opening", "opening", "opening", "opening"])
    expect(gamePhases(KRK_FEN, ["a1a8"])).toEqual(["endgame"])
  })
})

// ---------------------------------------------------------------------------
// Per-game analysis (game list markers)
// ---------------------------------------------------------------------------

describe("analyzeGame", () => {
  it("counts labels per engine and finds the decisive moment", () => {
    const a = analyzeGame(whiteBlunderGame(), LINEAR_CURVE)
    expect(a.counts.a).toEqual({ inaccuracy: 0, mistake: 0, blunder: 1 })
    expect(a.counts.b).toEqual({ inaccuracy: 0, mistake: 0, blunder: 0 })
    expect(a.labeled).toHaveLength(1)
    expect(a.decisive?.ply).toBe(3)
    expect(a.decisive?.engine).toBe("a")
    expect(a.decisive?.label).toBe("blunder")
  })

  it("attributes the mover to engine b when the game is flipped", () => {
    const a = analyzeGame(whiteBlunderGame(1, { flipped: true }), LINEAR_CURVE)
    expect(a.counts.b.blunder).toBe(1)
    expect(a.counts.a.blunder).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Error profiles + delta view
// ---------------------------------------------------------------------------

describe("buildErrorProfiles", () => {
  it("buckets errors by engine × phase × clock pressure with per-move denominators", () => {
    // White (a) at 60s (ok); Black (b) under 30s (low) — a blunders once.
    const game = whiteBlunderGame(0, {
      clocksMs: [
        [60_000, 60_000],
        [60_000, 25_000],
        [60_000, 25_000],
        [60_000, 20_000],
      ],
    })
    const { a, b } = buildErrorProfiles([game], LINEAR_CURVE)
    expect(a.moves).toBe(2) // white moved at plies 1 and 3
    expect(b.moves).toBe(2)
    expect(a.counts.blunder).toBe(1)
    expect(a.cells.opening.ok).toEqual({ moves: 2, inaccuracy: 0, mistake: 0, blunder: 1 })
    expect(a.cells.opening.low.moves).toBe(0)
    expect(b.cells.opening.low).toEqual({ moves: 2, inaccuracy: 0, mistake: 0, blunder: 0 })
    expect(per100(a.cells.opening.ok, "blunder")).toBe(50)
    expect(per100(b.cells.opening.ok, "blunder")).toBeNull() // empty cell
  })

  it("assigns endgame errors to the endgame phase (material dominates)", () => {
    const { a, b } = buildErrorProfiles([endgameBlunderGame()], LINEAR_CURVE)
    expect(a.cells.endgame.ok).toEqual({ moves: 1, inaccuracy: 0, mistake: 0, blunder: 1 })
    expect(b.moves).toBe(0)
    // Flipped: the same White blunder belongs to engine b.
    const flipped = buildErrorProfiles([endgameBlunderGame(1, true)], LINEAR_CURVE)
    expect(flipped.b.cells.endgame.ok.blunder).toBe(1)
    expect(flipped.a.moves).toBe(0)
  })

  it("delta rows compare rates and compute the b/a ratio", () => {
    // a blunders twice (plies 1, 3), b blunders once (ply 2):
    // evals 0,-400,0,-400,-400.
    const game = okOutcome({
      result: "0-1",
      moves: OPENING_MOVES,
      evals: [cp(0, 0), cp(1, -400), cp(2, 0), cp(3, -400), cp(4, -400)],
    })
    const { a, b } = buildErrorProfiles([game], LINEAR_CURVE)
    const rows = errorProfileDelta(a, b)
    const row = rows.find((r) => r.phase === "opening" && r.clock === "ok" && r.label === "blunder")!
    expect(row.aRate).toBe(100) // 2 blunders / 2 moves
    expect(row.bRate).toBe(50) // 1 blunder / 2 moves
    expect(row.ratio).toBeCloseTo(0.5, 10)
    // No rows for phases with no moves at all.
    expect(rows.some((r) => r.phase === "endgame")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Band trajectories
// ---------------------------------------------------------------------------

describe("buildBandTrajectories", () => {
  it("groups by A-perspective start bucket with exact mean/sd", () => {
    const evalById: EvalMap = new Map([
      [0, { eval: 1.0 }],
      [1, { eval: 1.0 }],
    ])
    const g0 = okOutcome({ id: 0, moves: ["e2e4"], evals: [cp(0, 100), cp(1, 200)] })
    const g1 = okOutcome({ id: 1, moves: ["e2e4"], evals: [cp(0, 100), cp(1, 0)] })
    const bands = buildBandTrajectories([g0, g1], evalById)
    expect(bands).toHaveLength(1)
    const band = bands[0]
    expect(band.lo).toBe(1.0)
    expect(band.hi).toBe(1.5)
    expect(band.games).toBe(2)
    expect(band.points[0]).toEqual({ ply: 0, mean: 1, sd: 0, n: 2 })
    // ply 1: values 2.0 and 0.0 → mean 1, population sd 1.
    expect(band.points[1].mean).toBeCloseTo(1, 10)
    expect(band.points[1].sd).toBeCloseTo(1, 10)
  })

  it("sign-flips a flipped game into engine A's perspective", () => {
    const evalById: EvalMap = new Map([[0, { eval: 1.0 }]])
    const g = okOutcome({ id: 0, flipped: true, moves: ["e2e4"], evals: [cp(0, 100)] })
    const bands = buildBandTrajectories([g], evalById)
    expect(bands).toHaveLength(1)
    expect(bands[0].lo).toBe(-1.0) // A started DOWN one pawn
    expect(bands[0].points[0].mean).toBeCloseTo(-1, 10)
  })
})

// ---------------------------------------------------------------------------
// Seed / opening-family breakdown
// ---------------------------------------------------------------------------

describe("buildSeedBreakdown", () => {
  const F1 = "r1bqk2r/pp1nn1bp/2p1p1p1/3pNp2/2PP4/6P1/PP1NPPBP/R1BQ1RK1 w kq - 4 9"
  const F2 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"

  it("groups by tag × |eval| bucket and scores engine A", () => {
    const evalById: EvalMap = new Map([
      [0, { eval: 0.75 }],
      [1, { eval: 0.75 }],
      [2, { eval: 0.3 }],
      [3, { eval: -0.3 }],
      [4, { eval: 0.3 }],
      [5, { eval: -0.3 }],
      [6, { eval: 0 }],
    ])
    const tagByFen = new Map([[F1, "UHO_4060_v3 d16"]])
    const outcomes = [
      // F1 pair: A wins as White, loses as Black (flipped, White won) → 0.5.
      okOutcome({ id: 0, startFen: F1, result: "1-0" }),
      okOutcome({ id: 1, startFen: F1, flipped: true, result: "1-0" }),
      // F2: A sweeps 4 games → lopsided.
      okOutcome({ id: 2, startFen: F2, result: "1-0" }),
      okOutcome({ id: 3, startFen: F2, flipped: true, result: "0-1" }),
      okOutcome({ id: 4, startFen: F2, result: "1-0" }),
      okOutcome({ id: 5, startFen: F2, flipped: true, result: "0-1" }),
      // Standard start is its own family.
      okOutcome({ id: 6, result: "1/2-1/2" }),
    ]
    const rows = buildSeedBreakdown(outcomes, evalById, tagByFen)
    expect(rows).toHaveLength(3)

    // Sorted most-lopsided first.
    expect(rows[0].key).toBe("untagged | 0.00–0.50")
    expect(rows[0].games).toBe(4)
    expect(rows[0].aWins).toBe(4)
    expect(rows[0].aScore).toBe(1)
    expect(rows[0].lopsided).toBe(true)

    const f1 = rows.find((r) => r.tag === "UHO_4060_v3 d16")!
    expect(f1.key).toBe("UHO_4060_v3 d16 | 0.50–1.00")
    expect(f1.games).toBe(2)
    expect(f1.seeds).toBe(1)
    expect(f1.aScore).toBe(0.5)
    expect(f1.lopsided).toBe(false)

    const std = rows.find((r) => r.key === "standard start")!
    expect(std.draws).toBe(1)
    expect(std.lo).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Termination quality
// ---------------------------------------------------------------------------

describe("buildTerminationQuality", () => {
  it("cross-classifies terminations × loss quality", () => {
    const outcomes = [
      // Loser (a, White) blundered exactly once; winner error-free.
      whiteBlunderGame(0),
      // Decisive with flat evals: no loser error ≥ mistake → ground down.
      okOutcome({
        id: 1,
        result: "0-1",
        moves: OPENING_MOVES,
        evals: [cp(0, 0), cp(1, 0), cp(2, 0), cp(3, 0), cp(4, 0)],
      }),
      // Loser (a) blundered twice → multi-error.
      okOutcome({
        id: 2,
        result: "0-1",
        moves: OPENING_MOVES,
        evals: [cp(0, 0), cp(1, -400), cp(2, -400), cp(3, -800), cp(4, -800)],
      }),
      // Decisive but no evals at all → unscored.
      okOutcome({ id: 3, result: "1-0", moves: OPENING_MOVES }),
      // A draw, different termination.
      okOutcome({ id: 4, result: "1/2-1/2", termination: "stalemate" }),
    ]
    const rows = buildTerminationQuality(outcomes, LINEAR_CURVE)
    const mate = rows.find((r) => r.termination === "checkmate")!
    expect(mate.games).toBe(4)
    expect(mate.decisive).toBe(4)
    expect(mate.singleBlunder).toBe(1)
    expect(mate.groundDown).toBe(1)
    expect(mate.multiError).toBe(1)
    expect(mate.unscored).toBe(1)
    // Winner was clean in all three scored decisive games.
    expect(mate.cleanConversion).toBe(3)

    const stale = rows.find((r) => r.termination === "stalemate")!
    expect(stale.draws).toBe(1)
    expect(stale.decisive).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Annotated-PGN handoff (labels → NAGs/comments on the Analyze tree)
// ---------------------------------------------------------------------------

describe("annotatedGamePgn", () => {
  it("emits NAG + swing comment + [%eval], and round-trips into the tree", () => {
    const pgn = annotatedGamePgn(whiteBlunderGame(), LINEAR_CURVE, {
      white: "Reckless",
      black: "Stockfish",
      engineNames: { a: "Reckless", b: "Stockfish" },
    })!
    expect(pgn).toContain("$4") // ?? on the blunder
    expect(pgn).toContain("Blunder (Reckless)")
    expect(pgn).toContain("Decisive moment.")
    expect(pgn).toContain("[%eval -4.00]")

    const trees = parsePgnToTrees(pgn)
    expect(trees).toHaveLength(1)
    const tree = trees[0]
    // Walk the mainline to the 3rd move (White's g1f3 blunder per fixture).
    tree.goToStart()
    let id = tree.root().children[0]
    let node = tree.get(id)!
    id = node.children[0]
    node = tree.get(id)!
    id = node.children[0]
    node = tree.get(id)! // ply 3
    expect(node.san).toBe("Nf3")
    expect(node.nags).toContain(LABEL_NAG.blunder)
    expect(node.comment).toContain("win prob 50% → 25%")
    expect(node.eval?.cp).toBe(-400)
  })

  it("returns null for errored/aborted outcomes", () => {
    const err: GameOutcome = { id: 0, flipped: false, result: { Err: "boom" } }
    expect(annotatedGamePgn(err, LINEAR_CURVE)).toBeNull()
    expect(
      annotatedGamePgn(whiteBlunderGame(0, { aborted: true }), LINEAR_CURVE),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// win-prob gaps closed by 212 tier-1.5: persisted clocks + best-move gap
// ---------------------------------------------------------------------------

describe("computeMoveSwings — persisted clocks_ms fallback", () => {
  it("reads each mover's clock from GameResult.clocks_ms when no stream clocks given", () => {
    const game = whiteBlunderGame(0, {
      clocksMs: [
        [59_000, 60_000],
        [59_000, 58_000],
        [57_500, 58_000],
        [57_500, 56_000],
      ],
    })
    const swings = computeMoveSwings(game, LINEAR_CURVE)
    expect(swings.map((s) => s.clockMs)).toEqual([59_000, 58_000, 57_500, 56_000])
  })

  it("still yields null clocks when neither source is available", () => {
    const swings = computeMoveSwings(whiteBlunderGame(), LINEAR_CURVE)
    expect(swings.every((s) => s.clockMs === null)).toBe(true)
  })
})

describe("computeMoveSwings — bestMoveGapCp from the evaluator PV", () => {
  it("is 0 when the played move matches the PV, mover-POV cp loss otherwise, null without a PV", () => {
    const game = okOutcome({
      result: "0-1",
      moves: OPENING_MOVES, // e2e4 e7e5 g1f3 b8c6
      evals: [
        cp(0, 0, "e2e4"), // played e2e4 == best → gap 0
        cp(1, 0, "c7c5"), // played e7e5 ≠ best; black loses 0cp → gap 0 (floored)
        cp(2, 0, "d2d4"), // played g1f3 ≠ best; white 0 → -400 → gap 400
        cp(3, -400), // no PV → null
        cp(4, -400),
      ],
    })
    const swings = computeMoveSwings(game, LINEAR_CURVE)
    expect(swings[0].bestMoveGapCp).toBe(0)
    expect(swings[1].bestMoveGapCp).toBe(0)
    expect(swings[2].bestMoveGapCp).toBe(400)
    expect(swings[3].bestMoveGapCp).toBeNull()
  })

  it("measures the gap from the BLACK mover's perspective", () => {
    // Black plays e7e5 while the PV wanted c7c5; White-POV goes 0 → +300,
    // i.e. Black lost 300cp.
    const game = okOutcome({
      moves: ["e2e4", "e7e5"],
      evals: [cp(0, 0, "e2e4"), cp(1, 0, "c7c5"), cp(2, 300)],
    })
    const swings = computeMoveSwings(game, LINEAR_CURVE)
    expect(swings[1].mover).toBe("black")
    expect(swings[1].bestMoveGapCp).toBe(300)
  })
})

describe("swingComment", () => {
  it("names the mover and includes the win-prob swing and best-move gap", () => {
    const game = okOutcome({
      result: "0-1",
      moves: OPENING_MOVES,
      evals: [cp(0, 0), cp(1, 0), cp(2, 0, "d2d4"), cp(3, -400), cp(4, -400)],
    })
    const s = computeMoveSwings(game, LINEAR_CURVE)[2]
    const text = swingComment(s, "Reckless", true)
    expect(text).toContain("Blunder (Reckless)")
    expect(text).toContain("50% → 25%")
    expect(text).toContain("−25pp")
    expect(text).toContain("400cp off")
    expect(text).toContain("Decisive moment.")
  })
})

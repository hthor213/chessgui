// Headless render smoke tests for the spec 212 analysis sections (error
// profile, band trajectories, seed breakdown, termination quality) and the
// ResultsExplorer's per-game decisive-moment/error-count markers. Same
// renderToStaticMarkup pattern as spar-render.test.ts — effects don't run, so
// this exercises exactly the pure fixture → markup path.

import { describe, it, expect, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

// The board is a next/dynamic({ ssr: false }) import; stub it so the explorer
// renders without pulling in Chessground.
vi.mock("next/dynamic", () => ({
  default: () => () => null,
}))

import {
  ResultsExplorer,
  ErrorProfileSection,
  BandTrajectorySection,
  SeedBreakdownSection,
  TerminationQualitySection,
} from "@chessgui/ui/tournament-tab"
import { DEFAULT_LOGISTIC_K, type WinProbCurve } from "@chessgui/core/win-prob"
import {
  STANDARD_START_FEN,
  type EvalMap,
  type GameOutcome,
  type PlyEval,
} from "@chessgui/core/tournament"

const LINEAR_CURVE: WinProbCurve = {
  anchors: [
    { e: -8, w: 0 },
    { e: 8, w: 1 },
  ],
  k: DEFAULT_LOGISTIC_K,
  source: "map",
}

const cp = (ply: number, v: number): PlyEval => ({ ply, cp: v, mate: null })

// White (engine a) blunders 400cp at ply 3 (see tournament-analysis.test.ts).
const game: GameOutcome = {
  id: 0,
  flipped: false,
  result: {
    Ok: {
      result: "0-1",
      termination: "checkmate",
      plies: 4,
      start_fen: STANDARD_START_FEN,
      moves: ["e2e4", "e7e5", "g1f3", "b8c6"],
      clocks_ms: [
        [60_000, 60_000],
        [60_000, 25_000],
        [60_000, 25_000],
        [60_000, 20_000],
      ],
    },
  },
  evals: [cp(0, 0), cp(1, 0), cp(2, 0), cp(3, -400), cp(4, -400)],
}

const evalById: EvalMap = new Map([[0, { eval: 0 }]])

describe("spec 212 sections render from fixture outcomes", () => {
  it("ResultsExplorer list rows carry decisive moment + error counts", () => {
    const html = renderToStaticMarkup(
      createElement(ResultsExplorer, {
        outcomes: [game],
        labelA: "Stockfish",
        labelB: "Reckless",
        curve: LINEAR_CURVE,
      }),
    )
    expect(html).toContain('data-testid="tournament-game-row-0"')
    // Blunder at ply 3 → decided at move 2, one ?? by engine a (Stockfish).
    expect(html).toContain("decided m2")
    expect(html).toContain("1??")
  })

  it("ErrorProfileSection shows per-engine tables and the delta view", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorProfileSection, {
        outcomes: [game],
        curve: LINEAR_CURVE,
        labelA: "Stockfish",
        labelB: "Reckless",
        lowClockMs: 30_000,
      }),
    )
    expect(html).toContain('data-testid="tournament-error-profile"')
    expect(html).toContain("Opening · ok") // a's cell (white at 60s)
    expect(html).toContain("Opening · &lt;30s") // b's cell (black under 30s)
    expect(html).toContain("50.0") // a: 1 blunder / 2 moves = 50 per 100
  })

  it("BandTrajectorySection renders a chart per populated band", () => {
    const two = [game, { ...game, id: 1 }]
    const byId: EvalMap = new Map([
      [0, { eval: 0 }],
      [1, { eval: 0 }],
    ])
    const html = renderToStaticMarkup(
      createElement(BandTrajectorySection, {
        outcomes: two,
        evalById: byId,
        labelA: "Stockfish",
        labelB: "Reckless",
      }),
    )
    expect(html).toContain('data-testid="tournament-band-trajectories"')
    expect(html).toContain("2 games")
  })

  it("SeedBreakdownSection lists families with A's score", () => {
    const gameOk = (game.result as { Ok: Extract<GameOutcome["result"], { Ok: unknown }>["Ok"] }).Ok
    const other: GameOutcome = {
      ...game,
      id: 1,
      result: {
        Ok: {
          ...gameOk,
          result: "1-0",
          start_fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        },
      },
    }
    const byId: EvalMap = new Map([
      [0, { eval: 0 }],
      [1, { eval: 0.3 }],
    ])
    const html = renderToStaticMarkup(
      createElement(SeedBreakdownSection, {
        outcomes: [game, other],
        evalById: byId,
        labelA: "Stockfish",
      }),
    )
    expect(html).toContain('data-testid="tournament-seed-breakdown"')
    expect(html).toContain("standard start")
    expect(html).toContain("untagged | 0.00–0.50")
  })

  it("TerminationQualitySection cross-classifies loser errors", () => {
    const html = renderToStaticMarkup(
      createElement(TerminationQualitySection, {
        outcomes: [game],
        curve: LINEAR_CURVE,
        labelA: "Stockfish",
        labelB: "Reckless",
      }),
    )
    expect(html).toContain('data-testid="tournament-termination-quality"')
    expect(html).toContain("checkmate")
    expect(html).toContain("single ??")
  })
})

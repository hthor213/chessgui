// Batch "Analyze Game" runner (spec 212 single-game blunder check,
// lib/game-analysis.ts) against a scripted fake engine: white-POV eval
// conversion, judgment callbacks, progress, terminal-position skip, the spec
// 219 lockout (before and mid-run), and cancellation. Plus render smoke
// tests for the GameAnalysisControl card (same renderToStaticMarkup pattern
// as spar-render.test.ts).

import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import {
  runGameAnalysis,
  whitePovEval,
  GAME_ANALYSIS_SESSION,
  type AnalysisTarget,
  type GameAnalysisEngine,
} from "@/lib/game-analysis"
import { GameAnalysisControl } from "@chessgui/ui/game-analysis-control"
import { GameTree } from "@chessgui/core/game-tree"
import { ENGINE_LOCKED_MESSAGE, type ActiveGameMeta } from "@chessgui/core/active-game"
import type { NodeEval } from "@chessgui/core/game-tree"
import type { MoveJudgment } from "@chessgui/core/annotations"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function targetsFor(sans: string[]): AnalysisTarget[] {
  const tree = GameTree.create()
  for (const san of sans) expect(tree.addMoveSan(san)).not.toBeNull()
  return tree.mainlineNodes().map((n) => ({ id: n.id, fen: n.fen, uci: n.uci }))
}

/**
 * Scripted engine: answers the i-th `go` with `info … score cp <scripted>`
 * (mover POV) then `bestmove`, asynchronously like the real event stream.
 * Records every command so tests can assert session/context/ordering.
 */
function fakeEngine(scriptedCp: number[]) {
  const commands: string[] = []
  const contexts: (string | undefined)[] = []
  const sessions: (string | undefined)[] = []
  let listener: ((line: string) => void) | null = null
  let goCount = 0
  const engine: GameAnalysisEngine = {
    async startEngine(_path, context, sessionId) {
      contexts.push(context)
      sessions.push(sessionId)
      return { name: "FakeFish", ready: true }
    },
    async sendCommand(command, context, sessionId) {
      commands.push(command)
      contexts.push(context)
      sessions.push(sessionId)
      if (command.startsWith("go ")) {
        const cp = scriptedCp[goCount++] ?? 0
        const l = listener
        // Deliver like the real stream: after the send resolves.
        queueMicrotask(() => {
          l?.(`info depth 18 seldepth 24 multipv 1 score cp ${cp} nodes 1000 nps 100000 pv e2e4`)
          l?.("bestmove e2e4")
        })
      }
    },
    async stopEngine() {
      listener = null
    },
    async onEngineLine(onLine) {
      listener = onLine
      return () => {
        listener = null
      }
    },
  }
  return { engine, commands, contexts, sessions }
}

function collector() {
  const evals: Array<{ id: string; ev: NodeEval }> = []
  const judgments: Array<{ id: string; judgment: MoveJudgment }> = []
  const progress: Array<[number, number]> = []
  return {
    evals,
    judgments,
    progress,
    callbacks: {
      onEval: (id: string, ev: NodeEval) => evals.push({ id, ev }),
      onJudgment: (id: string, judgment: MoveJudgment) => judgments.push({ id, judgment }),
      onProgress: (done: number, total: number) => progress.push([done, total]),
    },
  }
}

const ACTIVE: ActiveGameMeta = {
  opponent: "rival",
  chesscomUsername: "me",
  gameUrl: null,
  flaggedAt: 1,
}

// ---------------------------------------------------------------------------
// whitePovEval
// ---------------------------------------------------------------------------

describe("whitePovEval", () => {
  it("keeps white-to-move scores and flips black-to-move scores", () => {
    expect(whitePovEval({ type: "cp", value: 35 }, "white", 18)).toEqual({ cp: 35, depth: 18 })
    expect(whitePovEval({ type: "cp", value: 35 }, "black", 18)).toEqual({ cp: -35, depth: 18 })
    expect(whitePovEval({ type: "mate", value: 3 }, "black", 18)).toEqual({ mate: -3, depth: 18 })
  })
})

// ---------------------------------------------------------------------------
// runGameAnalysis
// ---------------------------------------------------------------------------

describe("runGameAnalysis", () => {
  it("evaluates every mainline position, converts to white POV, labels the blunder", async () => {
    // 1.e4 e5 2.Nf3: root + 3 moves. Mover-POV scripted scores:
    // root (w) +30 → +30 | after e4 (b) -30 → +30 | after e5 (w, black just
    // moved) +430 → +430: black's e5 dropped black 4 pawns → blunder.
    // after Nf3 (b) -430 → +430: no further swing.
    const targets = targetsFor(["e4", "e5", "Nf3"])
    const { engine, commands, sessions } = fakeEngine([30, -30, 430, -430])
    const c = collector()

    const result = await runGameAnalysis({
      engine,
      enginePath: "/fake/stockfish",
      targets,
      activeGame: () => null,
      isCancelled: () => false,
      callbacks: c.callbacks,
    })

    expect(result).toEqual({ completed: true, error: null })
    expect(c.evals.map((e) => e.ev)).toEqual([
      { cp: 30, depth: 18 },
      { cp: 30, depth: 18 },
      { cp: 430, depth: 18 },
      { cp: 430, depth: 18 },
    ])
    // Exactly one judgment: black's 1...e5 (the third target).
    expect(c.judgments).toEqual([{ id: targets[2].id, judgment: "blunder" }])
    expect(c.progress).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ])
    // Every command rode the dedicated session.
    expect(new Set(sessions)).toEqual(new Set([GAME_ANALYSIS_SESSION]))
    // Position commands carry the game history for repetition-aware evals.
    expect(commands).toContain("position startpos moves e2e4 e7e5")
    expect(commands.filter((cmd) => cmd.startsWith("go movetime"))).toHaveLength(4)
  })

  it("skips terminal positions (mate delivery goes unjudged, progress still completes)", async () => {
    // Fool's mate: final position is checkmate → no search for it.
    const targets = targetsFor(["f3", "e5", "g4", "Qh4#"])
    const { engine, commands } = fakeEngine([0, 0, -900, 0])
    const c = collector()

    const result = await runGameAnalysis({
      engine,
      enginePath: "/fake/stockfish",
      targets,
      activeGame: () => null,
      isCancelled: () => false,
      callbacks: c.callbacks,
    })

    expect(result.completed).toBe(true)
    // 5 targets, 4 searched (mate position skipped), progress reaches 5/5.
    expect(commands.filter((cmd) => cmd.startsWith("go movetime"))).toHaveLength(4)
    expect(c.evals).toHaveLength(4)
    expect(c.progress[c.progress.length - 1]).toEqual([5, 5])
    // The mate node has no eval, so the mating move is never judged.
    expect(c.judgments.find((j) => j.id === targets[4].id)).toBeUndefined()
    expect(c.evals.find((e) => e.id === targets[4].id)).toBeUndefined()
  })

  it("refuses to run for an active game (spec 219) without touching the engine", async () => {
    const targets = targetsFor(["e4"])
    const { engine, commands } = fakeEngine([0, 0])
    const c = collector()

    const result = await runGameAnalysis({
      engine,
      enginePath: "/fake/stockfish",
      targets,
      activeGame: () => ACTIVE,
      isCancelled: () => false,
      callbacks: c.callbacks,
    })

    expect(result).toEqual({ completed: false, error: ENGINE_LOCKED_MESSAGE })
    expect(commands).toHaveLength(0)
    expect(c.evals).toHaveLength(0)
  })

  it("aborts mid-run when the game becomes active (flag flips between positions)", async () => {
    const targets = targetsFor(["e4", "e5", "Nf3"])
    const { engine } = fakeEngine([30, -30, 30, -30])
    const c = collector()

    let calls = 0
    const result = await runGameAnalysis({
      engine,
      enginePath: "/fake/stockfish",
      targets,
      // Locked from the third check onward (root and first move analyzed).
      activeGame: () => (++calls > 2 ? ACTIVE : null),
      isCancelled: () => false,
      callbacks: c.callbacks,
    })

    expect(result).toEqual({ completed: false, error: ENGINE_LOCKED_MESSAGE })
    expect(c.evals.length).toBeLessThan(4)
  })

  it("stops early on cancellation with no error", async () => {
    const targets = targetsFor(["e4", "e5", "Nf3"])
    const { engine } = fakeEngine([30, -30, 30, -30])
    const c = collector()

    const result = await runGameAnalysis({
      engine,
      enginePath: "/fake/stockfish",
      targets,
      activeGame: () => null,
      isCancelled: () => c.evals.length >= 2,
      callbacks: c.callbacks,
    })

    expect(result).toEqual({ completed: false, error: null })
    expect(c.evals).toHaveLength(2)
  })

  it("surfaces an engine-start failure as the run error", async () => {
    const targets = targetsFor(["e4"])
    const engine: GameAnalysisEngine = {
      startEngine: async () => {
        throw new Error("spawn failed")
      },
      sendCommand: async () => {},
      stopEngine: async () => {},
      onEngineLine: async () => () => {},
    }
    const result = await runGameAnalysis({
      engine,
      enginePath: "/missing",
      targets,
      activeGame: () => null,
      isCancelled: () => false,
      callbacks: collector().callbacks,
    })
    expect(result.completed).toBe(false)
    expect(result.error).toContain("spawn failed")
  })
})

// ---------------------------------------------------------------------------
// GameAnalysisControl — render smoke tests
// ---------------------------------------------------------------------------

describe("GameAnalysisControl", () => {
  it("idle: shows the start button", () => {
    const html = renderToStaticMarkup(
      createElement(GameAnalysisControl, {
        state: { running: false, done: 0, total: 0, error: null },
        onStart: () => {},
        onCancel: () => {},
      }),
    )
    expect(html).toContain("analyze-game-button")
    expect(html).toContain("Analyze game")
    expect(html).not.toContain("analyze-game-progress")
  })

  it("running: shows progress and cancel instead of start", () => {
    const html = renderToStaticMarkup(
      createElement(GameAnalysisControl, {
        state: { running: true, done: 12, total: 45, error: null },
        onStart: () => {},
        onCancel: () => {},
      }),
    )
    expect(html).toContain("analyze-game-progress")
    expect(html).toContain("12/45")
    expect(html).toContain("analyze-game-cancel")
    expect(html).not.toContain("analyze-game-button")
  })

  it("error: shows the message once idle again", () => {
    const html = renderToStaticMarkup(
      createElement(GameAnalysisControl, {
        state: { running: false, done: 0, total: 0, error: ENGINE_LOCKED_MESSAGE },
        onStart: () => {},
        onCancel: () => {},
      }),
    )
    expect(html).toContain("analyze-game-error")
    expect(html).toContain("fair play")
  })
})

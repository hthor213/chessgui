// Deep multi-PV re-analysis runner (spec 212 "deep verify decisive moments",
// lib/deep-analysis.ts) against a scripted fake engine: multipv line
// collection, white-POV conversion, PV→SAN reconstruction, per-position
// reports/progress, the spec 219 lockout (before and mid-run), and
// cancellation. Same fake-engine shape as game-analysis.test.ts.

import { describe, it, expect } from "vitest"

import {
  runDeepAnalysis,
  DEEP_ANALYSIS_SESSION,
  DEEP_MULTIPV,
  type DeepPositionReport,
  type DeepTarget,
} from "@/lib/deep-analysis"
import { ENGINE_LOCKED_MESSAGE, type ActiveGameMeta } from "@chessgui/core/active-game"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
// After 1.e4 e5 2.Nf3 — Black to move (mover-POV scores must flip).
const BLACK_TO_MOVE_FEN =
  "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2"

/** One `go` answer: the info lines to emit (verbatim UCI) then a bestmove. */
type GoScript = string[]

/**
 * Scripted engine: answers the i-th `go` with its scripted info lines then
 * `bestmove`, asynchronously like the real event stream. Records every
 * command/context/session so tests can assert the spec 219/900 plumbing.
 */
function fakeEngine(scripts: GoScript[]) {
  const commands: string[] = []
  const contexts: (string | undefined)[] = []
  const sessions: (string | undefined)[] = []
  let listener: ((line: string) => void) | null = null
  let goCount = 0
  const engine = {
    async startEngine(_path: string, context?: string, sessionId?: string) {
      contexts.push(context)
      sessions.push(sessionId)
      return { name: "FakeFish", ready: true }
    },
    async sendCommand(command: string, context?: string, sessionId?: string) {
      commands.push(command)
      contexts.push(context)
      sessions.push(sessionId)
      if (command.startsWith("go ")) {
        const lines = scripts[goCount++] ?? []
        const l = listener
        queueMicrotask(() => {
          for (const line of lines) l?.(line)
          l?.("bestmove e2e4")
        })
      }
    },
    async stopEngine() {
      listener = null
    },
    async onEngineLine(onLine: (line: string) => void) {
      listener = onLine
      return () => {
        listener = null
      }
    },
  }
  return { engine, commands, contexts, sessions }
}

function collector() {
  const reports: DeepPositionReport[] = []
  const progress: Array<[number, number]> = []
  return {
    reports,
    progress,
    onPosition: (r: DeepPositionReport) => reports.push(r),
    onProgress: (done: number, total: number) => progress.push([done, total]),
  }
}

const ACTIVE: ActiveGameMeta = {
  opponent: "rival",
  chesscomUsername: "me",
  gameUrl: null,
  flaggedAt: 1,
}

const info = (multipv: number, score: string, pv: string) =>
  `info depth 24 seldepth 30 multipv ${multipv} score ${score} nodes 9 nps 9 pv ${pv}`

// ---------------------------------------------------------------------------
// runDeepAnalysis
// ---------------------------------------------------------------------------

describe("runDeepAnalysis", () => {
  it("collects multipv lines, flips black-to-move scores to white POV, reconstructs SAN", async () => {
    const targets: DeepTarget[] = [{ ply: 4, fen: BLACK_TO_MOVE_FEN }]
    const { engine, commands, contexts, sessions } = fakeEngine([
      [
        // Later depths overwrite earlier ones per multipv slot.
        info(1, "cp -10", "b8c6"),
        info(1, "cp -25", "b8c6 f1b5"),
        info(2, "cp -60", "g8f6 f3e5"),
        info(3, "mate -4", "f7f6 f3e5"),
      ],
    ])
    const c = collector()

    const result = await runDeepAnalysis({
      engine,
      enginePath: "/fake/stockfish",
      targets,
      activeGame: () => null,
      isCancelled: () => false,
      onPosition: c.onPosition,
      onProgress: c.onProgress,
    })

    expect(result).toEqual({ completed: true, error: null })
    expect(c.reports).toHaveLength(1)
    const r = c.reports[0]
    expect(r.ply).toBe(4)
    expect(r.fen).toBe(BLACK_TO_MOVE_FEN)
    // Black to move: mover-POV cp/mate flip sign; sorted by multipv.
    expect(r.lines).toEqual([
      { multipv: 1, cp: 25, mate: null, depth: 24, sans: ["Nc6", "Bb5"] },
      { multipv: 2, cp: 60, mate: null, depth: 24, sans: ["Nf6", "Nxe5"] },
      { multipv: 3, cp: null, mate: 4, depth: 24, sans: ["f6", "Nxe5"] },
    ])
    expect(c.progress).toEqual([[1, 1]])

    // MultiPV option set, position sent as a bare FEN, unrestricted context,
    // own engine slot everywhere.
    expect(commands).toContain(`setoption name MultiPV value ${DEEP_MULTIPV}`)
    expect(commands).toContain(`position fen ${BLACK_TO_MOVE_FEN}`)
    expect(contexts.every((x) => x === "unrestricted")).toBe(true)
    expect(sessions.every((x) => x === DEEP_ANALYSIS_SESSION)).toBe(true)
  })

  it("searches every target in order and reports each position", async () => {
    const targets: DeepTarget[] = [
      { ply: 1, fen: START_FEN },
      { ply: 4, fen: BLACK_TO_MOVE_FEN },
    ]
    const { engine, commands } = fakeEngine([
      [info(1, "cp 30", "e2e4 e7e5")],
      [info(1, "cp -20", "b8c6")],
    ])
    const c = collector()

    const result = await runDeepAnalysis({
      engine,
      enginePath: "/fake/stockfish",
      targets,
      activeGame: () => null,
      isCancelled: () => false,
      onPosition: c.onPosition,
      onProgress: c.onProgress,
      multiPv: 1,
    })

    expect(result).toEqual({ completed: true, error: null })
    expect(c.reports.map((r) => r.ply)).toEqual([1, 4])
    // White to move at target 1 (no flip); Black at target 2 (flip).
    expect(c.reports[0].lines[0]).toMatchObject({ cp: 30, sans: ["e4", "e5"] })
    expect(c.reports[1].lines[0]).toMatchObject({ cp: 20, sans: ["Nc6"] })
    expect(c.progress).toEqual([
      [1, 2],
      [2, 2],
    ])
    expect(commands.filter((cmd) => cmd.startsWith("go "))).toHaveLength(2)
  })

  it("reports an empty line list when the engine produced no parseable PV", async () => {
    const { engine } = fakeEngine([[]])
    const c = collector()
    const result = await runDeepAnalysis({
      engine,
      enginePath: "/fake/stockfish",
      targets: [{ ply: 2, fen: START_FEN }],
      activeGame: () => null,
      isCancelled: () => false,
      onPosition: c.onPosition,
    })
    expect(result).toEqual({ completed: true, error: null })
    expect(c.reports).toEqual([{ ply: 2, fen: START_FEN, lines: [] }])
  })

  it("refuses to start under the spec 219 lockout, without touching the engine", async () => {
    const { engine, commands } = fakeEngine([])
    const c = collector()
    const result = await runDeepAnalysis({
      engine,
      enginePath: "/fake/stockfish",
      targets: [{ ply: 1, fen: START_FEN }],
      activeGame: () => ACTIVE,
      isCancelled: () => false,
      onPosition: c.onPosition,
    })
    expect(result).toEqual({ completed: false, error: ENGINE_LOCKED_MESSAGE })
    expect(commands).toHaveLength(0)
    expect(c.reports).toHaveLength(0)
  })

  it("stops mid-run when the lockout flips on (ambiguity resolves to OFF)", async () => {
    let flag: ActiveGameMeta | null = null
    const { engine } = fakeEngine([[info(1, "cp 10", "e2e4")], [info(1, "cp 10", "e2e4")]])
    const c = collector()
    const result = await runDeepAnalysis({
      engine,
      enginePath: "/fake/stockfish",
      targets: [
        { ply: 1, fen: START_FEN },
        { ply: 3, fen: START_FEN },
      ],
      activeGame: () => flag,
      isCancelled: () => {
        // Flip AFTER the first position's search has been scheduled.
        if (c.reports.length > 0) flag = ACTIVE
        return false
      },
      onPosition: c.onPosition,
    })
    expect(result).toEqual({ completed: false, error: ENGINE_LOCKED_MESSAGE })
    expect(c.reports).toHaveLength(1)
  })

  it("cancels cleanly between positions", async () => {
    let cancelled = false
    const { engine } = fakeEngine([[info(1, "cp 10", "e2e4")], [info(1, "cp 10", "e2e4")]])
    const c = collector()
    const result = await runDeepAnalysis({
      engine,
      enginePath: "/fake/stockfish",
      targets: [
        { ply: 1, fen: START_FEN },
        { ply: 3, fen: START_FEN },
      ],
      activeGame: () => null,
      isCancelled: () => {
        if (c.reports.length > 0) cancelled = true
        return cancelled
      },
      onPosition: c.onPosition,
    })
    expect(result).toEqual({ completed: false, error: null })
    expect(c.reports).toHaveLength(1)
  })

  it("is a completed no-op on an empty target list", async () => {
    const { engine, commands } = fakeEngine([])
    const c = collector()
    const result = await runDeepAnalysis({
      engine,
      enginePath: "/fake/stockfish",
      targets: [],
      activeGame: () => null,
      isCancelled: () => false,
      onPosition: c.onPosition,
    })
    expect(result).toEqual({ completed: true, error: null })
    expect(commands).toHaveLength(0)
  })
})

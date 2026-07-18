// Full-game "Analyze Game" blunder check (spec 212's single-game entry
// point, spec 000:43-44): batch-evaluate every mainline position at a fixed
// per-move budget, store white-POV evals on the tree nodes, and label moves
// by eval swing (annotations.ts judgeMove → ?!/?/?? NAGs). This module is
// the engine-driving runner — sequenced UCI over its own engine session so
// the user's live analysis engine is never interrupted; React state lives in
// hooks/use-game-analysis.ts.
//
// Spec 219 lockout: the runner re-checks engineAllowedForGame before EVERY
// search (the flag can flip mid-run via snapshot restore), and every command
// carries the game-context tag so the Rust UCI manager refuses defensively.

import { Chess } from "chessops/chess"
import { parseFen } from "chessops/fen"
import { parseUciInfo, type UciScore } from "@chessgui/core/uci-parser"
import {
  ENGINE_LOCKED_MESSAGE,
  engineAllowedForGame,
  engineContextTag,
  type ActiveGameMeta,
} from "@chessgui/core/active-game"
import { judgeMove, type MoveJudgment } from "@chessgui/core/annotations"
import { INITIAL_FEN, type NodeEval } from "@chessgui/core/game-tree"

/** Engine slot for batch analysis — never the main ("default") or the spec
 *  900 "compare" session, so a run leaves live analysis untouched. */
export const GAME_ANALYSIS_SESSION = "game-analysis"

/** Fixed per-position budget. 500ms reaches depth ~18-22 on Apple Silicon —
 *  plenty to label 0.5/1.0/3.0-pawn swings — and keeps a 60-move game under
 *  a minute. */
export const ANALYZE_MOVETIME_MS = 500

// A search that never answers `bestmove` (dead engine, dropped event stream)
// must fail the run, not wedge it.
const BESTMOVE_TIMEOUT_MS = ANALYZE_MOVETIME_MS + 10_000

/** One mainline position to evaluate, root (ply 0) first. */
export interface AnalysisTarget {
  /** Tree node id the eval lands on. */
  id: string
  /** Position AFTER the node's move (root: the start position). */
  fen: string
  /** Engine UCI of the node's move ("" for the root). */
  uci: string
}

/** The slice of EngineProvider the runner drives (fake-able in tests). */
export interface GameAnalysisEngine {
  startEngine(path: string, context?: string, sessionId?: string): Promise<{ name: string; ready: boolean }>
  sendCommand(command: string, context?: string, sessionId?: string): Promise<void>
  stopEngine(sessionId?: string): Promise<void>
  onEngineLine(onLine: (line: string) => void, sessionId?: string): Promise<() => void>
}

export interface GameAnalysisCallbacks {
  /** White-POV eval for a finished position, in target order. */
  onEval(id: string, ev: NodeEval): void
  /** Judgment for a labeled move (the target's own id). */
  onJudgment(id: string, judgment: MoveJudgment): void
  /** After each position: positions finished so far / total. */
  onProgress(done: number, total: number): void
}

export interface GameAnalysisResult {
  /** True when every position was visited (skips included); false on cancel/error. */
  completed: boolean
  error: string | null
}

/** UCI score (side-to-move POV) → stored NodeEval (white POV). */
export function whitePovEval(score: UciScore, turn: "white" | "black", depth: number): NodeEval {
  const flip = turn === "white" ? 1 : -1
  return score.type === "mate"
    ? { mate: score.value * flip, depth }
    : { cp: score.value * flip, depth }
}

function turnOf(fen: string): "white" | "black" {
  return fen.split(" ")[1] === "b" ? "black" : "white"
}

// Checkmate/stalemate positions get no search (Stockfish answers `bestmove
// (none)` with no score); their eval stays absent and the final move goes
// unjudged — delivering mate is not a swing to label.
function isTerminal(fen: string): boolean {
  const setup = parseFen(fen)
  if (setup.isErr) return true // unanalyzable — treat as skip, not a crash
  const pos = Chess.fromSetup(setup.unwrap())
  return pos.isErr || pos.unwrap().isEnd()
}

/**
 * Evaluate every target position in order, reporting evals/judgments/progress
 * through the callbacks as they land (the eval graph and move list fill in
 * live). Runs on its own engine session; always stops it before returning.
 */
export async function runGameAnalysis(opts: {
  engine: GameAnalysisEngine
  enginePath: string
  targets: AnalysisTarget[]
  /** Re-read each step: the spec 219 flag can flip mid-run. */
  activeGame: () => ActiveGameMeta | null | undefined
  isCancelled: () => boolean
  callbacks: GameAnalysisCallbacks
  movetimeMs?: number
  threads?: number
  hash?: number
  /** Chess960 game (spec 011): assert UCI_Chess960 before any position/go —
   *  the mainline's castling moves are king-takes-rook UCI, which the
   *  engine only parses with the option set. Fresh session per run, so
   *  absent/false sends nothing (the engine default). */
  chess960?: boolean
}): Promise<GameAnalysisResult> {
  const { engine, targets, callbacks } = opts
  const movetime = opts.movetimeMs ?? ANALYZE_MOVETIME_MS

  if (!engineAllowedForGame(opts.activeGame())) {
    return { completed: false, error: ENGINE_LOCKED_MESSAGE }
  }
  if (targets.length === 0) return { completed: true, error: null }

  const context = engineContextTag(opts.activeGame())
  const send = (cmd: string) => engine.sendCommand(cmd, context, GAME_ANALYSIS_SESSION)

  // Last multipv-1 score seen for the position in flight, plus the bestmove
  // gate the loop awaits. A single listener serves the whole run.
  let last: { score: UciScore; depth: number } | null = null
  let resolveBest: (() => void) | null = null
  let unlisten: (() => void) | null = null

  const startFen = targets[0].fen
  const positionCmd = (index: number): string => {
    const base = startFen === INITIAL_FEN ? "position startpos" : `position fen ${startFen}`
    if (index === 0) return base
    const moves = targets.slice(1, index + 1).map((t) => t.uci)
    return `${base} moves ${moves.join(" ")}`
  }

  try {
    await engine.startEngine(opts.enginePath, context, GAME_ANALYSIS_SESSION)
    unlisten = await engine.onEngineLine((line) => {
      if (line.startsWith("bestmove")) {
        const r = resolveBest
        resolveBest = null
        r?.()
        return
      }
      const info = parseUciInfo(line)
      if (info && (info.multipv ?? 1) === 1) last = { score: info.score, depth: info.depth }
    }, GAME_ANALYSIS_SESSION)

    if (opts.threads) await send(`setoption name Threads value ${opts.threads}`)
    if (opts.hash) await send(`setoption name Hash value ${opts.hash}`)
    if (opts.chess960) await send("setoption name UCI_Chess960 value true")
    await send("setoption name MultiPV value 1")

    const evals: (NodeEval | null)[] = []
    for (let i = 0; i < targets.length; i++) {
      if (opts.isCancelled()) return { completed: false, error: null }
      if (!engineAllowedForGame(opts.activeGame())) {
        return { completed: false, error: ENGINE_LOCKED_MESSAGE }
      }

      const target = targets[i]
      let ev: NodeEval | null = null
      if (!isTerminal(target.fen)) {
        last = null
        const done = new Promise<void>((resolve) => {
          resolveBest = resolve
        })
        await send(positionCmd(i))
        await send(`go movetime ${movetime}`)
        const timedOut = await Promise.race([
          done.then(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), BESTMOVE_TIMEOUT_MS)),
        ])
        if (timedOut) {
          return { completed: false, error: "Engine stopped responding during analysis." }
        }
        // Cast: TS can't see the listener writing `last` across the await.
        const captured = last as { score: UciScore; depth: number } | null
        if (captured) {
          ev = whitePovEval(captured.score, turnOf(target.fen), captured.depth)
          callbacks.onEval(target.id, ev)
        }
      }
      evals.push(ev)

      // Judge the move that LED here (needs both sides of the swing). The
      // mover is whoever was to move in the previous position.
      const before = i > 0 ? evals[i - 1] : null
      if (ev && before) {
        const judgment = judgeMove(before, ev, turnOf(targets[i - 1].fen) === "white")
        if (judgment) callbacks.onJudgment(target.id, judgment)
      }
      callbacks.onProgress(i + 1, targets.length)
    }
    // A game swapped in during the final position's engine await would leave
    // the loop's top-of-iteration cancel check stale; re-check here so a run
    // that outlived its tree never reports completion (its evals landed on a
    // replaced tree). The hook re-checks tree identity too.
    if (opts.isCancelled()) return { completed: false, error: null }
    return { completed: true, error: null }
  } catch (e) {
    return { completed: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    unlisten?.()
    await engine.stopEngine(GAME_ANALYSIS_SESSION).catch(() => {})
  }
}

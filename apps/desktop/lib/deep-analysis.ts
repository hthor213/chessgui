// Deep multi-PV re-analysis of flagged tournament moments (spec 212 "Later"
// item: the neutral evaluator's quick pass is tier-1; this is the one-click
// "deep verify decisive moments" pass over a game's error list). Each target
// is one flagged position (the position BEFORE a labeled move), re-searched
// at a much larger budget with MultiPV so the report shows the best
// alternatives, not just one number. Same engine-driving shape as
// lib/game-analysis.ts: sequenced UCI over its own engine session, so the
// user's live analysis engine (and a game-analysis run) is never touched.
//
// Spec 219 lockout: re-checks engineAllowedForGame before EVERY search and
// tags every command with the game-context tag, exactly like game-analysis —
// tournament games are engine-lab games (never flagged chess.com dailies),
// but the gate is structural so no new engine entry point skips it.

import { parseUciInfo, uciMovesToSan, type UciScore } from "@chessgui/core/uci-parser"
import {
  ENGINE_LOCKED_MESSAGE,
  engineAllowedForGame,
  engineContextTag,
  type ActiveGameMeta,
} from "@chessgui/core/active-game"
import type { GameAnalysisEngine } from "@/lib/game-analysis"

/** Engine slot for the deep pass — never "default"/"compare"/"game-analysis". */
export const DEEP_ANALYSIS_SESSION = "deep-moments"

/** Per-position budget: 8× the quick evaluator pass's reach is the point. */
export const DEEP_MOVETIME_MS = 4_000

/** Alternatives shown per position. */
export const DEEP_MULTIPV = 3

/** One flagged position to re-search. */
export interface DeepTarget {
  /** 1-based half-move index of the flagged move (MoveSwing.ply). */
  ply: number
  /** The position the flagged move was played FROM. */
  fen: string
}

/** One PV of a deep-searched position, White-POV like every stored eval. */
export interface DeepLine {
  multipv: number
  cp: number | null
  mate: number | null
  depth: number
  /** The line as SAN (replay-reconstructed; truncates at anything illegal). */
  sans: string[]
}

export interface DeepPositionReport {
  ply: number
  fen: string
  /** Sorted by multipv; empty if the engine reported no parseable PV. */
  lines: DeepLine[]
  /**
   * Spec 213 Phase 4 "visible from ~R": lowest Maia band whose Eval_R
   * registers this mistake's swing. `null` = swept but not visible at any
   * band (refutation deeper than every 1100–1900 nucleus); absent = the
   * opt-in Eval_R pass didn't run (or skipped this position).
   */
  visibleFrom?: number | null
}

// ---------------------------------------------------------------------------
// Eval_R "visible from ~R" pass (spec 213 Phase 4) — strictly opt-in add-on
// to the deep pass: for the worst mistakes, ask the Rust `visible_from_sweep`
// command (human_search.rs) for the lowest Maia band whose restricted-tree
// Eval_R of the AFTER-mistake position registers the swing. The backend
// yields to live slider sweeps and shares the tier-1 session TT.
// ---------------------------------------------------------------------------

/** Maia-1 bands the visible-from scan sweeps, ascending. */
export const EVAL_R_BANDS = [1100, 1300, 1500, 1700, 1900]

/** Top band swept — "not visible" verdicts read "not visible ≤ this". */
export const EVAL_R_TOP_BAND = EVAL_R_BANDS[EVAL_R_BANDS.length - 1]

/** Hard cap on Eval_R scans per game: the 10 worst mistakes, nothing more. */
export const EVAL_R_MAX_SWEEPS = 10

/**
 * Bounded pawn-equivalent for mate scores fed to the visible-from swing test
 * (mirrors tier-0's mate clamping — a mate signal, not a blendable cp).
 */
export const VISIBLE_MATE_CP = 1000

/**
 * White-POV cp for the swing endpoints: mates collapse to ±VISIBLE_MATE_CP,
 * cp scores clamp to the same bound so "half the swing" stays meaningful.
 * Null when the evaluator produced no score for the ply.
 */
export function visibleFromCp(e: { cp: number | null; mate: number | null }): number | null {
  if (e.mate !== null) return e.mate > 0 ? VISIBLE_MATE_CP : -VISIBLE_MATE_CP
  if (e.cp === null) return null
  return Math.max(-VISIBLE_MATE_CP, Math.min(VISIBLE_MATE_CP, e.cp))
}

/** The `cap` worst mistakes by win-prob drop — the bounded scan's targets. */
export function worstMistakes<T extends { drop: number }>(
  labeled: T[],
  cap: number = EVAL_R_MAX_SWEEPS,
): T[] {
  return [...labeled].sort((a, b) => b.drop - a.drop).slice(0, Math.max(0, cap))
}

/**
 * Invoke args for `visible_from_sweep` (pure, vitest-pinned like the tier-1
 * wrappers in lib/human-eval-tree.ts). Knobs stay backend-defaulted.
 */
export function visibleFromInvokeArgs(
  fen: string,
  beforeCp: number,
  afterCp: number,
  bands: number[] = EVAL_R_BANDS,
): Record<string, unknown> {
  return { fen, beforeCp, afterCp, bands }
}

/** Rust `VisibleFromResult` (default serde field names). */
export interface VisibleFromSweep {
  visible_from: number | null
  cancelled: boolean
}

export interface DeepAnalysisResult {
  /** True when every target was searched; false on cancel/lockout/error. */
  completed: boolean
  error: string | null
}

function turnOf(fen: string): "white" | "black" {
  return fen.split(/\s+/)[1] === "b" ? "black" : "white"
}

/** Mover-POV UCI score → White-POV cp/mate pair. */
function whitePov(score: UciScore, turn: "white" | "black"): { cp: number | null; mate: number | null } {
  const flip = turn === "white" ? 1 : -1
  return score.type === "mate"
    ? { cp: null, mate: score.value * flip }
    : { cp: score.value * flip, mate: null }
}

// A search that never answers `bestmove` must fail the run, not wedge it.
const BESTMOVE_TIMEOUT_MS = DEEP_MOVETIME_MS + 10_000

/**
 * Deep-search every target position in order, reporting each position's
 * multi-PV lines through `onPosition` as they land. Runs on its own engine
 * session; always stops it before returning.
 */
export async function runDeepAnalysis(opts: {
  engine: GameAnalysisEngine
  enginePath: string
  targets: DeepTarget[]
  /** Re-read each step: the spec 219 flag can flip mid-run. */
  activeGame: () => ActiveGameMeta | null | undefined
  isCancelled: () => boolean
  onPosition: (report: DeepPositionReport) => void
  onProgress?: (done: number, total: number) => void
  movetimeMs?: number
  multiPv?: number
  threads?: number
  hash?: number
}): Promise<DeepAnalysisResult> {
  const { engine, targets } = opts
  const movetime = opts.movetimeMs ?? DEEP_MOVETIME_MS
  const multiPv = Math.max(1, opts.multiPv ?? DEEP_MULTIPV)

  if (!engineAllowedForGame(opts.activeGame())) {
    return { completed: false, error: ENGINE_LOCKED_MESSAGE }
  }
  if (targets.length === 0) return { completed: true, error: null }

  const context = engineContextTag(opts.activeGame())
  const send = (cmd: string) => engine.sendCommand(cmd, context, DEEP_ANALYSIS_SESSION)

  // Latest info line per multipv index for the position in flight, plus the
  // bestmove gate the loop awaits. One listener serves the whole run.
  let byPv = new Map<number, { score: UciScore; depth: number; pv: string[] }>()
  let resolveBest: (() => void) | null = null
  let unlisten: (() => void) | null = null

  try {
    await engine.startEngine(opts.enginePath, context, DEEP_ANALYSIS_SESSION)
    unlisten = await engine.onEngineLine((line) => {
      if (line.startsWith("bestmove")) {
        const r = resolveBest
        resolveBest = null
        r?.()
        return
      }
      const info = parseUciInfo(line)
      if (info) byPv.set(info.multipv, { score: info.score, depth: info.depth, pv: info.pv })
    }, DEEP_ANALYSIS_SESSION)

    if (opts.threads) await send(`setoption name Threads value ${opts.threads}`)
    if (opts.hash) await send(`setoption name Hash value ${opts.hash}`)
    await send(`setoption name MultiPV value ${multiPv}`)

    for (let i = 0; i < targets.length; i++) {
      if (opts.isCancelled()) return { completed: false, error: null }
      if (!engineAllowedForGame(opts.activeGame())) {
        return { completed: false, error: ENGINE_LOCKED_MESSAGE }
      }

      const target = targets[i]
      byPv = new Map()
      const done = new Promise<void>((resolve) => {
        resolveBest = resolve
      })
      await send(`position fen ${target.fen}`)
      await send(`go movetime ${movetime}`)
      const timedOut = await Promise.race([
        done.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), BESTMOVE_TIMEOUT_MS)),
      ])
      if (timedOut) {
        return { completed: false, error: "Engine stopped responding during deep analysis." }
      }

      const turn = turnOf(target.fen)
      const lines: DeepLine[] = [...byPv.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([pvIndex, l]) => ({
          multipv: pvIndex,
          ...whitePov(l.score, turn),
          depth: l.depth,
          sans: uciMovesToSan(target.fen, l.pv),
        }))
      opts.onPosition({ ply: target.ply, fen: target.fen, lines })
      opts.onProgress?.(i + 1, targets.length)
    }
    return { completed: true, error: null }
  } catch (e) {
    return { completed: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    unlisten?.()
    await engine.stopEngine(DEEP_ANALYSIS_SESSION).catch(() => {})
  }
}

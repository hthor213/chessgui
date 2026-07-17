// Per-game performance estimate (spec 202 "Per-game performance Elo").
//
// Honesty gate (213/224 house rule): a single game is a thin sample, so the
// number is deliberately coarse and its label always says so. The spec's first
// choice is band likelihood under the corpus error model
// (data/personas/error_model.fit.json). That fit is a dev-checkout artifact —
// it is NOT bundled with the app — so this module implements the honest
// fallback as the PRIMARY path: average centipawn loss (ACPL) plus mistake /
// blunder counts, mapped to an approximate rating band. Everything here is
// pure and unit-tested; the fit-based path can be layered on later without
// changing this contract.

import { judgeMove, hasJudgmentNag } from "@chessgui/core/annotations"
import type { MoveNode, NodeEval } from "@chessgui/core/game-tree"
import { nodeEval } from "@chessgui/core/annotations"

/** A side needs at least this many evaluated moves before we'll estimate. */
const MIN_SCORED_MOVES = 4

// Centipawn loss per move is clamped to this cap (mate scores map to the cap)
// so a single thrown mate doesn't swamp the ACPL average — the mistake/blunder
// counts already carry the "this game had a catastrophe" signal.
const CAP_CP = 1000

// Approximate ACPL -> rating band. Thresholds are rough and intentionally so
// (documented as approximate in every label). Midpoints are representative
// club/expert ratings, not a calibrated scale.
//   ACPL < 20   -> ~2200+   (near-flawless)
//   20 - 35     -> ~1900
//   35 - 60     -> ~1600
//   60 - 90     -> ~1300
//   > 90        -> ~1100
const BANDS: { maxAcpl: number; band: number; bandLabel: string }[] = [
  { maxAcpl: 20, band: 2200, bandLabel: "2200+" },
  { maxAcpl: 35, band: 1900, bandLabel: "1900" },
  { maxAcpl: 60, band: 1600, bandLabel: "1600" },
  { maxAcpl: 90, band: 1300, bandLabel: "1300" },
  { maxAcpl: Infinity, band: 1100, bandLabel: "1100" },
]

export interface SidePerformance {
  /** Representative Elo midpoint of the band (approximate). */
  band: number
  /** Human label — ALWAYS caveated, e.g. "~1600 performance — single game, rough". */
  label: string
  /** Average centipawn loss over the side's evaluated moves. */
  acpl: number
  mistakes: number
  blunders: number
  /** How many of the side's moves had evals on both sides of the move. */
  scored: number
}

export interface PerformanceElo {
  white: SidePerformance | null
  black: SidePerformance | null
}

/** NodeEval -> white-perspective centipawns, mate clamped to the cap. */
function cpWhitePov(ev: NodeEval): number {
  if (ev.mate !== undefined) return ev.mate > 0 ? CAP_CP : -CAP_CP
  return Math.max(-CAP_CP, Math.min(CAP_CP, ev.cp ?? 0))
}

function bandFor(acpl: number): { band: number; bandLabel: string } {
  const hit = BANDS.find((b) => acpl < b.maxAcpl) ?? BANDS[BANDS.length - 1]
  return { band: hit.band, bandLabel: hit.bandLabel }
}

interface SideAccumulator {
  loss: number
  scored: number
  mistakes: number
  blunders: number
}

function finish(acc: SideAccumulator): SidePerformance | null {
  if (acc.scored < MIN_SCORED_MOVES) return null
  const acpl = acc.loss / acc.scored
  const { band, bandLabel } = bandFor(acpl)
  return {
    band,
    label: `~${bandLabel} performance — single game, rough`,
    acpl: Math.round(acpl),
    mistakes: acc.mistakes,
    blunders: acc.blunders,
    scored: acc.scored,
  }
}

/**
 * Estimate each player's performance for THIS game from the mainline.
 * `mainline` is the mainline node array INCLUDING the root at index 0 (exactly
 * what `GameTree.mainlineNodes()` returns). Only moves whose position AND the
 * position before them both carry an eval are scored; a side with fewer than
 * MIN_SCORED_MOVES scored moves comes back null (not enough signal to judge).
 */
export function estimatePerformance(mainline: MoveNode[]): PerformanceElo {
  const white: SideAccumulator = { loss: 0, scored: 0, mistakes: 0, blunders: 0 }
  const black: SideAccumulator = { loss: 0, scored: 0, mistakes: 0, blunders: 0 }

  for (let i = 1; i < mainline.length; i++) {
    const node = mainline[i]
    const before = nodeEval(mainline[i - 1])
    const after = nodeEval(node)
    if (!before || !after) continue

    const moverIsWhite = node.ply % 2 === 1
    const acc = moverIsWhite ? white : black

    const swing = cpWhitePov(after) - cpWhitePov(before)
    const drop = moverIsWhite ? -swing : swing // positive = the mover lost ground
    acc.loss += Math.max(0, drop)
    acc.scored += 1

    // Prefer the engine's stored judgment NAG (written by Analyze Game); fall
    // back to classifying the eval swing directly for imported [%eval] games.
    if (hasJudgmentNag(node.nags)) {
      if (node.nags.includes(4)) acc.blunders += 1
      else if (node.nags.includes(2)) acc.mistakes += 1
    } else {
      const j = judgeMove(before, after, moverIsWhite)
      if (j === "blunder") acc.blunders += 1
      else if (j === "mistake") acc.mistakes += 1
    }
  }

  return { white: finish(white), black: finish(black) }
}

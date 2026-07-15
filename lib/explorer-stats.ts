// Opening-explorer aggregation (spec 200): group position hits by the next
// move, with W/D/L, average Elo, and a per-move performance rating for the
// side to move. Pure — shared by the Database tab's local explorer and unit
// tests; the Lichess online fallback maps into the same MoveGroup shape.

import type { PositionHit } from "@/lib/database"

export type MoveGroup = {
  san: string
  uci: string | null
  total: number
  whiteWins: number
  draws: number
  blackWins: number
  /** Mean rating of all players (both colours) across the group's games. */
  avgElo: number | null
  /**
   * Performance rating of the side to move for this move: mean opponent
   * rating + the Elo difference implied by the achieved score. Null when no
   * opponent ratings are known.
   */
  performance: number | null
}

export type ExplorerSort = "count" | "performance"

/**
 * Elo difference implied by an achieved score fraction (FIDE logistic form,
 * dp = -400·log10(1/p − 1)), clamped to ±800 so 100%/0% scores stay finite —
 * the convention rating calculators use for perfect scores.
 */
export function eloDifferenceForScore(p: number): number {
  if (p >= 1) return 800
  if (p <= 0) return -800
  const dp = -400 * Math.log10(1 / p - 1)
  return Math.max(-800, Math.min(800, dp))
}

/** Side to move in a FEN ("white" when the field is missing/garbled). */
export function moverFromFen(fen: string): "white" | "black" {
  return fen.split(" ")[1] === "b" ? "black" : "white"
}

/**
 * Group hits by next move. `mover` is the side to move in the searched
 * position — it decides whose score and whose opponents feed the
 * performance rating.
 */
export function aggregateHits(hits: PositionHit[], mover: "white" | "black"): MoveGroup[] {
  type Acc = MoveGroup & { eloSum: number; eloN: number; oppSum: number; oppN: number }
  const groups = new Map<string, Acc>()
  for (const h of hits) {
    const key = h.next_san ?? "(end of game)"
    let g = groups.get(key)
    if (!g) {
      g = {
        san: key,
        uci: h.next_uci,
        total: 0,
        whiteWins: 0,
        draws: 0,
        blackWins: 0,
        avgElo: null,
        performance: null,
        eloSum: 0,
        eloN: 0,
        oppSum: 0,
        oppN: 0,
      }
      groups.set(key, g)
    }
    g.total += 1
    if (h.result === "1-0") g.whiteWins += 1
    else if (h.result === "1/2-1/2") g.draws += 1
    else if (h.result === "0-1") g.blackWins += 1
    for (const e of [h.white_elo, h.black_elo]) {
      if (e != null) {
        g.eloSum += e
        g.eloN += 1
      }
    }
    const opp = mover === "white" ? h.black_elo : h.white_elo
    if (opp != null) {
      g.oppSum += opp
      g.oppN += 1
    }
  }

  return [...groups.values()].map((g) => {
    const { eloSum, eloN, oppSum, oppN, ...rest } = g
    const avgElo = eloN > 0 ? eloSum / eloN : null
    let performance: number | null = null
    // Decided games only would skew draws; score counts all games in the group.
    if (oppN > 0 && g.total > 0) {
      const wins = mover === "white" ? g.whiteWins : g.blackWins
      const p = (wins + g.draws / 2) / g.total
      performance = Math.round(oppSum / oppN + eloDifferenceForScore(p))
    }
    return { ...rest, avgElo, performance }
  })
}

/** Sort move groups by frequency or by the mover's performance rating. */
export function sortGroups(groups: MoveGroup[], by: ExplorerSort): MoveGroup[] {
  const sorted = [...groups]
  if (by === "performance") {
    // Unknown performance sinks to the bottom; count breaks ties.
    sorted.sort(
      (a, b) =>
        (b.performance ?? -Infinity) - (a.performance ?? -Infinity) || b.total - a.total,
    )
  } else {
    sorted.sort((a, b) => b.total - a.total)
  }
  return sorted
}

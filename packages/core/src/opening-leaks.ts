// Opening-leak aggregation (spec 211) — the GUI port of
// scripts/mining/leak_report.py's aggregate()/finish_rows(), reduced to what
// the game database stores. The CLI keys its report on (ECO × the user's
// colour) and RANKS by eval bled per game, sourced from [%eval] tags or a
// budgeted engine pass; the database keeps no per-move evals and a UI-
// triggered path gets no engine budget, so this port keeps the same key and
// per-opening shape but ranks by results instead (worst score first, most
// games first among ties — repetition is the "repeated losing line" signal).
// Any UI showing these rows must say the ranking is result-based, not
// eval-based.

import type { PlayerGameRow } from "./database-types"

/** One (ECO × colour) row of the player's opening-leak report. */
export type OpeningLeakRow = {
  eco: string
  /** The colour the player held in this group's games. */
  color: "white" | "black"
  games: number
  wins: number
  draws: number
  losses: number
  /** Score percentage from the player's perspective, 0..100, one decimal. */
  scorePct: number
}

/** Player's score for a finished result, by the colour they held. */
const RESULT_SCORE: Record<string, { white: number; black: number }> = {
  "1-0": { white: 1, black: 0 },
  "0-1": { white: 0, black: 1 },
  "1/2-1/2": { white: 0.5, black: 0.5 },
}

/**
 * Group a player's games by (ECO × colour) and rank worst-scoring first.
 * Unfinished/unknown results are skipped (the backend already filters them —
 * this mirrors leak_report.py, which never counts a live game). Groups with
 * fewer than `minGames` games are dropped, like the CLI's --min-games
 * threshold (default 3) keeps one-off losses out of the ranked table.
 */
export function aggregateOpeningLeaks(rows: PlayerGameRow[], minGames = 3): OpeningLeakRow[] {
  type Acc = OpeningLeakRow & { scoreSum: number }
  const groups = new Map<string, Acc>()
  for (const r of rows) {
    const score = RESULT_SCORE[r.result]
    if (!score) continue
    const eco = r.eco.trim() || "?"
    const key = `${eco}|${r.color}`
    let g = groups.get(key)
    if (!g) {
      g = { eco, color: r.color, games: 0, wins: 0, draws: 0, losses: 0, scorePct: 0, scoreSum: 0 }
      groups.set(key, g)
    }
    const s = score[r.color]
    g.games += 1
    g.scoreSum += s
    if (s === 1) g.wins += 1
    else if (s === 0.5) g.draws += 1
    else g.losses += 1
  }
  return [...groups.values()]
    .filter((g) => g.games >= minGames)
    .map(({ scoreSum, ...g }) => ({
      ...g,
      scorePct: Math.round((1000 * scoreSum) / g.games) / 10,
    }))
    .sort(
      (a, b) => a.scorePct - b.scorePct || b.games - a.games || a.eco.localeCompare(b.eco),
    )
}

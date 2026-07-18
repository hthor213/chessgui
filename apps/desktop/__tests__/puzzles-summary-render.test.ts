// Spec 224 — the rolling avoidance-Elo line on the deck-done report.
// Static-render tests per the tablebase-render precedent: PuzzlesSummary is
// presentational, so the report path (score + Elo line, including the honest
// "need N more" fallback) renders here without a browser. The line body is
// produced by the real core estimator so the formatting contract is the one
// the app ships.

import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PuzzlesSummary } from "@chessgui/ui/puzzles-summary"
import {
  eloEstimateLine,
  estimateElo,
  MIN_WINDOW,
  type EloAttempt,
} from "@chessgui/core/elo-estimate"

function render(eloLine: string | null, over: Partial<Parameters<typeof PuzzlesSummary>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(PuzzlesSummary, {
      correct: 7,
      total: 10,
      rakes: 3,
      unverified: 0,
      eloLine,
      onAgain: () => {},
      onDone: () => {},
      ...over,
    }),
  )
}

function attempts(n: number, band: string, correct: boolean): EloAttempt[] {
  return Array.from({ length: n }, (_, i) => ({
    at: new Date(Date.UTC(2026, 6, 1, 0, i)).toISOString(),
    band,
    correct,
  }))
}

describe("PuzzlesSummary — deck-done report (spec 224 Elo line)", () => {
  it("shows the score and the rolling Elo estimate", () => {
    const line = eloEstimateLine(
      estimateElo([...attempts(20, "1900", true), ...attempts(10, "1900", false)]),
    )
    expect(line).toMatch(/^Elo \d+ ± \d+$/)
    const html = render(line)
    expect(html).toContain("7/10")
    expect(html).toContain('data-testid="puzzles-summary-elo"')
    expect(html).toContain("Rolling avoidance Elo:")
    expect(html).toContain(line) // full line body present
  })

  it("shows the honest need-more line instead of hiding on thin data", () => {
    const line = eloEstimateLine(estimateElo([]))
    expect(line).toBe(`Elo —, need ${MIN_WINDOW} more puzzles`)
    const html = render(line)
    expect(html).toContain('data-testid="puzzles-summary-elo"')
    expect(html).toContain(`need ${MIN_WINDOW} more puzzles`)
  })

  it("renders no Elo row only before the client effect has read the store", () => {
    const html = render(null)
    expect(html).not.toContain("puzzles-summary-elo")
    expect(html).toContain('data-testid="puzzles-summary"') // report itself still renders
  })
})

"use client"

// Deck-done report for an avoidance session (spec 211) — the screen the user
// reads when the deck is finished. Presentational (tablebase-section
// precedent) so the report path is static-render testable: score, rake
// recap, and the rolling avoidance-Elo line (spec 224) updated with this
// session's answers.

import { Button } from "@chessgui/ui/ui/button"

export function PuzzlesSummary({
  correct,
  total,
  rakes,
  unverified,
  eloLine,
  onAgain,
  onDone,
}: {
  correct: number
  total: number
  rakes: number
  unverified: number
  /** Spec 224 rolling-Elo line body ("Elo 1238 ± 250" / "Elo —, need N more
   *  puzzles") — always a line, never hidden for thin data; null only until
   *  the client effect has read the store (prerender stays empty). */
  eloLine: string | null
  onAgain: () => void
  onDone: () => void
}) {
  return (
    <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6" data-testid="puzzles-summary">
      <div className="max-w-md w-full space-y-4 text-center">
        <h1 className="text-2xl font-bold">Deck done</h1>
        <p className="text-4xl font-bold tabular-nums" data-testid="puzzles-summary-score">
          {correct}/{total}
        </p>
        <p className="text-sm text-muted-foreground">
          {rakes === 0
            ? "No rakes stepped on."
            : `${rakes} rake${rakes === 1 ? "" : "s"} stepped on — each one was replayed, and each comes back for review (1d, then 3d, then 7d).`}
          {unverified > 0 &&
            ` ${unverified} answer${unverified === 1 ? "" : "s"} unverified (no engine here).`}
        </p>
        {eloLine && (
          <p className="text-sm tabular-nums" data-testid="puzzles-summary-elo">
            <span className="text-muted-foreground">Rolling avoidance Elo: </span>
            <span className="font-semibold">{eloLine}</span>
          </p>
        )}
        <div className="flex gap-2 justify-center">
          <Button onClick={onAgain} data-testid="puzzles-again">
            Another deck
          </Button>
          <Button variant="outline" onClick={onDone} data-testid="puzzles-exit">
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}

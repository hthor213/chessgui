"use client"

// "Analyze game" control (spec 212 single-game blunder check): start button,
// live progress while the batch runs, cancel, and the error line. Purely
// presentational — the engine driving lives in the desktop shell's
// use-game-analysis hook; page.tsx hides this entirely while the spec 219
// active-game lockout holds (engine analysis is off-limits there).

import { Card } from "@chessgui/ui/ui/card"
import { Button } from "@chessgui/ui/ui/button"

export interface GameAnalysisControlState {
  running: boolean
  done: number
  total: number
  error: string | null
}

export function GameAnalysisControl({
  state,
  onStart,
  onCancel,
  disabled,
}: {
  state: GameAnalysisControlState
  onStart: () => void
  onCancel: () => void
  /** True when there is no game on the board to analyze. */
  disabled?: boolean
}) {
  const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0
  return (
    <Card className="bg-[#1e1c19] border-[#2a2825] p-3 shrink-0 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[#bababa]">Game analysis</span>
        {state.running ? (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs border-red-800 text-red-400 hover:bg-red-950"
            onClick={onCancel}
            data-testid="analyze-game-cancel"
          >
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-6 px-2 text-xs bg-green-600 hover:bg-green-700 text-white"
            onClick={onStart}
            disabled={disabled}
            title="Evaluate every mainline move and mark inaccuracies (?!), mistakes (?) and blunders (??)"
            data-testid="analyze-game-button"
          >
            Analyze game
          </Button>
        )}
      </div>
      {state.running && (
        <div className="flex items-center gap-2" data-testid="analyze-game-progress">
          <div className="flex-1 h-1.5 rounded-full bg-[#2a2825] overflow-hidden">
            <div
              className="h-full bg-green-600 transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">
            {state.done}/{state.total}
          </span>
        </div>
      )}
      {!state.running && state.error && (
        <span className="text-xs text-red-400 break-words" data-testid="analyze-game-error">
          {state.error}
        </span>
      )}
    </Card>
  )
}

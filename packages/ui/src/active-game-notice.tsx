"use client"

// Fair-play notice for the spec 219 engine lockout: shown IN PLACE of every
// engine-derived surface (analysis panel, eval bar, eval graph, hints) while
// the open game is an active chess.com daily game. The lockout itself is
// enforced at the engine-invocation layer (use-engine + Rust UCI manager) —
// this card is the honest-UX half, plus the "Continue later" exit.

import { Card } from "@chessgui/ui/ui/card"
import { Button } from "@chessgui/ui/ui/button"
import type { ActiveGameMeta } from "@chessgui/core/active-game"

export function ActiveGameNotice({
  meta,
  onContinueLater,
  onShowList,
}: {
  meta: ActiveGameMeta | null
  /** Saves the game (tree + metadata) to the active-games list and clears
   *  the board (spec 219 C). */
  onContinueLater?: () => void
  /** Jump to the active-games list ("Game finished" lives there). */
  onShowList?: () => void
}) {
  return (
    <Card
      data-testid="active-game-notice"
      className="border-amber-700/50 bg-amber-950/30 p-4"
    >
      <p className="text-sm font-semibold text-amber-200">
        Fair-play game — engine off
      </p>
      {meta && (meta.opponent || meta.chesscomUsername) && (
        <p className="text-xs text-amber-200/70 mt-1">
          {[
            meta.opponent ? `vs ${meta.opponent}` : null,
            meta.chesscomUsername ? `as ${meta.chesscomUsername}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      <p className="text-xs text-amber-200/80 mt-2 leading-relaxed">
        Explore lines by hand, like on a real board. Analysis unlocks once you
        mark the game finished in the fair-play games list.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {onContinueLater && (
          <Button
            size="sm"
            variant="outline"
            className="w-full border-amber-700/60 text-amber-200 hover:bg-amber-900/40"
            onClick={onContinueLater}
            data-testid="active-game-continue-later"
          >
            Continue later
          </Button>
        )}
        {onShowList && (
          <Button
            size="sm"
            variant="ghost"
            className="w-full text-muted-foreground hover:text-foreground"
            onClick={onShowList}
            data-testid="active-game-show-list"
          >
            Fair-play games…
          </Button>
        )}
      </div>
    </Card>
  )
}

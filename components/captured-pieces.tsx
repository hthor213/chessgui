"use client"

import { PIECE_POINTS, type CapturedCounts, type CapturedRole } from "@/lib/material"

// Solid glyphs render legibly at small sizes on the dark theme; the outlined
// (white) variants read as hairlines. Which side's pieces they are is implied
// by whose row they sit in.
const ROLE_GLYPHS: Record<CapturedRole, string> = {
  pawn: "♟",
  knight: "♞",
  bishop: "♝",
  rook: "♜",
  queen: "♛",
}

// Cheapest first, matching the usual captured-tray convention.
const ROLE_ORDER = Object.keys(PIECE_POINTS) as CapturedRole[]

/**
 * One player's captured-piece tray: the enemy pieces they have taken off the
 * board, grouped by type (e.g. ♟♟♟ ♞ ♝), plus a +x point badge when this
 * player is ahead on material. Renders as an empty spacer row when nothing
 * has been captured, so the left column's layout never jumps.
 */
export function CapturedPieces({
  captured,
  points,
  testId,
}: {
  captured: CapturedCounts
  /** Net point advantage for THIS player; 0 or negative hides the badge. */
  points: number
  testId?: string
}) {
  const groups = ROLE_ORDER.filter((role) => (captured[role] ?? 0) > 0)
  return (
    <div
      data-testid={testId}
      className="flex items-center gap-2 min-h-[1.5rem] px-1 leading-none select-none"
    >
      {groups.map((role) => (
        <span
          key={role}
          data-role={role}
          data-count={captured[role]}
          className="text-lg text-muted-foreground tracking-tight"
        >
          {ROLE_GLYPHS[role].repeat(captured[role]!)}
        </span>
      ))}
      {points > 0 && (
        <span
          data-testid={testId ? `${testId}-points` : undefined}
          className="ml-auto px-1.5 py-0.5 rounded bg-white/10 text-xs font-semibold text-foreground tabular-nums"
        >
          +{points}
        </span>
      )}
    </div>
  )
}

"use client"

// Tablebase verdict row for the analysis panel (spec 900 backlog: tablebase
// surfacing). Renders nothing until a probe lands — out-of-range positions
// (>7 men), offline shells, and the spec 219 active-game lockout all reach
// this component as `probe: null` (the gating lives in use-tablebase.ts and
// the Rust command; this is display only).

import { Badge } from "@chessgui/ui/ui/badge"
import { tbVerdictLabel, type TbProbe } from "@chessgui/core/tablebase"

export function TablebaseSection({
  probe,
  turn,
}: {
  probe: TbProbe | null
  /** Side to move in the probed position — the category is stm-relative. */
  turn: "white" | "black"
}) {
  if (!probe) return null

  const decisive = probe.category === "win" || probe.category === "loss"
  // Same white-perspective coloring as the eval ScoreBadge above it.
  const whiteWins = decisive && (probe.category === "win") === (turn === "white")
  const colorClasses = !decisive
    ? "bg-gray-700 text-gray-100"
    : whiteWins
      ? "bg-green-700 text-green-100"
      : "bg-red-700 text-red-100"

  // The Lichess probe is one ply deep — a ranked move list, not a PV — so
  // "best line" surfaces as the single best move (list is sorted best first).
  const best = probe.moves[0]

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 mt-1.5 pt-1.5 border-t border-white/10"
      data-testid="tablebase-section"
    >
      <Badge variant="secondary" className={`font-mono font-bold ${colorClasses}`}>
        TB {tbVerdictLabel(probe.category, turn)}
      </Badge>
      {probe.dtz != null && (
        <span className="text-xs text-muted-foreground font-mono" title="Distance to zeroing (50-move counter reset)">
          DTZ {Math.abs(probe.dtz)}
        </span>
      )}
      {probe.dtm != null && (
        <span className="text-xs text-muted-foreground font-mono" title="Distance to mate">
          DTM {Math.abs(probe.dtm)}
        </span>
      )}
      {best && (
        <span className="text-xs font-mono text-muted-foreground" data-testid="tablebase-best">
          best <span className="text-foreground">{best.san}</span>
        </span>
      )}
    </div>
  )
}

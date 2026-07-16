"use client"

// Second-engine comparison panel (spec 900 backlog "Multi-engine comparison"):
// a second UCI engine analyzing the SAME position as the main analysis panel,
// side by side — its own eval + PV lines, nothing more (no cross-highlighting,
// no play mode). Deliberately mounted ONLY where a second engine can exist:
// the page gates on lib/capabilities.ts `hasEngineCompare()` (desktop native
// host), and this component owning its useEngine call keeps the extra hook
// instance out of the web shell's tree entirely.
//
// The engine runs in its own session slot (COMPARE_ENGINE_SESSION —
// core/engine-session.ts / uci.rs), so start/stop/output never touch the main
// engine, and its binary pick persists under its own engine-path key. It
// receives the same activeGame context as the primary hook, so the spec 219
// fair-play lockout gates both sessions identically.

import { useEffect, useState } from "react"
import { Card } from "@chessgui/ui/ui/card"
import { Button } from "@chessgui/ui/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@chessgui/ui/ui/tooltip"
import { PvLineRow, formatNodes } from "@chessgui/ui/analysis-panel"
import { COMPARE_ENGINE_SESSION } from "@chessgui/core/engine-session"
import type { ActiveGameMeta } from "@chessgui/core/active-game"
import { useEngine } from "@/hooks/use-engine"
import { defaultEnginePath } from "@/lib/engine-settings"
import { loadCustomEngines } from "@/lib/tournament-roster"

interface EngineComparePanelProps {
  fen: string
  uciMoves: string[]
  startFen: string
  currentMoveIndex: number
  /** Spec 219: MUST be the same active-game context the primary engine hook
   *  gets, so both sessions fall under the same fair-play lockout. */
  activeGame: ActiveGameMeta | null | undefined
}

/** A pickable second-engine binary: the shell default plus every registered
 *  custom engine (spec 210 Phase 6 "Add-engine UI"). */
type EngineChoice = { label: string; path: string }

export function EngineComparePanel({
  fen,
  uciMoves,
  startFen,
  currentMoveIndex,
  activeGame,
}: EngineComparePanelProps) {
  // No onBestMove and atLatestMove pinned true: this session is analysis-only
  // (the panel exposes no play-mode controls, so the hook never issues a
  // move search).
  const engine = useEngine(
    fen,
    undefined,
    true,
    uciMoves,
    startFen,
    currentMoveIndex,
    activeGame,
    COMPARE_ENGINE_SESSION,
  )
  const { state } = engine

  // Hydrated after mount (storage-backed), same pattern as engine settings.
  const [choices, setChoices] = useState<EngineChoice[]>([])
  useEffect(() => {
    const list: EngineChoice[] = [{ label: "Stockfish (default)", path: defaultEnginePath() }]
    for (const e of loadCustomEngines()) {
      if (!list.some((c) => c.path === e.path)) list.push({ label: e.name, path: e.path })
    }
    setChoices(list)
  }, [])

  const [startError, setStartError] = useState<string | null>(null)
  const tryStart = () => {
    setStartError(null)
    engine.startEngine().catch((err) => {
      setStartError(err instanceof Error ? err.message : String(err))
    })
  }

  // The persisted pick may point at a custom engine that has since been
  // unregistered — keep it selectable rather than lying about what runs.
  const knownPath = choices.some((c) => c.path === engine.enginePath)
  const picker = (
    <select
      data-testid="compare-engine-select"
      className="bg-background border border-input rounded-md px-2 py-1 text-xs text-foreground flex-1 min-w-0"
      value={engine.enginePath}
      onChange={(e) => void engine.updateEnginePath(e.target.value)}
    >
      {!knownPath && engine.enginePath && (
        <option value={engine.enginePath}>{engine.enginePath}</option>
      )}
      {choices.map((c) => (
        <option key={c.path} value={c.path}>
          {c.label}
        </option>
      ))}
    </select>
  )

  if (!state.isRunning) {
    return (
      <Card className="bg-[#1e1c19] border-[#2a2825] p-3" data-testid="engine-compare-panel">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-xs font-semibold text-[#bababa]">Second engine</span>
        </div>
        <div className="flex items-center gap-2">
          {picker}
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 border-green-700 text-green-400 hover:bg-green-950"
            onClick={tryStart}
            data-testid="compare-engine-start"
          >
            Compare
          </Button>
        </div>
        {startError && (
          <span className="mt-2 block text-xs text-red-400 break-words" data-testid="compare-engine-error">
            {startError}
          </span>
        )}
      </Card>
    )
  }

  const scoreTurn = state.scoreTurn

  return (
    <Card className="bg-[#1e1c19] border-[#2a2825] p-3" data-testid="engine-compare-panel">
      <div className="flex items-center justify-between gap-1 mb-1.5">
        <div className="flex items-baseline gap-1.5 min-w-0 overflow-hidden whitespace-nowrap">
          <span className="text-xs font-semibold text-[#bababa]">{state.engineName}</span>
          {state.isAnalyzing && state.depth > 0 && (
            <span className="text-xs text-muted-foreground">depth {state.depth}</span>
          )}
          {state.isAnalyzing && state.nps > 0 && (
            <span className="text-xs text-muted-foreground">{formatNodes(state.nps)}/s</span>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-red-400 hover:text-red-300"
              onClick={() => engine.stopEngine()}
              data-testid="compare-engine-stop"
            >
              <span className="text-xs">{"\\u2715"}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Disconnect second engine</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex items-center gap-2 mb-2">{picker}</div>
      <div className="flex flex-col gap-1">
        {state.lines.map((line) => (
          <PvLineRow key={line.multipv} line={line} turn={scoreTurn} />
        ))}
        {state.lines.length === 0 && state.isAnalyzing && (
          <span className="text-xs text-muted-foreground">Calculating...</span>
        )}
      </div>
    </Card>
  )
}

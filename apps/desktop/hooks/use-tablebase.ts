import { useEffect, useState } from "react"
import { getProviders } from "@/lib/platform"
import { engineContextTag, type ActiveGameMeta } from "@chessgui/core/active-game"
import {
  tablebaseAllowedForGame,
  tablebaseEligible,
  type TbProbe,
} from "@chessgui/core/tablebase"

/**
 * Lichess tablebase verdict for the current position (spec 900 backlog:
 * tablebase surfacing). Probes only when the position is in tablebase range
 * (<=7 men); resolves to null otherwise, offline, or on a shell whose
 * provider has no backing lookup. The desktop provider rides the match
 * runner's FEN-keyed cache, so revisiting a position costs no network.
 *
 * Spec 219: a tablebase verdict IS engine-class assistance — a perfect
 * evaluation plus the best move — so for a flagged active chess.com daily
 * game it is structurally OFF, exactly like the engine. This gate is layer
 * 1; the Rust command (match_runner.rs tablebase_probe) refuses
 * active-game-tagged contexts defensively as layer 2.
 */
export function useTablebase(
  fen: string,
  activeGame: ActiveGameMeta | null | undefined,
): TbProbe | null {
  const [probe, setProbe] = useState<TbProbe | null>(null)

  useEffect(() => {
    setProbe(null) // never show a stale verdict while the lookup is in flight
    if (!tablebaseAllowedForGame(activeGame)) return
    if (!tablebaseEligible(fen)) return

    let cancelled = false
    getProviders()
      .engine.tablebaseProbe(fen, engineContextTag(activeGame))
      .then((p) => {
        if (!cancelled) setProbe(p)
      })
      .catch(() => {
        // Best-effort: offline / refused / parse trouble just means no badge.
        if (!cancelled) setProbe(null)
      })
    return () => {
      cancelled = true
    }
  }, [fen, activeGame])

  return probe
}

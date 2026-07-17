"use client"

// Playout-result recorder hook (spec 211 "Play it out" / spec 215 Tier 1
// endgame_playout) — the sibling of hooks/use-spar-results, writing to the
// DISTINCT playout store (lib/playout), never to spar results.
//
// Rules enforced (same shape as the spar recorder):
// - Records once per game (keyed by gameKey) when a real end lands with a
//   parseable label; unknown labels record nothing rather than guess.
// - Take-back of a manual end (resign) un-ends the game: the entry is
//   withdrawn so the eventual real end records fresh.
//
// Returns the entry recorded for the CURRENT game (null while live), so the
// screen shows exactly the verdict that was stored — no parallel recompute.

import { useEffect, useRef, useState } from "react"
import type { SparColor } from "@/lib/spar"
import type { SparResultMode } from "@/lib/spar-results"
import {
  appendPlayoutResult,
  buildPlayoutResult,
  loadPlayoutResults,
  persistPlayoutResults,
  removePlayoutResult,
  type PlayoutResultEntry,
  type PlayoutSourceKind,
} from "@/lib/playout"

export interface PlayoutRecorderArgs {
  /** True while the playout screen is in its playing phase. */
  active: boolean
  /** status.over — a real end (position-derived or resign). */
  over: boolean
  /** status.label at the end, null while live. */
  resultLabel: string | null
  source: PlayoutSourceKind
  fen: string
  /** Stable launch-position id, when the request carried one. */
  positionId?: string
  evalPawns: number
  userSide: SparColor
  level: number
  /** Declared intent (spec 215): serious feeds eg_conversion, probe never. */
  mode: SparResultMode
  plies: number
  /** Changes on every new game (e.g. the board nonce) — the once-per-game key. */
  gameKey: number | string
  /** The playout config's "Counts toward training" toggle, already forced
   *  false by the caller for probe games — passed straight through to
   *  buildPlayoutResult, which also enforces "probe never counts" itself. */
  countsTowardTraining: boolean
}

export function usePlayoutRecorder(args: PlayoutRecorderArgs): PlayoutResultEntry | null {
  const { active, over, resultLabel, source, fen, positionId, evalPawns, userSide, level, mode, plies, gameKey, countsTowardTraining } = args
  const recordedRef = useRef<{ key: number | string; id: string } | null>(null)
  const [entry, setEntry] = useState<PlayoutResultEntry | null>(null)

  useEffect(() => {
    if (recordedRef.current && recordedRef.current.key !== gameKey) {
      recordedRef.current = null
      setEntry(null)
    }

    if (!active) return

    if (over && resultLabel && !recordedRef.current) {
      const built = buildPlayoutResult({ source, fen, positionId, evalPawns, userSide, level, mode, resultLabel, plies, countsTowardTraining })
      if (!built) return // unknown label — record nothing rather than guess
      persistPlayoutResults(appendPlayoutResult(loadPlayoutResults(), built))
      recordedRef.current = { key: gameKey, id: built.id }
      setEntry(built)
      return
    }

    // Take-back undid the end (same game, no longer over): withdraw the entry.
    if (!over && recordedRef.current && recordedRef.current.key === gameKey) {
      persistPlayoutResults(removePlayoutResult(loadPlayoutResults(), recordedRef.current.id))
      recordedRef.current = null
      setEntry(null)
    }
  }, [active, over, resultLabel, source, fen, positionId, evalPawns, userSide, level, mode, plies, gameKey, countsTowardTraining])

  return entry
}

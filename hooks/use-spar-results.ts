"use client"

// Spar-results recorder hook (spec 215, Tier 1) — the ONLY glue the spar
// screen needs: one call, no render output, so the spar-tab diff stays a few
// lines. Everything stateful (once-per-game guard, take-back undo, storage)
// lives here.
//
// Rules enforced:
// - Records once per game (keyed by gameKey) when a REAL end lands (status.over
//   with a parseable label). Probe aborts never set `over`, so they never
//   reach this hook — matching spec 214 ("no result recorded anywhere").
// - Probe games that DO reach a real end are stored flagged as probe and never
//   count toward training (spec 215: probe never counts).
// - Take-back of a manual end (resign / draw agreed) un-ends the game: the
//   recorded entry is withdrawn so the game's eventual real end records fresh
//   instead of leaving a stale resignation in the log.

import { useEffect, useRef } from "react"
import type { SparColor } from "@/lib/spar"
import {
  appendSparResult,
  buildSparResult,
  loadSparResults,
  persistSparResults,
  removeSparResult,
  type SparResultMode,
} from "@/lib/spar-results"

export interface SparResultRecorderArgs {
  /** True while the spar screen is in its playing phase. */
  active: boolean
  /** status.over — a real end (position-derived or manual), NOT a probe abort. */
  over: boolean
  /** status.label at the end (e.g. "Checkmate — White wins"), null while live. */
  resultLabel: string | null
  mode: SparResultMode
  opponent: string
  level: number
  userColor: SparColor
  plies: number
  /** Changes on every new game (e.g. the board nonce) — the once-per-game key. */
  gameKey: number | string
  /** The SparConfig screen's "Counts toward training" toggle, already forced
   *  false by the caller for probe games — passed straight through to
   *  buildSparResult, which also enforces "probe never counts" itself. */
  countsTowardTraining: boolean
}

export function useSparResultRecorder(args: SparResultRecorderArgs): void {
  const { active, over, resultLabel, mode, opponent, level, userColor, plies, gameKey, countsTowardTraining } = args
  // The id recorded for the current gameKey, so a take-back that un-ends the
  // game can withdraw it. Reset whenever gameKey changes.
  const recordedRef = useRef<{ key: number | string; id: string } | null>(null)

  useEffect(() => {
    if (recordedRef.current && recordedRef.current.key !== gameKey) {
      recordedRef.current = null
    }

    if (!active) return

    if (over && resultLabel && !recordedRef.current) {
      const entry = buildSparResult({ opponent, level, mode, userColor, resultLabel, plies, countsTowardTraining })
      if (!entry) return // unknown label — record nothing rather than guess
      persistSparResults(appendSparResult(loadSparResults(), entry))
      recordedRef.current = { key: gameKey, id: entry.id }
      return
    }

    // Take-back undid the end (same game, no longer over): withdraw the entry.
    if (!over && recordedRef.current && recordedRef.current.key === gameKey) {
      persistSparResults(removeSparResult(loadSparResults(), recordedRef.current.id))
      recordedRef.current = null
    }
  }, [active, over, resultLabel, mode, opponent, level, userColor, plies, gameKey, countsTowardTraining])
}

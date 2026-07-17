"use client"

// Persona-vs-persona spectate + replay (spec 217 Promise 3). One screen for
// both because the server serves one shape for both: while the exhibition is
// active this polls GET /api/exhibition/{id} (the server plays both sides on
// its own thread — spectating is read-only by construction) and follows the
// newest move; once finished — or when the spectator steps back — it becomes
// the same step-through replay the history and shared-replay views use
// (lib/game-replay.ts replayFens, SAN straight from the server). The in-app
// exhibition viewer (spec 218, tournament-tab.tsx ExhibitionView) is the
// reference UX: board + live status + numbered move list.

import { useCallback, useEffect, useMemo, useState } from "react"
import dynamic from "next/dynamic"
import type { Key } from "@lichess-org/chessground/types"
import { Button } from "@chessgui/ui/ui/button"
import { usePlyReview } from "@chessgui/ui/use-ply-review"
import { replayFens } from "@chessgui/core/game-replay"
import {
  ArenaApiError,
  getArenaApi,
  type ArenaExhibitionState,
} from "@chessgui/core/arena-api"
import { arenaExhibitionStatusLabel, pairExhibitionMoves } from "@/lib/arena-moves"

const Board = dynamic(() => import("@chessgui/ui/board").then((m) => ({ default: m.Board })), {
  ssr: false,
})

const EMPTY_DESTS = new Map<Key, Key[]>()
const noop = () => {}

// Spectate poll cadence. The server persists every move as it happens, so
// this is purely how fresh the spectator's view is — well under the ~10s/move
// the staged BT3 search takes, cheap enough for a family-scale backend.
const POLL_MS = 2000

export function ExhibitionScreen({
  exhibitionId,
  onBack,
}: {
  exhibitionId: number
  onBack: () => void
}) {
  const [ex, setEx] = useState<ArenaExhibitionState | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Shared ply-review model (spec 218, use-ply-review): following the live
  // game means the index tracks the tip as moves arrive; stepping back pauses
  // following, the Live button (toTip) resumes it. This screen keeps its
  // original controls: no arrow keys, and forward parks AT the tip instead of
  // resuming the live follow.
  const { index: ply, following, atTip, back, forward, toTip } = usePlyReview({
    tip: ex?.moves.length ?? 0,
    keyboard: false,
    resumeAtTip: false,
  })
  const [stopping, setStopping] = useState(false)

  const load = useCallback(async () => {
    try {
      setEx(await getArenaApi().getExhibition(exhibitionId))
      setError(null)
    } catch (e) {
      setError(e instanceof ArenaApiError ? e.message : "Couldn't load the exhibition.")
    }
  }, [exhibitionId])

  useEffect(() => {
    load()
  }, [load])

  const active = ex?.status === "active"
  useEffect(() => {
    if (!active) return
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [active, load])

  const stop = useCallback(async () => {
    setStopping(true)
    try {
      setEx(await getArenaApi().stopExhibition(exhibitionId))
    } catch (e) {
      // A 409 means it finished on its own while we clicked — the next poll
      // (or this reload) shows the honest end, not an error.
      if (e instanceof ArenaApiError && e.status === 409) load()
      else setError(e instanceof ArenaApiError ? e.message : "Couldn't stop the exhibition.")
    } finally {
      setStopping(false)
    }
  }, [exhibitionId, load])

  const fens = useMemo(() => (ex ? replayFens("", ex.moves.map((m) => m.uci)) : []), [ex])
  const rows = useMemo(() => (ex ? pairExhibitionMoves(ex.moves) : []), [ex])

  if (error && !ex) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center gap-3 p-6"
        data-testid="arena-exhibition-error"
      >
        <p className="text-sm text-red-400">{error}</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={load}>
            Retry
          </Button>
          <Button variant="ghost" onClick={onBack}>
            ‹ Exhibitions
          </Button>
        </div>
      </div>
    )
  }

  if (!ex) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-muted-foreground"
        data-testid="arena-exhibition-loading"
      >
        Loading exhibition…
      </div>
    )
  }

  const label = arenaExhibitionStatusLabel(ex)
  const thinkingName = ex.moves.length % 2 === 0 ? ex.whiteName : ex.blackName

  return (
    <div className="flex-1 min-h-0 flex flex-col p-4 md:p-6 gap-4" data-testid="arena-exhibition">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold truncate" data-testid="arena-exhibition-players">
            {ex.whiteName} vs {ex.blackName}
          </h2>
          <p className="text-xs" data-testid="arena-exhibition-status">
            {label ? (
              <span className="text-amber-300 font-medium">{label}</span>
            ) : (
              <span className="text-muted-foreground">
                <span className="text-emerald-300 font-medium">Live</span> — {thinkingName} is
                thinking…
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {active && (
            <Button
              variant="outline"
              size="sm"
              onClick={stop}
              disabled={stopping}
              data-testid="arena-exhibition-stop"
            >
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onBack} data-testid="arena-exhibition-back">
            ‹ Exhibitions
          </Button>
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-400" data-testid="arena-exhibition-poll-error">
          {error}
        </p>
      )}

      <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-4 md:gap-6 overflow-auto">
        <div className="flex-1 flex items-center justify-center shrink-0">
          <Board
            fen={fens[ply] ?? ex.fen}
            orientation="white"
            viewOnly
            legalMoves={EMPTY_DESTS}
            onMove={noop}
          />
        </div>
        <div className="w-full md:w-56 md:shrink-0 flex flex-col gap-2">
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={back}
              disabled={ply === 0}
              data-testid="arena-exhibition-back-ply"
            >
              ◀
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={forward}
              disabled={atTip}
              data-testid="arena-exhibition-forward-ply"
            >
              ▶
            </Button>
            {!following && active && (
              <Button
                variant="outline"
                size="sm"
                onClick={toTip}
                data-testid="arena-exhibition-live"
              >
                Live
              </Button>
            )}
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 flex-1 min-h-0 overflow-auto">
            <div className="text-xs font-semibold text-muted-foreground mb-2">Moves</div>
            {rows.length === 0 ? (
              <p className="text-xs text-muted-foreground">No moves yet.</p>
            ) : (
              <ol
                className="text-sm font-mono grid grid-cols-[auto_1fr_1fr] gap-x-2 gap-y-0.5"
                data-testid="arena-exhibition-movelist"
              >
                {rows.map((row) => (
                  <li key={row.no} className="contents">
                    <span className="text-muted-foreground text-right">{row.no}.</span>
                    <span>{row.white?.san ?? ""}</span>
                    <span>{row.black?.san ?? ""}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

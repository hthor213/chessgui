"use client"

// Dedicated live opening-explorer panel for the analyze board (spec 200,
// "a later slice" of the Database tab's position-search seed). Shows the
// database's move statistics for the current position, updating as the user
// plays or navigates, with the Lichess online fallback when the local
// database is empty there.
//
// Reuses the same wiring as the Database tab: lib/database.ts (Tauri backend
// or the in-memory browser mock), lib/explorer-stats.ts for aggregation, and
// lib/lichess-explorer.ts for the fallback. No engine involvement anywhere —
// explorer stats are book-class data, so the spec 219 active-game lockout
// does not apply (same ruling as the annotation bar: books are fair-play
// legal).
//
// Rows are compact (SAN, games, W/D/L bar) because the panel lives in the
// narrow analytics column; avg-Elo/performance details ride in tooltips.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Card } from "@chessgui/ui/ui/card"
import { searchPosition, type PositionHit } from "@/lib/database"
import {
  aggregateHits,
  moverFromFen,
  sortGroups,
  type ExplorerSort,
  type MoveGroup,
} from "@/lib/explorer-stats"
import {
  fetchLichessExplorer,
  type LichessExplorerResult,
} from "@/lib/lichess-explorer"

type OpeningExplorerPanelProps = {
  /** Current board FEN — searched (and re-searched, debounced) automatically. */
  currentFen: string
  /** Play a move (UCI) from the panel onto the board's current game. */
  onPlayMove?: (uci: string) => void
}

export function OpeningExplorerPanel({ currentFen, onPlayMove }: OpeningExplorerPanelProps) {
  const [hits, setHits] = useState<PositionHit[] | null>(null)
  const [explorerSort, setExplorerSort] = useState<ExplorerSort>("count")
  const [online, setOnline] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ok"; data: LichessExplorerResult }
    | { status: "error"; message: string }
  >({ status: "idle" })

  // Nonce guards: rapid navigation must never let a stale response clobber a
  // newer one (same pattern as the Database tab's explorer).
  const posReqId = useRef(0)
  const onlineReqId = useRef(0)

  const findPosition = useCallback(async (fen: string) => {
    const id = ++posReqId.current
    const found = await searchPosition(fen, 500)
    if (id === posReqId.current) setHits(found)
  }, [])

  // Debounced auto-search on every position change (holding an arrow key or
  // clicking through explorer moves must not flood the backend).
  useEffect(() => {
    if (!currentFen) {
      setHits(null)
      return
    }
    const t = setTimeout(() => void findPosition(currentFen), 200)
    return () => clearTimeout(t)
  }, [currentFen, findPosition])

  const mover = currentFen ? moverFromFen(currentFen) : "white"
  const localGroups = useMemo(
    () => (hits ? sortGroups(aggregateHits(hits, mover), explorerSort) : null),
    [hits, mover, explorerSort],
  )

  // Lichess fallback: only when the local search came back empty.
  useEffect(() => {
    if (!currentFen || hits === null || hits.length > 0) {
      setOnline({ status: "idle" })
      return
    }
    const id = ++onlineReqId.current
    setOnline({ status: "loading" })
    fetchLichessExplorer(currentFen)
      .then((data) => {
        if (id === onlineReqId.current) setOnline({ status: "ok", data })
      })
      .catch((e: unknown) => {
        if (id === onlineReqId.current)
          setOnline({
            status: "error",
            message: e instanceof Error ? e.message : "Lichess explorer failed",
          })
      })
  }, [currentFen, hits])

  const onlineGroups = useMemo(
    () => (online.status === "ok" ? sortGroups(online.data.moves, explorerSort) : null),
    [online, explorerSort],
  )

  return (
    <Card
      className="bg-card/50 backdrop-blur-sm border-white/10 p-3 flex flex-col gap-2"
      data-testid="explorer-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Opening explorer</h3>
        {/* Sort toggle (spec 200: by count / by performance) */}
        <div className="flex rounded-md border border-input overflow-hidden text-xs">
          {(["count", "performance"] as const).map((mode) => (
            <button
              key={mode}
              className={`px-2 py-0.5 ${
                explorerSort === mode
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setExplorerSort(mode)}
              title={mode === "count" ? "Sort moves by game count" : "Sort moves by performance rating"}
              data-testid={`explorer-sort-${mode}`}
            >
              {mode === "count" ? "Count" : "Perf"}
            </button>
          ))}
        </div>
      </div>
      {/* Explicit transposition claim (spec 200): the search is keyed on the
          position (Zobrist hash), not on the move order that reached it. */}
      <p className="text-xs text-muted-foreground" data-testid="explorer-transposition-note">
        Database games reaching this position — matched by position (Zobrist key), so
        transpositions from other move orders are included.
      </p>

      {localGroups && localGroups.length > 0 && (
        <ExplorerMoveRows groups={localGroups} games={hits!.length} onPlayMove={onPlayMove} />
      )}

      {localGroups && localGroups.length === 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground" data-testid="explorer-empty">
            No database games reach this position.
          </p>
          {online.status === "loading" && (
            <p className="text-xs text-muted-foreground" data-testid="explorer-lichess-loading">
              Checking the Lichess opening explorer…
            </p>
          )}
          {online.status === "error" && (
            <p className="text-xs text-amber-400/80" data-testid="explorer-lichess-error">
              {online.message}
            </p>
          )}
          {online.status === "ok" && onlineGroups && (
            <div className="flex flex-col gap-1" data-testid="explorer-lichess-results">
              <span className="inline-flex items-center gap-1.5 text-xs text-sky-300">
                <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
                online — Lichess ({online.data.total.toLocaleString()} games)
              </span>
              {onlineGroups.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Lichess has no games for this position either.
                </p>
              ) : (
                <ExplorerMoveRows
                  groups={onlineGroups}
                  games={online.data.total}
                  onPlayMove={onPlayMove}
                />
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

/** Compact move rows: SAN, game count, W/D/L bar. Elo/performance in titles. */
function ExplorerMoveRows({
  groups,
  games,
  onPlayMove,
}: {
  groups: MoveGroup[]
  games: number
  onPlayMove?: (uci: string) => void
}) {
  return (
    <div className="flex flex-col gap-0.5" data-testid="explorer-results">
      <p className="text-xs text-muted-foreground">
        {games.toLocaleString()} game{games === 1 ? "" : "s"}
      </p>
      {groups.map((g) => {
        const playable = !!g.uci && !!onPlayMove
        const details = [
          `+${g.whiteWins} =${g.draws} -${g.blackWins}`,
          g.avgElo != null ? `avg ${Math.round(g.avgElo)}` : null,
          g.performance != null ? `perf ${g.performance}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
        return (
          <div
            key={g.san}
            className={`flex items-center gap-2 rounded px-1 -mx-1 py-0.5 ${
              playable ? "cursor-pointer hover:bg-white/5" : ""
            }`}
            data-testid={`explorer-move-${g.san}`}
            title={playable ? `Play ${g.san} — ${details}` : details}
            onClick={playable ? () => onPlayMove!(g.uci!) : undefined}
            role={playable ? "button" : undefined}
            tabIndex={playable ? 0 : undefined}
            onKeyDown={
              playable
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      onPlayMove!(g.uci!)
                    }
                  }
                : undefined
            }
          >
            <span className="w-12 shrink-0 font-mono text-xs">{g.san}</span>
            <span className="w-10 shrink-0 text-right tabular-nums text-xs text-muted-foreground">
              {g.total}
            </span>
            <div className="flex-1 h-3 rounded overflow-hidden flex bg-secondary">
              <div className="bg-neutral-100" style={{ width: `${(g.whiteWins / g.total) * 100}%` }} />
              <div className="bg-neutral-400" style={{ width: `${(g.draws / g.total) * 100}%` }} />
              <div className="bg-neutral-700" style={{ width: `${(g.blackWins / g.total) * 100}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

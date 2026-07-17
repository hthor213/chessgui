"use client"

// Dedicated live opening-explorer panel for the analyze board (spec 200,
// "a later slice" of the Database tab's position-search seed). Shows the
// database's move statistics for the current position, updating as the user
// plays or navigates, with the Lichess online fallback when the local
// database is empty there.
//
// Two player-scoped consumers ride on the same panel:
// - spec 225 (rival filter): a player-name filter switches the explorer to
//   only that player's games (bounded backend query over the name indexes),
//   with the panel relabelled "Explorer: <name>'s games".
// - spec 211 (opening leaks): the GUI surface of scripts/mining/leak_report.py
//   — the filtered player's worst-scoring openings by (ECO × colour). The CLI
//   ranks by eval bled ([%eval] tags / an engine pass); the database stores no
//   per-move evals and a UI path gets no engine budget, so this view ranks by
//   results and says so.
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
import {
  listPlayers,
  playerOpenings,
  searchPosition,
  searchPositionForPlayer,
  type PositionHit,
} from "@/lib/database"
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
import { aggregateOpeningLeaks, type OpeningLeakRow } from "@chessgui/core/opening-leaks"
import { ecoName } from "@chessgui/core/eco"

/** Candidate-game cap for the player-scoped queries (backend default too). */
const PLAYER_GAME_LIMIT = 2000

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

  // Player filter (spec 225): exact name; the datalist offers real names from
  // the database as the user types, so "exact" is one click away.
  const [playerInput, setPlayerInput] = useState("")
  const [playerOptions, setPlayerOptions] = useState<string[]>([])
  const player = playerInput.trim()

  // Opening leaks (spec 211), for the filtered player on demand.
  const [leaks, setLeaks] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ok"; player: string; games: number; rows: OpeningLeakRow[] }
    | { status: "error"; message: string }
  >({ status: "idle" })

  // Nonce guards: rapid navigation must never let a stale response clobber a
  // newer one (same pattern as the Database tab's explorer).
  const posReqId = useRef(0)
  const onlineReqId = useRef(0)
  const optionsReqId = useRef(0)

  const findPosition = useCallback(async (fen: string, forPlayer: string) => {
    const id = ++posReqId.current
    const found = forPlayer
      ? await searchPositionForPlayer(fen, forPlayer, PLAYER_GAME_LIMIT)
      : await searchPosition(fen, 500)
    if (id === posReqId.current) setHits(found)
  }, [])

  // Debounced auto-search on every position or filter change (holding an
  // arrow key or typing a name must not flood the backend).
  useEffect(() => {
    if (!currentFen) {
      setHits(null)
      return
    }
    const t = setTimeout(() => void findPosition(currentFen, player), 200)
    return () => clearTimeout(t)
  }, [currentFen, player, findPosition])

  // Datalist suggestions for the typed prefix (empty prefix: nothing — the
  // backend never dumps the full player roster).
  useEffect(() => {
    if (!player) {
      setPlayerOptions([])
      return
    }
    const id = ++optionsReqId.current
    const t = setTimeout(() => {
      void listPlayers(player, 12).then((names) => {
        if (id === optionsReqId.current) setPlayerOptions(names)
      })
    }, 200)
    return () => clearTimeout(t)
  }, [player])

  const mover = currentFen ? moverFromFen(currentFen) : "white"
  const localGroups = useMemo(
    () => (hits ? sortGroups(aggregateHits(hits, mover), explorerSort) : null),
    [hits, mover, explorerSort],
  )

  // Lichess fallback: only when the UNFILTERED local search came back empty —
  // a player filter asks about their games, which Lichess can't answer.
  useEffect(() => {
    if (!currentFen || player || hits === null || hits.length > 0) {
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
  }, [currentFen, player, hits])

  const onlineGroups = useMemo(
    () => (online.status === "ok" ? sortGroups(online.data.moves, explorerSort) : null),
    [online, explorerSort],
  )

  const runLeakReport = useCallback(async () => {
    if (!player) return
    setLeaks({ status: "loading" })
    try {
      const rows = await playerOpenings(player, PLAYER_GAME_LIMIT)
      setLeaks({
        status: "ok",
        player,
        games: rows.length,
        rows: aggregateOpeningLeaks(rows),
      })
    } catch (e: unknown) {
      setLeaks({
        status: "error",
        message: e instanceof Error ? e.message : "opening-leak query failed",
      })
    }
  }, [player])

  return (
    <Card
      className="bg-card/50 backdrop-blur-sm border-white/10 p-3 flex flex-col gap-2"
      data-testid="explorer-panel"
    >
      <div className="flex items-center justify-between gap-2">
        {/* Spec 225: an unmissable label whenever the stats are one player's. */}
        <h3 className="text-sm font-medium" data-testid="explorer-title">
          {player ? `Explorer: ${player}'s games` : "Opening explorer"}
        </h3>
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

      {/* Player filter (spec 225): restrict the stats to one player's games. */}
      <div className="flex items-center gap-1.5">
        <input
          className="flex-1 min-w-0 rounded-md border border-input bg-transparent px-2 py-1 text-xs"
          placeholder="Filter by player (exact name)…"
          value={playerInput}
          onChange={(e) => setPlayerInput(e.target.value)}
          list="explorer-player-options"
          data-testid="explorer-player-filter"
        />
        <datalist id="explorer-player-options">
          {playerOptions.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        {player && (
          <button
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setPlayerInput("")}
            title="Clear the player filter"
            data-testid="explorer-player-clear"
          >
            ×
          </button>
        )}
      </div>

      {/* Explicit transposition claim (spec 200): the search is keyed on the
          position (Zobrist hash), not on the move order that reached it. */}
      <p className="text-xs text-muted-foreground" data-testid="explorer-transposition-note">
        {player ? `${player}'s database games` : "Database games"} reaching this position —
        matched by position (Zobrist key), so transpositions from other move orders are included.
      </p>

      {localGroups && localGroups.length > 0 && (
        <ExplorerMoveRows groups={localGroups} games={hits!.length} onPlayMove={onPlayMove} />
      )}

      {localGroups && localGroups.length === 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground" data-testid="explorer-empty">
            {player
              ? `No games by ${player} reach this position (their ${PLAYER_GAME_LIMIT.toLocaleString()} most recent games are searched).`
              : "No database games reach this position."}
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

      {/* Opening leaks (spec 211): the GUI surface of leak_report.py, scoped
          to the filtered player. Result-ranked — see the section copy. */}
      {player && (
        <div className="flex flex-col gap-1.5 border-t border-white/10 pt-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-medium">Opening leaks</h4>
            <button
              className="rounded-md border border-input px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => void runLeakReport()}
              disabled={leaks.status === "loading"}
              data-testid="explorer-leaks-run"
            >
              {leaks.status === "loading" ? "Crunching…" : `Report for ${player}`}
            </button>
          </div>
          {leaks.status === "error" && (
            <p className="text-xs text-amber-400/80" data-testid="explorer-leaks-error">
              {leaks.message}
            </p>
          )}
          {leaks.status === "ok" && (
            <OpeningLeaksList player={leaks.player} games={leaks.games} rows={leaks.rows} />
          )}
        </div>
      )}
    </Card>
  )
}

/**
 * The player's worst-scoring openings by (ECO × colour), most-repeated first
 * among ties — the result-ranked port of leak_report.py's ranked table.
 */
function OpeningLeaksList({
  player,
  games,
  rows,
}: {
  player: string
  games: number
  rows: OpeningLeakRow[]
}) {
  const shown = rows.slice(0, 8)
  return (
    <div className="flex flex-col gap-1" data-testid="explorer-leaks-results">
      {/* Honest ranking note: the CLI report ranks by eval bled; this database
          stores no per-move evals, so here it's results only. */}
      <p className="text-xs text-muted-foreground" data-testid="explorer-leaks-note">
        Worst-scoring openings across {player}&apos;s {games.toLocaleString()} most recent
        finished games (ECO × colour, ≥3 games each). Ranked by results — the database stores
        no per-move evals; eval-bleed ranking lives in the CLI leak report.
      </p>
      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="explorer-leaks-empty">
          No opening reaches 3 finished games for {player} yet.
        </p>
      ) : (
        shown.map((r) => (
          <div
            key={`${r.eco}|${r.color}`}
            className="flex items-center gap-2 text-xs"
            data-testid={`explorer-leak-${r.eco}-${r.color}`}
            title={ecoName(r.eco) ?? undefined}
          >
            <span className="w-8 shrink-0 font-mono">{r.eco}</span>
            <span className="w-12 shrink-0 text-muted-foreground">as {r.color}</span>
            <span className="flex-1 truncate text-muted-foreground">
              {ecoName(r.eco) ?? "—"}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              +{r.wins} ={r.draws} −{r.losses}
            </span>
            <span className="w-12 shrink-0 text-right tabular-nums">{r.scorePct}%</span>
          </div>
        ))
      )}
      {rows.length > shown.length && (
        <p className="text-xs text-muted-foreground">
          …and {rows.length - shown.length} more openings below the fold.
        </p>
      )}
    </div>
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

"use client"

// Persona Arena history (spec 217 Tier 0): the player's past games list plus
// a replay view, and a delete action (spec 217 Failure modes: "games are
// deletable on request"). A finished game opens read-only, step-through
// replay reusing lib/game-replay.ts's `replayFens` for per-ply FEN stepping
// (the server gives SAN per move already, so no SAN reconstruction is
// needed here — only the position-after-each-ply array replayFens builds
// from the same uci list). Resuming a still-active game hands control back
// to the caller (GameScreen).

import { useCallback, useEffect, useMemo, useState } from "react"
import dynamic from "next/dynamic"
import type { Key } from "@lichess-org/chessground/types"
import { Button } from "@chessgui/ui/ui/button"
import { replayFens } from "@chessgui/core/game-replay"
import { ArenaApiError, getArenaApi, type ArenaGameState, type ArenaGameSummary } from "@chessgui/core/arena-api"
import { arenaResultBadge, pairArenaMoves } from "@/lib/arena-moves"

const Board = dynamic(() => import("@chessgui/ui/board").then((m) => ({ default: m.Board })), {
  ssr: false,
})

const EMPTY_DESTS = new Map<Key, Key[]>()
const noop = () => {}

export function HistoryScreen({
  onResume,
  onBack,
}: {
  onResume: (gameId: number) => void
  onBack: () => void
}) {
  const [games, setGames] = useState<ArenaGameSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [replayId, setReplayId] = useState<number | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setGames(await getArenaApi().listGames())
    } catch (e) {
      setError(e instanceof ArenaApiError ? e.message : "Couldn't load your games.")
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const deleteGame = useCallback(
    async (id: number) => {
      setDeleting(id)
      try {
        await getArenaApi().deleteGame(id)
        setGames((prev) => (prev ? prev.filter((g) => g.id !== id) : prev))
      } catch (e) {
        setError(e instanceof ArenaApiError ? e.message : "Couldn't delete the game.")
      } finally {
        setDeleting(null)
      }
    },
    [],
  )

  if (replayId !== null) {
    return <ReplayView gameId={replayId} onBack={() => setReplayId(null)} onResume={onResume} />
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto p-6" data-testid="arena-history">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">My games</h1>
          <Button variant="ghost" onClick={onBack} data-testid="arena-history-back">
            ‹ Lobby
          </Button>
        </div>

        {error && (
          <p className="text-sm text-red-400" data-testid="arena-history-error">
            {error}
          </p>
        )}

        {!games ? (
          <p className="text-sm text-muted-foreground" data-testid="arena-history-loading">
            Loading…
          </p>
        ) : games.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="arena-history-empty">
            No games yet — play one from the lobby.
          </p>
        ) : (
          <div className="flex flex-col gap-2" data-testid="arena-history-list">
            {games.map((g) => (
              <div
                key={g.id}
                className="rounded-lg border border-white/10 bg-white/[0.03] p-3 flex items-center justify-between gap-3"
                data-testid={`arena-history-row-${g.id}`}
              >
                <button
                  onClick={() => (g.status === "active" ? onResume(g.id) : setReplayId(g.id))}
                  className="text-left flex-1 min-w-0 hover:opacity-80 transition-opacity"
                  data-testid={`arena-history-open-${g.id}`}
                >
                  <div className="text-sm font-medium truncate">{g.persona}</div>
                  <div className="text-xs text-muted-foreground">
                    {g.movesCount} moves · {new Date(g.createdAt).toLocaleDateString()}
                  </div>
                </button>
                <span className="text-xs px-2 py-0.5 rounded-full border border-white/10 text-muted-foreground shrink-0">
                  {arenaResultBadge(g.status, g.result, g.playerColor)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => deleteGame(g.id)}
                  disabled={deleting === g.id}
                  title="Delete this game"
                  data-testid={`arena-history-delete-${g.id}`}
                >
                  {deleting === g.id ? "…" : "Delete"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ReplayView({
  gameId,
  onBack,
  onResume,
}: {
  gameId: number
  onBack: () => void
  onResume: (gameId: number) => void
}) {
  const [game, setGame] = useState<ArenaGameState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ply, setPly] = useState(0)

  useEffect(() => {
    let live = true
    getArenaApi()
      .getGame(gameId)
      .then((g) => {
        if (!live) return
        setGame(g)
        setPly(g.moves.length)
      })
      .catch((e) => {
        if (live) setError(e instanceof ArenaApiError ? e.message : "Couldn't load the game.")
      })
    return () => {
      live = false
    }
  }, [gameId])

  const fens = useMemo(
    () => (game ? replayFens("", game.moves.map((m) => m.uci)) : []),
    [game],
  )
  const rows = useMemo(() => (game ? pairArenaMoves(game.moves) : []), [game])

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6" data-testid="arena-replay-error">
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="ghost" onClick={onBack}>
          ‹ My games
        </Button>
      </div>
    )
  }

  if (!game) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground" data-testid="arena-replay-loading">
        Loading…
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col p-4 md:p-6 gap-4" data-testid="arena-replay">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{game.persona}</h2>
        <div className="flex gap-2">
          {game.status === "active" && (
            <Button size="sm" onClick={() => onResume(game.id)} data-testid="arena-replay-resume">
              Resume
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onBack} data-testid="arena-replay-back">
            ‹ My games
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-4 md:gap-6 overflow-auto">
        <div className="flex-1 flex items-center justify-center shrink-0">
          <Board
            fen={fens[ply] ?? game.fen}
            orientation={game.playerColor}
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
              onClick={() => setPly((p) => Math.max(0, p - 1))}
              disabled={ply === 0}
              data-testid="arena-replay-back-ply"
            >
              ◀
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPly((p) => Math.min(fens.length - 1, p + 1))}
              disabled={ply >= fens.length - 1}
              data-testid="arena-replay-forward-ply"
            >
              ▶
            </Button>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 flex-1 min-h-0 overflow-auto">
            <ol className="text-sm font-mono grid grid-cols-[auto_1fr_1fr] gap-x-2 gap-y-0.5">
              {rows.map((row) => (
                <li key={row.no} className="contents">
                  <span className="text-muted-foreground text-right">{row.no}.</span>
                  <span>{row.white?.san ?? ""}</span>
                  <span>{row.black?.san ?? ""}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}

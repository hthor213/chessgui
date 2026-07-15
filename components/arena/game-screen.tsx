"use client"

// Persona Arena game screen (spec 217 Tier 0): board, thinking indicator
// (spec 217 "Failure modes & latency" — target under ~2s per persona move),
// numbered move list, resign. No clock (Tier 0 — spec 217 Tiers lists
// "clocks with increment" as a Tier 1 item) and no draw-offer control: the
// real backend (server/arena/app/persona.py, its own "honest inventory"
// docstring) explicitly does not implement a draw/resign model beyond
// resign — "a human opponent adjudicates their own games". Automatic
// rule-based draws (stalemate, insufficient material, repetition, 50-move)
// still happen on their own after any move; there's just no "offer draw"
// button to negotiate one early, so this screen doesn't render one (a
// deliberate scope cut once the real contract was found — see this
// feature's open items).
//
// The board here never computes a move's outcome itself beyond letting
// Chessground offer legal destinations — every move is submitted to the
// server (lib/arena-api.ts's `submitMove`) and the resulting fen/status/SAN
// come back from there (the server already returns SAN per move, so there is
// no client-side game-replay reconstruction needed on this screen, unlike
// the history replay view).

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import type { Key } from "@lichess-org/chessground/types"
import { Chess } from "chessops/chess"
import { parseFen } from "chessops/fen"
import { chessgroundDests } from "chessops/compat"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { initialsFor } from "@/lib/roster"
import { dragToUci, turnOf } from "@/lib/spar"
import { ArenaApiError, getArenaApi, type ArenaGameState } from "@/lib/arena-api"
import { arenaStatusLabel, pairArenaMoves } from "@/lib/arena-moves"

const Board = dynamic(() => import("@/components/board").then((m) => ({ default: m.Board })), {
  ssr: false,
})

// The move-latency budget is ~2s (spec 217); this note appears well past
// that so it never fires during a normal-latency move, only a genuinely slow
// one (the server's own job is retry/respawn — "never silently hang a game"
// — this is just the client not going silent while it waits).
const SLOW_MOVE_MS = 4000

function legalDests(fen: string): Map<Key, Key[]> {
  const setup = parseFen(fen)
  if (setup.isErr) return new Map()
  const pos = Chess.fromSetup(setup.unwrap())
  if (pos.isErr) return new Map()
  return chessgroundDests(pos.unwrap()) as Map<Key, Key[]>
}

export function GameScreen({ gameId, onExit }: { gameId: number; onExit: () => void }) {
  const [game, setGame] = useState<ArenaGameState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [thinking, setThinking] = useState(false)
  const [slow, setSlow] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const slowTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const g = await getArenaApi().getGame(gameId)
      setGame(g)
    } catch (e) {
      if (e instanceof ArenaApiError && e.status === 503) {
        setLoadError("The engine stalled — your move is saved. Tap Retry.")
      } else {
        setLoadError(e instanceof ArenaApiError ? e.message : "Couldn't load the game.")
      }
    }
  }, [gameId])

  useEffect(() => {
    load()
  }, [load])
  useEffect(() => () => clearTimeout(slowTimer.current), [])

  const playerSide = game?.playerColor ?? "white"
  const fen = game?.fen ?? ""
  const frozen = !game || game.status !== "active"
  const userToMove = !!game && !frozen && turnOf(fen) === playerSide && !thinking

  const legalMoves = useMemo(
    () => (userToMove ? legalDests(fen) : new Map<Key, Key[]>()),
    [userToMove, fen],
  )

  const onBoardMove = useCallback(
    async (from: Key, to: Key) => {
      if (!game || !userToMove) return
      const uci = dragToUci(fen, from as string, to as string)
      setThinking(true)
      setMoveError(null)
      slowTimer.current = setTimeout(() => setSlow(true), SLOW_MOVE_MS)
      try {
        const g = await getArenaApi().submitMove(game.id, uci)
        setGame(g)
      } catch (e) {
        if (e instanceof ArenaApiError && e.status === 503) {
          setMoveError("The engine stalled — your move is saved. Reload to retry.")
        } else {
          setMoveError(e instanceof ArenaApiError ? e.message : "Move failed — try again.")
        }
        // A rejected/stalled move never applies locally — resync with the
        // server's canonical state (the player's own move is persisted
        // server-side before the persona reply is attempted, so a reload
        // here safely picks that up per spec 217's resume rule).
        load()
      } finally {
        clearTimeout(slowTimer.current)
        setSlow(false)
        setThinking(false)
      }
    },
    [game, userToMove, fen, load],
  )

  const resign = useCallback(async () => {
    if (!game || frozen) return
    try {
      setGame(await getArenaApi().resign(game.id))
    } catch (e) {
      setMoveError(e instanceof ArenaApiError ? e.message : "Couldn't resign.")
    }
  }, [game, frozen])

  const moveRows = useMemo(() => pairArenaMoves(game?.moves ?? []), [game?.moves])

  if (loadError) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6" data-testid="arena-game-error">
        <p className="text-sm text-red-400">{loadError}</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={load} data-testid="arena-game-retry">
            Retry
          </Button>
          <Button variant="ghost" onClick={onExit}>
            Back to lobby
          </Button>
        </div>
      </div>
    )
  }

  if (!game) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-muted-foreground"
        data-testid="arena-game-loading"
      >
        Loading game…
      </div>
    )
  }

  const label = arenaStatusLabel(game)

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="arena-game">
      <div className="px-6 py-3 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Avatar className="h-6 w-6" data-testid="arena-opponent-avatar">
            <AvatarFallback className="text-[10px]">{initialsFor(game.persona)}</AvatarFallback>
          </Avatar>
          <span className="text-sm font-medium">{game.persona}</span>
          <span className="text-xs text-muted-foreground">No clock (Tier 0)</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onExit} data-testid="arena-game-lobby">
          ‹ Lobby
        </Button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-4 md:gap-8 p-4 md:p-6 overflow-auto">
        <div className="flex-1 min-w-0 flex items-center justify-center shrink-0" data-testid="arena-board">
          <Board
            fen={game.fen}
            orientation={playerSide}
            movableColor={playerSide}
            onMove={onBoardMove}
            legalMoves={legalMoves}
            viewOnly={!userToMove}
          />
        </div>

        <div className="w-full md:w-72 md:shrink-0 flex flex-col gap-4 md:overflow-auto">
          <div className="text-sm" data-testid="arena-turn">
            {label ? (
              <span className="text-amber-300 font-medium" data-testid="arena-status">
                {label}
              </span>
            ) : thinking ? (
              <span className="text-muted-foreground" data-testid="arena-thinking">
                {game.persona} is thinking…
                {slow && (
                  <span className="block text-[11px] mt-0.5" data-testid="arena-thinking-slow">
                    Taking longer than usual — still working.
                  </span>
                )}
              </span>
            ) : userToMove ? (
              <span className="text-emerald-300">Your move.</span>
            ) : (
              <span className="text-muted-foreground">Waiting…</span>
            )}
          </div>

          {moveError && (
            <p className="text-xs text-red-400" data-testid="arena-move-error">
              {moveError}
            </p>
          )}

          <div
            className="rounded-lg border border-white/10 bg-white/[0.03] p-3 flex-1 min-h-0 overflow-auto"
            data-testid="arena-movelist"
          >
            <div className="text-xs font-semibold text-muted-foreground mb-2">Moves</div>
            {moveRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">No moves yet.</p>
            ) : (
              <ol className="text-sm font-mono grid grid-cols-[auto_1fr_1fr] gap-x-2 gap-y-0.5">
                {moveRows.map((row) => (
                  <li key={row.no} className="contents">
                    <span className="text-muted-foreground text-right">{row.no}.</span>
                    <span>{row.white?.san ?? ""}</span>
                    <span>{row.black?.san ?? ""}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="mt-auto pt-2 flex gap-2">
            <Button variant="outline" size="sm" onClick={resign} disabled={frozen} data-testid="arena-resign">
              Resign
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

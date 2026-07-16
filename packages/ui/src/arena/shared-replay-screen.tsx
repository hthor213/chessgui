"use client"

// Read-only shared replay (spec 217 Tier 2: family replay links). Reached via
// /arena?replay=<token> — deliberately OUTSIDE the login flow: the recipient
// of a family link has no Google login and never sees the lobby. The token is
// the capability (unguessable, revocable server-side); the payload is the
// game record only, so this screen renders in a spectator's voice
// (lib/arena-moves.ts arenaSharedStatusLabel — never "You win!") and offers
// no resume/delete/feedback controls. Board stepping mirrors the history
// replay view (history-screen.tsx ReplayView): lib/game-replay.ts replayFens
// over the uci list, SAN straight from the server.

import { useEffect, useMemo, useState } from "react"
import dynamic from "next/dynamic"
import type { Key } from "@lichess-org/chessground/types"
import { Button } from "@chessgui/ui/ui/button"
import { replayFens } from "@chessgui/core/game-replay"
import { ArenaApiError, getArenaApi, type ArenaSharedReplay } from "@chessgui/core/arena-api"
import { arenaSharedStatusLabel, pairArenaMoves } from "@/lib/arena-moves"

const Board = dynamic(() => import("@chessgui/ui/board").then((m) => ({ default: m.Board })), {
  ssr: false,
})

const EMPTY_DESTS = new Map<Key, Key[]>()
const noop = () => {}

export function SharedReplayScreen({ token }: { token: string }) {
  const [replay, setReplay] = useState<ArenaSharedReplay | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ply, setPly] = useState(0)

  useEffect(() => {
    let live = true
    getArenaApi()
      .getSharedReplay(token)
      .then((r) => {
        if (!live) return
        setReplay(r)
        setPly(r.moves.length)
      })
      .catch((e) => {
        if (!live) return
        // 404 covers unknown, revoked, and deleted alike (server contract) —
        // one honest message for all three.
        setError(
          e instanceof ArenaApiError && e.status === 404
            ? "This replay link isn't valid anymore."
            : e instanceof ArenaApiError
              ? e.message
              : "Couldn't load the replay.",
        )
      })
    return () => {
      live = false
    }
  }, [token])

  const fens = useMemo(
    () => (replay ? replayFens("", replay.moves.map((m) => m.uci)) : []),
    [replay],
  )
  const rows = useMemo(() => (replay ? pairArenaMoves(replay.moves) : []), [replay])

  if (error) {
    return (
      <div
        className="flex-1 flex items-center justify-center p-6"
        data-testid="arena-shared-replay-error"
      >
        <p className="text-sm text-red-400">{error}</p>
      </div>
    )
  }

  if (!replay) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-muted-foreground"
        data-testid="arena-shared-replay-loading"
      >
        Loading replay…
      </div>
    )
  }

  const playerName = replay.playerName || "Player"
  const whiteName = replay.playerColor === "white" ? playerName : replay.persona
  const blackName = replay.playerColor === "black" ? playerName : replay.persona

  return (
    <div className="flex-1 min-h-0 flex flex-col p-4 md:p-6 gap-4" data-testid="arena-shared-replay">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold truncate" data-testid="arena-shared-replay-players">
            {whiteName} vs {blackName}
          </h2>
          <p className="text-xs text-muted-foreground">
            <span data-testid="arena-shared-replay-result">{arenaSharedStatusLabel(replay)}</span>
            {" · "}
            {new Date(replay.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-4 md:gap-6 overflow-auto">
        <div className="flex-1 flex items-center justify-center shrink-0">
          <Board
            fen={fens[ply] ?? ""}
            orientation={replay.playerColor}
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
              data-testid="arena-shared-replay-back-ply"
            >
              ◀
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPly((p) => Math.min(fens.length - 1, p + 1))}
              disabled={ply >= fens.length - 1}
              data-testid="arena-shared-replay-forward-ply"
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

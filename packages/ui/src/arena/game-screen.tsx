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
import { Avatar, AvatarFallback } from "@chessgui/ui/ui/avatar"
import { Button } from "@chessgui/ui/ui/button"
import { initialsFor } from "@/lib/roster"
import { dragToUci, turnOf } from "@/lib/spar"
import { ArenaApiError, getArenaApi, type ArenaGameState, type ArenaMove } from "@chessgui/core/arena-api"
import { arenaStatusLabel, pairArenaMoves } from "@/lib/arena-moves"

const Board = dynamic(() => import("@chessgui/ui/board").then((m) => ({ default: m.Board })), {
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

  // "I would never do this" capture (spec 217 Promise 2 — the spec-214
  // spar realism-feedback pattern, ported): tap a persona move in the list
  // (or the button, which targets the persona's latest move), optionally say
  // why, submit. Server-persisted per move — this is the Tier-1 ground-truth
  // stream, not a game feature. Note is optional here (unlike spar's
  // negative verdict): the tap itself is the signal.
  const [feedbackPly, setFeedbackPly] = useState<number | null>(null)
  const [feedbackNote, setFeedbackNote] = useState("")
  const [feedbackError, setFeedbackError] = useState<string | null>(null)
  const [feedbackBusy, setFeedbackBusy] = useState(false)
  const [feedbackConfirm, setFeedbackConfirm] = useState(false)
  const feedbackConfirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(feedbackConfirmTimer.current), [])

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

  // The persona's latest move — the default feedback target ("this move he
  // just played"). Null until the persona has moved at all.
  const lastPersonaPly = useMemo(() => {
    const moves = game?.moves ?? []
    for (let i = moves.length - 1; i >= 0; i--) {
      if (moves[i].mover === "persona") return moves[i].ply
    }
    return null
  }, [game?.moves])

  // Toggle the inline form open on `ply` (tap the same target again to close).
  const toggleFeedback = useCallback((ply: number) => {
    setFeedbackConfirm(false)
    setFeedbackError(null)
    setFeedbackPly((prev) => {
      setFeedbackNote("")
      return prev === ply ? null : ply
    })
  }, [])

  const cancelFeedback = useCallback(() => {
    setFeedbackPly(null)
    setFeedbackNote("")
    setFeedbackError(null)
  }, [])

  const submitFeedback = useCallback(async () => {
    if (!game || feedbackPly === null) return
    setFeedbackBusy(true)
    setFeedbackError(null)
    try {
      await getArenaApi().submitMoveFeedback(game.id, feedbackPly, feedbackNote.trim())
      setFeedbackPly(null)
      setFeedbackNote("")
      setFeedbackConfirm(true)
      clearTimeout(feedbackConfirmTimer.current)
      feedbackConfirmTimer.current = setTimeout(() => setFeedbackConfirm(false), 2000)
    } catch (e) {
      setFeedbackError(e instanceof ArenaApiError ? e.message : "Couldn't record that — try again.")
    } finally {
      setFeedbackBusy(false)
    }
  }, [game, feedbackPly, feedbackNote])

  const feedbackTarget = useMemo(
    () => (feedbackPly === null ? null : (game?.moves ?? []).find((m) => m.ply === feedbackPly) ?? null),
    [feedbackPly, game?.moves],
  )

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

  // One move-list cell. Persona moves are tappable — tapping one targets it
  // for "I would never do this" (spec 217 Promise 2); the player's own moves
  // stay plain text.
  const moveCell = (m?: ArenaMove) => {
    if (!m) return <span />
    if (m.mover !== "persona") return <span>{m.san}</span>
    return (
      <button
        type="button"
        data-testid={`arena-feedback-move-${m.ply}`}
        onClick={() => toggleFeedback(m.ply)}
        className={`text-left rounded px-0.5 -mx-0.5 transition-colors ${
          feedbackPly === m.ply
            ? "bg-amber-400/15 text-amber-300"
            : "hover:bg-white/10"
        }`}
      >
        {m.san}
      </button>
    )
  }

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
                    {moveCell(row.white)}
                    {moveCell(row.black)}
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* "I would never do this" capture (spec 217 Promise 2) — a quiet
              research affordance under the move list, same posture as the
              spar realism-feedback block (spec 214). The button targets the
              persona's latest move; tapping any persona move in the list
              above retargets it. */}
          {lastPersonaPly !== null && (
            <div className="border-t border-white/10 pt-3 flex flex-col gap-2" data-testid="arena-feedback">
              <button
                type="button"
                data-testid="arena-feedback-never"
                onClick={() => toggleFeedback(feedbackPly ?? lastPersonaPly)}
                className={`self-start px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  feedbackPly !== null
                    ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                    : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
                }`}
              >
                I would never do this
              </button>

              {feedbackPly !== null && feedbackTarget && (
                <div className="flex flex-col gap-1.5" data-testid="arena-feedback-form">
                  <span className="text-[11px] text-muted-foreground">
                    About {game.persona}&apos;s {Math.floor(feedbackTarget.ply / 2) + 1}
                    {feedbackTarget.ply % 2 === 0 ? "." : "…"} {feedbackTarget.san} — tap another of
                    their moves above to change.
                  </span>
                  <textarea
                    data-testid="arena-feedback-note"
                    className="w-full bg-white/[0.03] border border-white/10 rounded-md px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-1 focus:ring-white/20"
                    rows={3}
                    placeholder="Because… (optional)"
                    value={feedbackNote}
                    onChange={(e) => setFeedbackNote(e.target.value)}
                    autoFocus
                  />
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={cancelFeedback} data-testid="arena-feedback-cancel">
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={submitFeedback}
                      disabled={feedbackBusy}
                      data-testid="arena-feedback-submit"
                    >
                      Submit
                    </Button>
                  </div>
                </div>
              )}

              {feedbackError && (
                <p className="text-xs text-red-400" data-testid="arena-feedback-error">
                  {feedbackError}
                </p>
              )}
              {feedbackConfirm && (
                <span className="text-xs text-emerald-300/80" data-testid="arena-feedback-confirm">
                  Noted — this tunes the next persona iteration.
                </span>
              )}
            </div>
          )}

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

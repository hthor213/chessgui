"use client"

// Spar vs rival — the Learn view's Tier-0 persona sparring (spec 214).
//
// You play a full game against lc0+Maia at a fixed ~1700, starting from one of
// dad's real opening lines (weighted-sampled from data/rivals/dad_book.json). The
// opponent's moves come from the `maia_move` command, which samples the human
// policy (not argmax) — that IS the human-likeness (spec 214 hard rule: never
// noise-weaken an engine to fake it). Honest label: "a ~1700 playing dad's
// openings", not "dad". This screen runs its own game loop, independent of the
// main analysis board, exactly like the calibration screen.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import type { Key } from "@lichess-org/chessground/types"
import type { DrawShape } from "@lichess-org/chessground/draw"
import { Chess } from "chessops/chess"
import { parseFen } from "chessops/fen"
import { chessgroundDests } from "chessops/compat"
import { Button } from "@/components/ui/button"
import { maiaMove } from "@/lib/maia"
import {
  loadRivalBook,
  pickBookEntry,
  userColorForEntry,
  type RivalBook,
  type RivalBookEntry,
} from "@/lib/rival-book"
import { applyUci, dragToUci, sparStatus, turnOf, type SparColor, type SparPly } from "@/lib/spar"

const Board = dynamic(() => import("@/components/board").then((m) => ({ default: m.Board })), {
  ssr: false,
})

// Adjustable strength (spec 214, Tier 0). Dad's FIDE-listed standard is 1591
// (2024 conversion of his Icelandic national rating), below the family-lore
// ~1750 — so the level is dial-able and the label always states the chosen
// number honestly. 100-Elo Maia bands; all are published nets.
const DEFAULT_LEVEL = 1700
const LEVEL_OPTIONS = [1500, 1600, 1700, 1800, 1900] as const
const RIVAL_LABEL = "Dad"

type SideChoice = "white" | "black" | "either"
type Phase = "intro" | "playing"

function legalDests(fen: string): Map<Key, Key[]> {
  const setup = parseFen(fen)
  if (setup.isErr) return new Map()
  const pos = Chess.fromSetup(setup.unwrap())
  if (pos.isErr) return new Map()
  return chessgroundDests(pos.unwrap()) as Map<Key, Key[]>
}

export function SparTab() {
  const [phase, setPhase] = useState<Phase>("intro")
  const [book, setBook] = useState<RivalBook | null>(null)
  const [bookError, setBookError] = useState<string | null>(null)
  const [side, setSide] = useState<SideChoice>("either")
  // Opponent strength; set on the intro screen, fixed for the duration of a game.
  const [level, setLevel] = useState<number>(DEFAULT_LEVEL)

  const [entry, setEntry] = useState<RivalBookEntry | null>(null)
  const [userColor, setUserColor] = useState<SparColor>("white")
  const [startFen, setStartFen] = useState<string>("")
  const [fen, setFen] = useState<string>("")
  const [plies, setPlies] = useState<SparPly[]>([])
  const [thinking, setThinking] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [boardNonce, setBoardNonce] = useState(0)

  // The FEN a rival reply is being computed for — so a stale async result (after
  // a take-back / new game) is discarded instead of applied to a moved board.
  const pendingFenRef = useRef<string | null>(null)

  const rivalColor: SparColor = userColor === "white" ? "black" : "white"
  const status = useMemo(() => (fen ? sparStatus(fen) : { over: false, label: null }), [fen])

  // Load the book once on mount.
  useEffect(() => {
    let live = true
    loadRivalBook()
      .then((b) => live && setBook(b))
      .catch((e) => live && setBookError(String(e)))
    return () => {
      live = false
    }
  }, [])

  const startGame = useCallback(() => {
    if (!book) return
    const picked = pickBookEntry(book.entries, Math.random, {
      userColor: side === "either" ? undefined : side,
    })
    if (!picked) {
      setBookError("The rival book has no lines for that side yet.")
      return
    }
    pendingFenRef.current = null
    setEntry(picked)
    setUserColor(userColorForEntry(picked))
    setStartFen(picked.fen)
    setFen(picked.fen)
    setPlies([])
    setThinking(false)
    setMoveError(null)
    setBoardNonce((n) => n + 1)
    setPhase("playing")
  }, [book, side])

  // Drive the rival's reply whenever it's their turn at the live tip.
  useEffect(() => {
    if (phase !== "playing" || !fen) return
    if (turnOf(fen) !== rivalColor) return
    if (sparStatus(fen).over) return

    let live = true
    pendingFenRef.current = fen
    setThinking(true)
    setMoveError(null)
    maiaMove(fen, level)
      .then((mv) => {
        // Discard if the board moved on (take-back / new game) while we waited.
        if (!live || pendingFenRef.current !== fen) return
        const ply = applyUci(fen, mv.uci)
        if (!ply) {
          setMoveError(`Opponent returned an illegal move (${mv.uci}).`)
          return
        }
        setPlies((prev) => [...prev, ply])
        setFen(ply.fen)
      })
      .catch((e) => {
        if (!live || pendingFenRef.current !== fen) return
        setMoveError(humanizeMoveError(String(e)))
      })
      .finally(() => {
        if (live && pendingFenRef.current === fen) setThinking(false)
      })
    return () => {
      live = false
    }
  }, [phase, fen, rivalColor, level])

  const userToMove = phase === "playing" && !!fen && turnOf(fen) === userColor && !status.over
  const legalMoves = useMemo(
    () => (userToMove && !thinking ? legalDests(fen) : new Map<Key, Key[]>()),
    [userToMove, thinking, fen],
  )

  const onBoardMove = useCallback(
    (from: Key, to: Key) => {
      if (!userToMove || thinking) return
      const uci = dragToUci(fen, from as string, to as string)
      const ply = applyUci(fen, uci)
      if (!ply) return
      setPlies((prev) => [...prev, ply])
      setFen(ply.fen)
    },
    [userToMove, thinking, fen],
  )

  // Take back to the user's previous turn: drop the rival's reply and the user's
  // move. Disabled mid-think.
  const takeBack = useCallback(() => {
    if (thinking || plies.length === 0) return
    pendingFenRef.current = null
    const next = plies.slice()
    next.pop()
    while (next.length > 0 && turnOf(next[next.length - 1].fen) !== userColor) next.pop()
    const revertFen = next.length > 0 ? next[next.length - 1].fen : startFen
    setPlies(next)
    setFen(revertFen)
    setThinking(false)
    setMoveError(null)
    setBoardNonce((n) => n + 1)
  }, [thinking, plies, userColor, startFen])

  const lastShape = useMemo<DrawShape[]>(() => {
    if (plies.length === 0) return []
    const uci = plies[plies.length - 1].uci
    return [{ orig: uci.slice(0, 2) as Key, dest: uci.slice(2, 4) as Key, brush: "green" }]
  }, [plies])

  if (phase === "intro") {
    return (
      <SparIntro
        side={side}
        setSide={setSide}
        level={level}
        setLevel={setLevel}
        onStart={startGame}
        canStart={!!book}
        bookError={bookError}
        book={book}
      />
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="spar-playing">
      <div className="px-6 py-3 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">Sparring</span>
          <span className="text-xs text-muted-foreground" data-testid="spar-label">
            a ~{level} playing {RIVAL_LABEL.toLowerCase()}&apos;s openings
          </span>
        </div>
        <span
          className={`inline-block px-2.5 py-1 rounded-md text-xs font-medium ${
            userColor === "white"
              ? "bg-white/90 text-black"
              : "bg-black/80 text-white border border-white/20"
          }`}
        >
          You play {userColor === "white" ? "White" : "Black"}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex gap-8 p-6">
        <div className="flex-1 min-w-0 flex items-center justify-center" data-testid="spar-board">
          <Board
            key={boardNonce}
            fen={fen}
            orientation={userColor}
            movableColor={userColor}
            onMove={onBoardMove}
            legalMoves={legalMoves}
            autoShapes={lastShape}
            viewOnly={!userToMove}
          />
        </div>

        <div className="w-72 shrink-0 flex flex-col gap-4 overflow-auto">
          {entry && (
            <div className="text-sm">
              <div className="text-muted-foreground">Opening (from {RIVAL_LABEL.toLowerCase()}&apos;s games)</div>
              <div className="font-mono text-foreground mt-0.5" data-testid="spar-line">
                {entry.line}
              </div>
            </div>
          )}

          <div className="text-sm" data-testid="spar-turn">
            {status.over ? (
              <span className="text-amber-300 font-medium" data-testid="spar-status">
                {status.label}
              </span>
            ) : thinking ? (
              <span className="text-muted-foreground" data-testid="spar-thinking">
                {RIVAL_LABEL} is thinking…
              </span>
            ) : userToMove ? (
              <span className="text-emerald-300">Your move.</span>
            ) : (
              <span className="text-muted-foreground">Waiting…</span>
            )}
          </div>

          <MoveList plies={plies} userColor={userColor} rivalLabel={RIVAL_LABEL} />

          {moveError && (
            <p className="text-xs text-red-400" data-testid="spar-error">
              {moveError}
            </p>
          )}

          <div className="mt-auto pt-2 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={takeBack}
              disabled={thinking || plies.length === 0}
              data-testid="spar-takeback"
            >
              Take back
            </Button>
            <Button size="sm" onClick={startGame} data-testid="spar-newgame">
              New game
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function MoveList({
  plies,
  userColor,
  rivalLabel,
}: {
  plies: SparPly[]
  userColor: SparColor
  rivalLabel: string
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 flex-1 min-h-0 overflow-auto">
      <div className="text-xs font-semibold text-muted-foreground mb-2">Moves</div>
      {plies.length === 0 ? (
        <p className="text-xs text-muted-foreground">No moves yet — make yours.</p>
      ) : (
        <ol className="space-y-0.5 text-sm" data-testid="spar-movelist">
          {plies.map((p, i) => {
            // Who played ply i: at the start of this game the user is to move,
            // so even indices are the user's, odd are the rival's.
            const mover = i % 2 === 0 ? "you" : "rival"
            const who = mover === "you" ? "You" : rivalLabel
            const color = mover === "you" ? "text-foreground" : "text-sky-300/90"
            return (
              <li key={i} className="flex items-baseline gap-2">
                <span className={`w-10 shrink-0 text-xs ${color}`}>{who}</span>
                <span className="font-mono">{p.san}</span>
              </li>
            )
          })}
        </ol>
      )}
      <span className="sr-only">{userColor}</span>
    </div>
  )
}

function SparIntro({
  side,
  setSide,
  level,
  setLevel,
  onStart,
  canStart,
  bookError,
  book,
}: {
  side: SideChoice
  setSide: (s: SideChoice) => void
  level: number
  setLevel: (n: number) => void
  onStart: () => void
  canStart: boolean
  bookError: string | null
  book: RivalBook | null
}) {
  const sides: { id: SideChoice; label: string }[] = [
    { id: "either", label: "Either" },
    { id: "white", label: "White" },
    { id: "black", label: "Black" },
  ]
  return (
    <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6" data-testid="spar-intro">
      <div className="max-w-xl w-full space-y-5">
        <div>
          <h1 className="text-2xl font-bold">Spar vs {RIVAL_LABEL} (beta)</h1>
          <p className="text-muted-foreground mt-1">
            Play a game that starts from one of {RIVAL_LABEL.toLowerCase()}&apos;s real openings, against{" "}
            <span className="text-foreground">a ~{level}</span> playing his lines. The opponent
            isn&apos;t {RIVAL_LABEL.toLowerCase()} — it&apos;s a Maia human-move model at that
            strength, opening the way he does.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">You play:</span>
          <div className="flex gap-1">
            {sides.map((s) => (
              <button
                key={s.id}
                data-testid={`spar-side-${s.id}`}
                onClick={() => setSide(s.id)}
                className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                  side === s.id
                    ? "border-white/30 bg-white/10 text-foreground"
                    : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Strength:</span>
          <div className="flex gap-1">
            {LEVEL_OPTIONS.map((n) => (
              <button
                key={n}
                data-testid={`spar-level-${n}`}
                onClick={() => setLevel(n)}
                className={`px-3 py-1.5 text-sm rounded-md border transition-colors tabular-nums ${
                  level === n
                    ? "border-white/30 bg-white/10 text-foreground"
                    : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground -mt-2">
          Dad&apos;s FIDE-listed standard is ~1591; family lore says higher. Start at{" "}
          {DEFAULT_LEVEL} and dial to match what you see over a few games.
        </p>

        <Button onClick={onStart} size="lg" className="w-full" disabled={!canStart} data-testid="spar-start">
          {canStart ? "Start sparring game" : "Loading rival book…"}
        </Button>

        {book?.stats?.positions != null && (
          <p className="text-xs text-muted-foreground text-center">
            {book.stats.positions} book positions from {RIVAL_LABEL.toLowerCase()}&apos;s games.
          </p>
        )}
        {bookError && (
          <p className="text-sm text-red-400" data-testid="spar-book-error">
            {bookError}
          </p>
        )}
      </div>
    </div>
  )
}

/** Turn a raw backend error into a one-liner the sparring UI can show. */
function humanizeMoveError(err: string): string {
  if (err.includes("lc0 not found")) {
    return "lc0 isn't installed — Spar vs rival needs it (brew install lc0)."
  }
  if (err.includes("terminal")) return "No legal moves — the game is over."
  return `Opponent move failed: ${err}`
}

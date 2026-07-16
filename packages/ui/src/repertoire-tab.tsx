"use client"

// Opening repertoire drill (spec 900 backlog "Opening repertoire builder").
//
// Setup screen: build (or rebuild) the repertoire from a PGN of the user's
// own games — the file input reads the text in-page (the puzzles-tab import
// pattern), extraction is pure TS (lib/repertoire.ts), and the result
// persists to local storage. The username is guessed from the headers
// (most frequent player name) and editable before building.
//
// Drill session: the deck is due reviews first, then new cards
// (lib/repertoire.buildRepertoireDeck). Each card shows the position with
// the user to move and asks for THEIR repertoire move; grading is
// FEN-identity against the expected move (castling/promotion encodings
// can differ in UCI, the resulting position can't). No engine involved —
// the exercise is remembering your own line, not finding the best move.
// Results feed the spaced-repetition schedule in lib/repertoire-results.ts
// (success ladder 1/3/7/16/35/90d, failure due immediately).

import { useCallback, useEffect, useMemo, useState } from "react"
import dynamic from "next/dynamic"
import type { Key } from "@lichess-org/chessground/types"
import type { DrawShape } from "@lichess-org/chessground/draw"
import { Chess } from "chessops/chess"
import { parseFen } from "chessops/fen"
import { chessgroundDests } from "chessops/compat"
import { Button } from "@chessgui/ui/ui/button"
import { Input } from "@chessgui/ui/ui/input"
import { applyUci, dragToUci, type SparColor } from "@/lib/spar"
import {
  buildRepertoireDeck,
  DEFAULT_REPERTOIRE_DECK_SIZE,
  extractRepertoire,
  guessUsername,
  loadRepertoire,
  persistRepertoire,
  REPERTOIRE_MAX_PLY,
  repertoireQueueCounts,
  type Repertoire,
  type RepertoireDeckItem,
} from "@/lib/repertoire"
import {
  appendRepertoireResult,
  buildRepertoireResult,
  cardSchedules,
  loadRepertoireResults,
  persistRepertoireResults,
  reviewIntervalDays,
} from "@/lib/repertoire-results"

const Board = dynamic(() => import("@chessgui/ui/board").then((m) => ({ default: m.Board })), {
  ssr: false,
})

function legalDests(fen: string): Map<Key, Key[]> {
  const setup = parseFen(fen)
  if (setup.isErr) return new Map()
  const pos = Chess.fromSetup(setup.unwrap())
  if (pos.isErr) return new Map()
  return chessgroundDests(pos.unwrap()) as Map<Key, Key[]>
}

function arrow(uci: string, brush: string): DrawShape {
  return { orig: uci.slice(0, 2) as Key, dest: uci.slice(2, 4) as Key, brush }
}

type Stage = "solve" | "result"

export function RepertoireTab() {
  // ------------------------------------------------------------------ setup
  const [repertoire, setRepertoire] = useState<Repertoire | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [queue, setQueue] = useState<{ due: number; fresh: number; later: number }>({
    due: 0,
    fresh: 0,
    later: 0,
  })
  const [color, setColor] = useState<SparColor | null>(null)
  const [count, setCount] = useState(DEFAULT_REPERTOIRE_DECK_SIZE)
  const [buildError, setBuildError] = useState<string | null>(null)

  // Pending PGN text from the file picker, awaiting a username + "Build".
  const [pgnText, setPgnText] = useState<string | null>(null)
  const [pgnName, setPgnName] = useState<string | null>(null)
  const [username, setUsername] = useState("")

  // Read the stores in an effect (not render) so the static-export
  // prerender stays empty — the puzzles-tab convention.
  const refresh = useCallback(() => {
    const rep = loadRepertoire()
    setRepertoire(rep)
    setQueue(repertoireQueueCounts(rep?.cards ?? [], loadRepertoireResults()))
    setLoaded(true)
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = "" // allow re-picking the same file
    if (!file) return
    file
      .text()
      .then((text) => {
        setPgnText(text)
        setPgnName(file.name)
        setUsername(guessUsername(text) ?? "")
        setBuildError(null)
      })
      .catch(() => setBuildError("Could not read that file."))
  }

  const build = () => {
    if (!pgnText) return
    const rep = extractRepertoire(pgnText, username)
    if (rep.gamesUsed === 0) {
      setBuildError(`No games with "${username.trim()}" as a player in that PGN.`)
      return
    }
    if (rep.cards.length === 0) {
      setBuildError(
        `Found ${rep.gamesUsed} games but no repeated opening positions — a repertoire needs positions you reached at least twice.`,
      )
      return
    }
    rep.source = pgnName
    persistRepertoire(rep)
    setPgnText(null)
    setPgnName(null)
    setBuildError(null)
    refresh()
  }

  // ---------------------------------------------------------------- session
  const [deck, setDeck] = useState<RepertoireDeckItem[] | null>(null)
  const [idx, setIdx] = useState(0)
  const [nCorrect, setNCorrect] = useState(0)
  const [stage, setStage] = useState<Stage>("solve")
  const [fen, setFen] = useState("")
  const [lastCorrect, setLastCorrect] = useState(false)
  const [reviewNote, setReviewNote] = useState<string | null>(null)
  const [shapes, setShapes] = useState<DrawShape[]>([])
  const [boardNonce, setBoardNonce] = useState(0)

  const item = deck && idx < deck.length ? deck[idx] : null
  const sessionOver = deck !== null && idx >= deck.length

  const startDeck = () => {
    if (!repertoire) return
    const items = buildRepertoireDeck(repertoire.cards, loadRepertoireResults(), {
      count,
      color,
    })
    if (items.length === 0) {
      setBuildError("Nothing to drill right now — every card is scheduled for later.")
      return
    }
    setBuildError(null)
    setDeck(items)
    setIdx(0)
    setNCorrect(0)
    setStage("solve")
    setFen(items[0].card.fen)
    setShapes([])
    setReviewNote(null)
    setBoardNonce((n) => n + 1)
  }

  const onBoardMove = useCallback(
    (from: Key, to: Key) => {
      if (!item || stage !== "solve") return
      const card = item.card
      const uci = dragToUci(card.fen, from as string, to as string)
      const played = applyUci(card.fen, uci)
      if (!played) return
      const expected = applyUci(card.fen, card.expectedUci)
      // FEN identity, not UCI equality: castling drags (king-onto-rook vs
      // two-squares) encode differently but land on the same position.
      const correct = expected !== null && played.fen === expected.fen
      setLastCorrect(correct)
      if (correct) {
        setFen(played.fen)
        setShapes([arrow(card.expectedUci, "green")])
      } else {
        // Stay on the card's position: your move in red, your line in green.
        setFen(card.fen)
        setShapes([arrow(uci, "red"), arrow(card.expectedUci, "green")])
        setBoardNonce((n) => n + 1)
      }
      const entries = appendRepertoireResult(
        loadRepertoireResults(),
        buildRepertoireResult({ key: card.id, correct }),
      )
      persistRepertoireResults(entries)
      if (correct) {
        setNCorrect((n) => n + 1)
        const streak = cardSchedules(entries).get(card.id)?.streak ?? 1
        const days = reviewIntervalDays(streak)
        setReviewNote(`Comes back for review in ${days} day${days === 1 ? "" : "s"}.`)
      } else {
        setReviewNote("Due again immediately — it leads your next deck.")
      }
      setStage("result")
    },
    [item, stage],
  )

  const nextCard = () => {
    if (!deck) return
    const next = idx + 1
    setIdx(next)
    setStage("solve")
    setShapes([])
    setReviewNote(null)
    if (next < deck.length) setFen(deck[next].card.fen)
    setBoardNonce((n) => n + 1)
  }

  const exitSession = () => {
    setDeck(null)
    refresh()
  }

  const legalMoves = useMemo(
    () => (item && stage === "solve" ? legalDests(item.card.fen) : new Map<Key, Key[]>()),
    [item, stage],
  )

  // ------------------------------------------------------------------------
  // Setup screen (no deck loaded)
  // ------------------------------------------------------------------------
  if (deck === null) {
    return (
      <div
        className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6"
        data-testid="repertoire-setup"
      >
        <div className="max-w-xl w-full space-y-5">
          <div>
            <h1 className="text-2xl font-bold">Repertoire — drill your own lines</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Built from your own games: every opening position you reached more than once
              becomes a card, and the answer is the move you play most often there. Spaced
              repetition keeps the lines you know far apart and the ones you fumble close.
            </p>
          </div>

          {loaded && repertoire && (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-3">
              <div className="text-sm" data-testid="repertoire-stats">
                <span className="font-bold tabular-nums">{repertoire.cards.length}</span>{" "}
                <span className="text-muted-foreground">
                  cards from {repertoire.gamesUsed} of {repertoire.username}&apos;s games
                  {repertoire.source ? ` (${repertoire.source})` : ""} — first{" "}
                  {REPERTOIRE_MAX_PLY / 2} moves.
                </span>
              </div>
              <p className="text-xs text-muted-foreground tabular-nums" data-testid="repertoire-queue">
                {queue.due > 0 ? (
                  <span className="text-amber-300">{queue.due} due for review</span>
                ) : (
                  <span>0 due</span>
                )}
                {" · "}
                {queue.fresh} new{" · "}
                {queue.later} scheduled later
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground mr-1">Colour:</span>
                <ColorChip label="Both" active={color === null} onClick={() => setColor(null)} testid="repertoire-color-both" />
                <ColorChip label="White" active={color === "white"} onClick={() => setColor("white")} testid="repertoire-color-white" />
                <ColorChip label="Black" active={color === "black"} onClick={() => setColor("black")} testid="repertoire-color-black" />
              </div>
              <div className="flex items-end gap-3">
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Cards</span>
                  <Input
                    type="number"
                    min={1}
                    max={50}
                    value={count}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10)
                      if (Number.isFinite(n)) setCount(Math.min(Math.max(n, 1), 50))
                    }}
                    className="w-20 tabular-nums"
                    data-testid="repertoire-count"
                  />
                </label>
                <Button onClick={startDeck} data-testid="repertoire-start">
                  Start drill
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-2">
            <div className="text-sm font-semibold">
              {repertoire ? "Rebuild from your games" : "Build from your games"}
            </div>
            <p className="text-xs text-muted-foreground">
              Load a PGN of your own games (a chess.com or lichess export). Rebuilding keeps
              your review history — cards are keyed by position.
            </p>
            <label className="inline-flex">
              <input
                type="file"
                accept=".pgn,application/x-chess-pgn,text/plain"
                onChange={onFilePicked}
                className="hidden"
                data-testid="repertoire-import-file"
              />
              <span className="cursor-pointer inline-flex items-center px-3 h-8 rounded-md border border-input bg-transparent text-sm hover:bg-white/5">
                Load games (PGN)…
              </span>
            </label>
            {pgnText && (
              <div className="flex items-end gap-3 pt-1">
                <label className="space-y-1 text-xs text-muted-foreground flex-1">
                  <span>Your name in the PGN headers{pgnName ? ` (${pgnName})` : ""}</span>
                  <Input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    data-testid="repertoire-username"
                  />
                </label>
                <Button onClick={build} disabled={!username.trim()} data-testid="repertoire-build">
                  Build repertoire
                </Button>
              </div>
            )}
            {buildError && (
              <p className="text-sm text-red-400" data-testid="repertoire-error">
                {buildError}
              </p>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ------------------------------------------------------------------------
  // Session summary
  // ------------------------------------------------------------------------
  if (sessionOver) {
    return (
      <div
        className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6"
        data-testid="repertoire-summary"
      >
        <div className="max-w-md w-full space-y-4 text-center">
          <h1 className="text-2xl font-bold">Drill done</h1>
          <p className="text-4xl font-bold tabular-nums" data-testid="repertoire-summary-score">
            {nCorrect}/{deck.length}
          </p>
          <p className="text-sm text-muted-foreground">
            {nCorrect === deck.length
              ? "Every line remembered — the intervals stretch out."
              : "Missed lines are due immediately and lead your next deck."}
          </p>
          <div className="flex gap-2 justify-center">
            <Button onClick={startDeck} data-testid="repertoire-again">
              Another drill
            </Button>
            <Button variant="outline" onClick={exitSession} data-testid="repertoire-exit">
              Done
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ------------------------------------------------------------------------
  // Drill
  // ------------------------------------------------------------------------
  const card = item!.card
  const moverLabel = card.color === "white" ? "White" : "Black"
  return (
    <div className="h-full flex flex-col" data-testid="repertoire-session">
      <div className="px-6 py-3 border-b border-white/10 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-medium shrink-0">Repertoire</span>
          <span className="text-xs text-muted-foreground tabular-nums" data-testid="repertoire-progress">
            Card {idx + 1} of {deck.length} · move {Math.floor(card.ply / 2) + 1}
            {item!.review ? " · review" : " · new"}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={exitSession} data-testid="repertoire-session-exit">
          Exit drill
        </Button>
      </div>

      <div className="flex-1 min-h-0 flex gap-8 p-6">
        <div
          className="flex-1 min-w-0 flex items-center justify-center"
          data-testid="repertoire-board"
          data-fen={fen}
        >
          <Board
            key={boardNonce}
            fen={fen}
            orientation={card.color}
            movableColor={card.color}
            onMove={onBoardMove}
            legalMoves={legalMoves}
            autoShapes={shapes}
            viewOnly={stage !== "solve"}
          />
        </div>

        <div className="w-80 shrink-0 flex flex-col gap-4 overflow-auto">
          <div className="text-sm" data-testid="repertoire-prompt">
            {stage === "solve" && (
              <span className="text-emerald-300">
                What does your repertoire play here? You play {moverLabel}.
              </span>
            )}
          </div>

          {stage === "result" && (
            <div
              className={`rounded-lg border p-3 space-y-1.5 ${
                lastCorrect
                  ? "border-emerald-500/30 bg-emerald-500/[0.07]"
                  : "border-red-500/30 bg-red-500/[0.07]"
              }`}
              data-testid="repertoire-result"
              data-correct={lastCorrect}
            >
              <div className={`text-sm font-bold ${lastCorrect ? "text-emerald-300" : "text-red-300"}`}>
                {lastCorrect ? "That's your line" : `Your repertoire plays ${card.expectedSan}`}
              </div>
              <p className="text-xs text-muted-foreground">
                You chose {card.expectedSan} in {card.timesPlayed} of the {card.timesReached} games
                that reached this position.
                {!lastCorrect &&
                  " Your move may be playable — this drill is about knowing your own book."}
              </p>
              {reviewNote && (
                <p className="text-xs text-muted-foreground" data-testid="repertoire-review-note">
                  {reviewNote}
                </p>
              )}
              <Button size="sm" onClick={nextCard} data-testid="repertoire-next" className="mt-1">
                {idx + 1 < deck.length ? "Next card" : "Finish drill"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ColorChip({
  label,
  active,
  onClick,
  testid,
}: {
  label: string
  active: boolean
  onClick: () => void
  testid: string
}) {
  return (
    <button
      data-testid={testid}
      onClick={onClick}
      className={`px-2 py-1 text-xs rounded-md border transition-colors ${
        active
          ? "border-white/30 bg-white/10 text-foreground"
          : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
      }`}
    >
      {label}
    </button>
  )
}

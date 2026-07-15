"use client"

// Spar vs rival — the Learn view's Tier-0 persona sparring (spec 214).
//
// You play a full game against lc0+Maia at a fixed ~1700, starting from one of
// dad's real opening lines (weighted-sampled from data/rivals/dad_book.json).
// While the position is in the rival's book the reply comes from that book (this
// file, untouched); out of book the reply comes from the `persona_move` command
// (persona engine v1, spec 214 contract steps 3+4+8+9) — seeded sampling from the
// Maia human policy with a Stockfish verification reweight, never noise-weakening
// an engine to fake it (spec 214 hard rule). Each out-of-book move's decision log
// is stored locally (private data). Honest label: "a ~1700 playing dad's
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  personaMove,
  DEFAULT_PERSONA_PARAMS,
  type PersonaDecision,
} from "@/lib/persona"
import {
  buildRoster,
  initialsFor,
  type Participant,
} from "@/lib/roster"
import {
  loadRivalBook,
  pickBookEntry,
  userColorForEntry,
  type RivalBook,
  type RivalBookEntry,
} from "@/lib/rival-book"
import {
  buildRivalMoveMap,
  lookupRivalReply,
  replySanToUci,
  START_FEN,
  type RivalMoveMap,
} from "@/lib/rival-book-lookup"
import {
  applyUci,
  dragToUci,
  DRAW_OFFER_RULE_DESCRIPTION,
  evaluateDrawOffer,
  sparStatus,
  turnOf,
  type SparColor,
  type SparPly,
} from "@/lib/spar"

const Board = dynamic(() => import("@/components/board").then((m) => ({ default: m.Board })), {
  ssr: false,
})

// Adjustable strength (spec 214, Tier 0). Dad's FIDE-listed standard is 1591
// (2024 conversion of his Icelandic national rating), below the family-lore
// ~1750 — so the level is dial-able and the label always states the chosen
// number honestly. 100-Elo Maia bands; all are published nets.
const DEFAULT_LEVEL = 1700
const LEVEL_OPTIONS = [1500, 1600, 1700, 1800, 1900] as const

type SideChoice = "white" | "black" | "either"
// Roster (spec 218 "Roster" checklist item): "roster" is the card browser
// that replaced the old single-rival "intro" screen; "config" is the
// per-participant options screen (side/level/opening/mode) that used to BE
// "intro", now parameterized by whichever roster entry was picked.
type Phase = "roster" | "config" | "playing"

// Move-by-move rival book (spec 214, "Move-by-move rival book" checklist item,
// supersedes drop-into-line as the default): the game starts at move 1 (or the
// rival's own first move, if he's White) and follows his real games position
// by position; "dropin" is the original behavior, kept as a secondary option.
type BookStartMode = "movebymove" | "dropin"
const DEFAULT_BOOK_START_MODE: BookStartMode = "movebymove"

// Spar modes + game controls (spec 214, user request): "Serious spar" counts;
// "Improve his personality" (probe) is the stop→feedback→retry loop and adds
// an End game button that aborts with no result recorded anywhere.
type SparGameMode = "serious" | "probe"
const DEFAULT_SPAR_MODE: SparGameMode = "serious"

// Realism feedback capture (spec 214, "Realism feedback capture" checklist
// item, user request): "felt like him" / "didn't feel like him", tappable at
// any point during or after a game. This is the ground-truth stream style
// priors are later tuned and validated against — private data, localStorage
// only, never bundled or committed.
type FeedbackVerdict = "felt_like" | "did_not_feel_like"
// How sure the user is of the verdict itself (user: "I can't guarantee he
// would *not* have done this... just didn't feel like him" — a verdict is a
// probability shift, not a veto). Two options only, per the user's own read
// on their sample size ("I'd say gut feel and fairly sure - never certain").
type FeedbackConfidence = "gut" | "fairly_sure"
const DEFAULT_CONFIDENCE: FeedbackConfidence = "gut"

interface PersonaFeedbackEntry {
  at: string // ISO date
  rival: string
  level: number
  verdict: FeedbackVerdict
  confidence: FeedbackConfidence
  note: string
  ply: number
  pgn: string
  // Added alongside "Spar modes + game controls" (spec 214) — earlier stored
  // entries predate this field and simply won't have it; treat a missing
  // `mode` as unknown when reading old records back, never as "serious".
  mode: SparGameMode
}

const FEEDBACK_STORAGE_KEY = "spar-persona-feedback"

function appendPersonaFeedback(entry: PersonaFeedbackEntry): void {
  try {
    const raw = localStorage.getItem(FEEDBACK_STORAGE_KEY)
    const existing: PersonaFeedbackEntry[] = raw ? JSON.parse(raw) : []
    existing.push(entry)
    localStorage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(existing))
  } catch {
    // localStorage unavailable / corrupt — the entry just isn't persisted
  }
}

// Per-move decision log (spec 214 persona-engine contract step 9): the
// realism-debugging record for each out-of-book rival move — its candidates with
// policy probs and verification evals, the chosen move, the reason arm, and the
// derived seed. Stored locally like the feedback stream above (private data,
// never bundled/committed), so "didn't feel like him" verdicts can be joined
// against the exact distribution the move was sampled from.
interface PersonaDecisionLogEntry {
  at: string // ISO date
  rival: string
  level: number
  ply: number
  seed: number // the per-game seed the move was sampled under
  fen: string // the position the move was chosen for
  mode: SparGameMode
  decision: PersonaDecision
}

const DECISION_LOG_STORAGE_KEY = "spar-persona-decision-log"

function appendDecisionLog(entry: PersonaDecisionLogEntry): void {
  try {
    const raw = localStorage.getItem(DECISION_LOG_STORAGE_KEY)
    const existing: PersonaDecisionLogEntry[] = raw ? JSON.parse(raw) : []
    existing.push(entry)
    localStorage.setItem(DECISION_LOG_STORAGE_KEY, JSON.stringify(existing))
  } catch {
    // localStorage unavailable / corrupt — the entry just isn't persisted
  }
}

/** A per-game seed for the persona engine's seeded sampling (contract step 8).
 *  Kept below 2^53 so it survives the JSON number round-trip to Rust intact. */
function newGameSeed(): number {
  return Math.floor(Math.random() * 2 ** 53)
}

// SAN move text ("1. e4 e5 2. Nf3 ..."), honoring a book entry's start FEN
// (which may already be mid-game with Black to move) — not a full PGN (no
// tags), just the movetext this feedback record needs.
function sanMoveText(startFen: string, plies: SparPly[]): string {
  const fields = startFen.split(" ")
  let toMove: SparColor = fields[1] === "b" ? "black" : "white"
  let moveNum = parseInt(fields[5] ?? "1", 10) || 1
  const tokens: string[] = []
  for (const p of plies) {
    if (toMove === "white") {
      tokens.push(`${moveNum}.`, p.san)
    } else {
      if (tokens.length === 0) tokens.push(`${moveNum}...`)
      tokens.push(p.san)
      moveNum += 1
    }
    toMove = toMove === "white" ? "black" : "white"
  }
  return tokens.join(" ")
}

function legalDests(fen: string): Map<Key, Key[]> {
  const setup = parseFen(fen)
  if (setup.isErr) return new Map()
  const pos = Chess.fromSetup(setup.unwrap())
  if (pos.isErr) return new Map()
  return chessgroundDests(pos.unwrap()) as Map<Key, Key[]>
}

export function SparTab() {
  const [phase, setPhase] = useState<Phase>("roster")
  const [book, setBook] = useState<RivalBook | null>(null)
  const [bookError, setBookError] = useState<string | null>(null)
  // The roster entry picked from the card browser (spec 218 "Roster"
  // checklist item) — null only while phase === "roster". Fixed for the
  // duration of a game, same as everything below it.
  const [participant, setParticipant] = useState<Participant | null>(null)
  const [side, setSide] = useState<SideChoice>("either")
  // Opponent strength; set on the config screen, fixed for the duration of a
  // game. Only meaningful (and only shown) for participants with a dial-able
  // policy backend — in v1 that's the private rival; every other roster
  // entry carries its own fixed level in personaConfig.
  const [level, setLevel] = useState<number>(DEFAULT_LEVEL)
  // Move-by-move book vs. drop-into-line, and Serious vs. probe — both picked
  // on the config screen, fixed for the duration of a game.
  const [bookStartMode, setBookStartMode] = useState<BookStartMode>(DEFAULT_BOOK_START_MODE)
  const [sparMode, setSparMode] = useState<SparGameMode>(DEFAULT_SPAR_MODE)

  // Roster (spec 218 decision 4): built from the local rival book's load
  // state — his entry exists only when the book actually loaded, no error
  // state for its absence (spec 214 hard rule: his data stays local). Fischer,
  // Kasparov, and the Maia bands are always present.
  const roster = useMemo(() => buildRoster(book), [book])
  // Only the private rival has a move-by-move book and a dial-able level in
  // v1 — every other entry starts from the standard position at its own
  // fixed personaConfig.level (spec 218 decision 4).
  const hasBook = participant?.personaConfig?.book === "rival"
  const effectiveLevel = hasBook ? level : participant?.personaConfig?.level ?? DEFAULT_LEVEL
  const opponentLabel = participant?.displayName ?? "Opponent"
  const canImprove = !!participant?.actions.includes("improve")

  const [entry, setEntry] = useState<RivalBookEntry | null>(null)
  const [userColor, setUserColor] = useState<SparColor>("white")
  // Per-game seed for the persona engine's seeded move sampling (spec 214
  // contract step 8); regenerated on each new game in startGame.
  const [gameSeed, setGameSeed] = useState<number>(() => newGameSeed())
  const [startFen, setStartFen] = useState<string>("")
  const [fen, setFen] = useState<string>("")
  const [plies, setPlies] = useState<SparPly[]>([])
  const [thinking, setThinking] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [boardNonce, setBoardNonce] = useState(0)
  // Whether the last rival reply came from the book or from Maia (move-by-move
  // mode only) — an honest "in book / out of book" readout, null before the
  // rival's first move of the game.
  const [bookStatus, setBookStatus] = useState<"book" | "maia" | null>(null)

  // Spar modes + game controls (spec 214): a probe-mode abort (no result,
  // ever), and a manual end (resign / draw agreed) that overrides the
  // position-derived status below. Both freeze the board; neither is a
  // position-derived game end.
  const [probeEnded, setProbeEnded] = useState(false)
  const [manualEnd, setManualEnd] = useState<{ label: string } | null>(null)
  // Draw offers: the ply count at the last offer (spam guard, one per 10
  // plies) and a brief "declined" note.
  const [lastDrawOfferPly, setLastDrawOfferPly] = useState<number | null>(null)
  const [drawDeclinedNote, setDrawDeclinedNote] = useState(false)
  const drawDeclinedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(drawDeclinedTimer.current), [])

  // Realism feedback capture (spec 214): which verdict's inline form is open
  // (null = closed), its draft note, and a brief post-submit confirmation.
  const [feedbackOpen, setFeedbackOpen] = useState<FeedbackVerdict | null>(null)
  const [feedbackNote, setFeedbackNote] = useState("")
  const [feedbackConfidence, setFeedbackConfidence] = useState<FeedbackConfidence>(DEFAULT_CONFIDENCE)
  const [feedbackConfirm, setFeedbackConfirm] = useState(false)
  const feedbackConfirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(feedbackConfirmTimer.current), [])

  // The FEN a rival reply is being computed for — so a stale async result (after
  // a take-back / new game) is discarded instead of applied to a moved board.
  const pendingFenRef = useRef<string | null>(null)

  // Back/forward review (spec 218 ship-now polish, user request — "wait, what
  // did you do"): review-only, NEVER mutates the live game. null = live (board
  // shows `fen`); -1 = the start position; i = the position after plies[i].
  // Board interaction and the live rival-turn effect key off `fen`/`userToMove`
  // only, so a review cursor can never itself trigger a rival move.
  const [reviewCursor, setReviewCursor] = useState<number | null>(null)
  const reviewing = reviewCursor !== null
  const derivedFen =
    reviewCursor === null ? fen : reviewCursor === -1 ? startFen : plies[reviewCursor]?.fen ?? fen

  // Snap back to live automatically whenever the ply history changes — the
  // opponent's move landing, the user's own move, or a take-back all mean the
  // reviewed position may no longer be the tip (or may no longer exist).
  const priorPliesLengthRef = useRef(plies.length)
  useEffect(() => {
    if (plies.length !== priorPliesLengthRef.current) {
      priorPliesLengthRef.current = plies.length
      setReviewCursor(null)
    }
  }, [plies.length])

  // Step the review cursor by one ply in either direction. Live (null) is
  // treated as sitting at the last ply for stepping purposes; stepping past
  // the last ply snaps back to live rather than going out of range.
  const stepReview = useCallback(
    (delta: number) => {
      if (plies.length === 0) return
      const currentIndex = reviewCursor === null ? plies.length - 1 : reviewCursor
      const next = currentIndex + delta
      if (next >= plies.length - 1) setReviewCursor(null)
      else if (next < -1) setReviewCursor(-1)
      else setReviewCursor(next)
    },
    [plies.length, reviewCursor],
  )
  const goLive = useCallback(() => setReviewCursor(null), [])

  // Arrow-key review stepping. Guarded like the main board's key handler
  // (app/page.tsx): never intercept typing in an editable element (the
  // realism-feedback textarea lives on this same screen).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) {
        return
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        stepReview(-1)
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        stepReview(1)
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [stepReview])

  const rivalColor: SparColor = userColor === "white" ? "black" : "white"
  // A manual end (resign / draw agreed) overrides the position-derived status;
  // a probe abort freezes the board without claiming any result at all.
  const status = useMemo(() => {
    if (manualEnd) return { over: true, label: manualEnd.label }
    return fen ? sparStatus(fen) : { over: false, label: null }
  }, [fen, manualEnd])
  const frozen = status.over || probeEnded

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

  // Move-by-move rival book (spec 214): the position->reply lookup, one map
  // per rival colour, precomputed once when the book loads (not per game
  // start, and not per move). Gated on hasBook so a non-rival roster entry
  // never plays from the rival's book even though `book` stays loaded in
  // state for roster-membership purposes.
  const moveMaps = useMemo(() => {
    if (!hasBook || !book) return null
    return {
      white: buildRivalMoveMap(book.entries, "white"),
      black: buildRivalMoveMap(book.entries, "black"),
    }
  }, [hasBook, book])

  const startGame = useCallback(() => {
    if (!participant) return
    if (hasBook && !book) return
    pendingFenRef.current = null
    setThinking(false)
    setMoveError(null)
    setBookStatus(null)
    setProbeEnded(false)
    setManualEnd(null)
    setLastDrawOfferPly(null)
    setDrawDeclinedNote(false)
    setReviewCursor(null)
    setGameSeed(newGameSeed())

    // Non-book roster entries (every bot but the private rival, spec 218
    // decision 4) always start at move 1 with no book — the same code path
    // "movebymove" already falls into once moveMaps is null.
    if (!hasBook || bookStartMode === "movebymove") {
      // Spec 214 "Move-by-move rival book": start at move 1. If the user's
      // requested side would put the rival on White, his own first move
      // fires immediately once phase flips to "playing" (the rival-turn
      // effect below fires on any `fen` value where it's rivalColor's move,
      // including the very first one).
      const chosenUserColor: SparColor =
        side === "either" ? (Math.random() < 0.5 ? "white" : "black") : side
      setEntry(null)
      setUserColor(chosenUserColor)
      setStartFen(START_FEN)
      setFen(START_FEN)
      setPlies([])
      setBoardNonce((n) => n + 1)
      setPhase("playing")
      return
    }

    // Drop-into-line (rival only, the original behavior, kept as a secondary
    // option).
    const picked = pickBookEntry(book!.entries, Math.random, {
      userColor: side === "either" ? undefined : side,
    })
    if (!picked) {
      setBookError("The rival book has no lines for that side yet.")
      return
    }
    setEntry(picked)
    setUserColor(userColorForEntry(picked))
    setStartFen(picked.fen)
    setFen(picked.fen)
    setPlies([])
    setBoardNonce((n) => n + 1)
    setPhase("playing")
  }, [participant, hasBook, book, side, bookStartMode])

  // Drive the rival's reply whenever it's their turn at the live tip: an
  // exact-position book lookup first (move-by-move mode only), Maia otherwise
  // — "while the position matches the rival's real games the persona replies
  // with his recorded reply, then Maia takes over out of book" (spec 214).
  // The lookup is a plain map read, so this re-checks fresh every rival turn
  // rather than latching "out of book" permanently — a take-back (or even a
  // coincidental transposition) that lands back on a book node is honored.
  useEffect(() => {
    if (phase !== "playing" || !fen) return
    if (turnOf(fen) !== rivalColor) return
    if (frozen) return

    if (bookStartMode === "movebymove" && moveMaps) {
      const map = rivalColor === "white" ? moveMaps.white : moveMaps.black
      const reply = lookupRivalReply(map, fen, Math.random)
      if (reply) {
        const uci = replySanToUci(fen, reply.san)
        const ply = uci ? applyUci(fen, uci) : null
        if (ply) {
          pendingFenRef.current = null
          setBookStatus("book")
          setPlies((prev) => [...prev, ply])
          setFen(ply.fen)
          return
        }
        // A malformed/stale entry (SAN didn't parse or apply here) — fall
        // through to Maia below rather than getting stuck.
      }
    }

    let live = true
    pendingFenRef.current = fen
    setThinking(true)
    setMoveError(null)
    setBookStatus(bookStartMode === "movebymove" ? "maia" : null)
    // The half-move index this reply occupies — the RNG seeds off (gameSeed, ply)
    // so the same seed reproduces the same move (spec 214 contract step 8).
    const movePly = plies.length
    personaMove(fen, {
      ...DEFAULT_PERSONA_PARAMS,
      level: effectiveLevel,
      seed: gameSeed,
      ply: movePly,
    })
      .then((decision) => {
        // Discard if the board moved on (take-back / new game) while we waited.
        if (!live || pendingFenRef.current !== fen) return
        const ply = applyUci(fen, decision.uci)
        if (!ply) {
          setMoveError(`Opponent returned an illegal move (${decision.uci}).`)
          return
        }
        // Stash the per-move decision log locally (private data, contract step
        // 9) — best-effort, never blocks the move.
        appendDecisionLog({
          at: new Date().toISOString(),
          rival: opponentLabel,
          level: effectiveLevel,
          ply: movePly,
          seed: gameSeed,
          fen,
          mode: sparMode,
          decision,
        })
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
  }, [
    phase,
    fen,
    rivalColor,
    effectiveLevel,
    opponentLabel,
    frozen,
    bookStartMode,
    moveMaps,
    gameSeed,
    plies.length,
    sparMode,
  ])

  const userToMove = phase === "playing" && !!fen && turnOf(fen) === userColor && !frozen
  const legalMoves = useMemo(
    () => (userToMove && !thinking && !reviewing ? legalDests(fen) : new Map<Key, Key[]>()),
    [userToMove, thinking, fen, reviewing],
  )

  const onBoardMove = useCallback(
    (from: Key, to: Key) => {
      if (!userToMove || thinking || reviewing) return
      const uci = dragToUci(fen, from as string, to as string)
      const ply = applyUci(fen, uci)
      if (!ply) return
      setPlies((prev) => [...prev, ply])
      setFen(ply.fen)
    },
    [userToMove, thinking, reviewing, fen],
  )

  // Take back to the user's previous turn: drop the rival's reply and the
  // user's move. Disabled mid-think. If the game is frozen by a manual end
  // (resign / draw agreed) or a probe abort, Take back's first job is to undo
  // THAT — neither one consumed a ply, so it just resumes at the same position.
  const takeBack = useCallback(() => {
    if (thinking) return
    if (manualEnd || probeEnded) {
      pendingFenRef.current = null
      setManualEnd(null)
      setProbeEnded(false)
      setMoveError(null)
      return
    }
    if (plies.length === 0) return
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
  }, [thinking, plies, userColor, startFen, manualEnd, probeEnded])

  // Resign / offer draw (spec 214 "Spar modes + game controls"): available in
  // both Serious and probe modes, always visible during play.
  const resign = useCallback(() => {
    if (frozen || thinking) return
    pendingFenRef.current = null
    const resultTag = userColor === "white" ? "0-1" : "1-0"
    setManualEnd({ label: `You resigned — ${resultTag}` })
  }, [frozen, thinking, userColor])

  // One offer per 10 plies (spam guard). Acceptance is the honest fallback
  // rule (DRAW_OFFER_RULE_DESCRIPTION) — no one-shot engine-eval command
  // exists yet to judge it by eval instead.
  const drawOfferOnCooldown = lastDrawOfferPly !== null && plies.length - lastDrawOfferPly < 10
  const offerDraw = useCallback(() => {
    if (frozen || thinking || drawOfferOnCooldown) return
    setLastDrawOfferPly(plies.length)
    if (evaluateDrawOffer(fen, plies)) {
      setManualEnd({ label: "Draw agreed — ½–½" })
      return
    }
    setDrawDeclinedNote(true)
    clearTimeout(drawDeclinedTimer.current)
    drawDeclinedTimer.current = setTimeout(() => setDrawDeclinedNote(false), 2500)
  }, [frozen, thinking, drawOfferOnCooldown, plies, fen])

  // Probe-mode "End game": aborts instantly, no result recorded anywhere —
  // the board freezes on the current position so the realism-feedback
  // affordance stays usable on it, but status never claims a W/L/D.
  const endGameProbe = useCallback(() => {
    if (probeEnded || status.over) return
    pendingFenRef.current = null
    setThinking(false)
    setMoveError(null)
    setProbeEnded(true)
  }, [probeEnded, status.over])

  // Open (or toggle closed) the inline feedback form for a verdict.
  const toggleFeedback = useCallback((verdict: FeedbackVerdict) => {
    setFeedbackConfirm(false)
    setFeedbackOpen((prev) => {
      if (prev === verdict) return null // clicking the open verdict again closes it
      setFeedbackNote("")
      setFeedbackConfidence(DEFAULT_CONFIDENCE)
      return verdict
    })
  }, [])

  const cancelFeedback = useCallback(() => {
    setFeedbackOpen(null)
    setFeedbackNote("")
    setFeedbackConfidence(DEFAULT_CONFIDENCE)
  }, [])

  const submitFeedback = useCallback(() => {
    if (!feedbackOpen) return
    const note = feedbackNote.trim()
    if (feedbackOpen === "did_not_feel_like" && !note) return // required for the negative
    appendPersonaFeedback({
      at: new Date().toISOString(),
      rival: opponentLabel,
      level: effectiveLevel,
      verdict: feedbackOpen,
      confidence: feedbackConfidence,
      note,
      ply: plies.length,
      pgn: sanMoveText(startFen, plies),
      mode: sparMode,
    })
    setFeedbackOpen(null)
    setFeedbackNote("")
    setFeedbackConfidence(DEFAULT_CONFIDENCE)
    setFeedbackConfirm(true)
    clearTimeout(feedbackConfirmTimer.current)
    feedbackConfirmTimer.current = setTimeout(() => setFeedbackConfirm(false), 2000)
  }, [feedbackOpen, feedbackNote, feedbackConfidence, opponentLabel, effectiveLevel, plies, startFen, sparMode])

  const lastShape = useMemo<DrawShape[]>(() => {
    if (reviewing || plies.length === 0) return []
    const uci = plies[plies.length - 1].uci
    return [{ orig: uci.slice(0, 2) as Key, dest: uci.slice(2, 4) as Key, brush: "green" }]
  }, [plies, reviewing])

  // Roster card browser (spec 218 "Roster" checklist item, decision 5: the
  // card-style browser with avatars belongs here, not the tournament tab).
  if (phase === "roster") {
    return (
      <RosterScreen
        roster={roster}
        onPick={(p, action) => {
          setParticipant(p)
          setSparMode(action === "improve" ? "probe" : "serious")
          setLevel(DEFAULT_LEVEL)
          setBookStartMode(DEFAULT_BOOK_START_MODE)
          setSide("either")
          setPhase("config")
        }}
      />
    )
  }

  // Per-participant options screen (was "intro" when the rival was the only
  // possible opponent) — side, opening, level, and mode, scoped to whichever
  // roster entry was picked.
  if (phase === "config") {
    if (!participant) return null // unreachable: set together with phase above
    return (
      <SparConfig
        participant={participant}
        hasBook={hasBook}
        side={side}
        setSide={setSide}
        level={level}
        setLevel={setLevel}
        bookStartMode={bookStartMode}
        setBookStartMode={setBookStartMode}
        sparMode={sparMode}
        setSparMode={setSparMode}
        canImprove={canImprove}
        onStart={startGame}
        onBack={() => setPhase("roster")}
        canStart={hasBook ? !!book : true}
        bookError={hasBook ? bookError : null}
        book={hasBook ? book : null}
      />
    )
  }

  return (
    <div className="h-full flex flex-col" data-testid="spar-playing">
      <div className="px-6 py-3 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Avatar className="h-6 w-6" data-testid="spar-opponent-avatar">
            {participant?.avatar && <AvatarImage src={participant.avatar} alt={opponentLabel} />}
            <AvatarFallback className="text-[10px]">{initialsFor(opponentLabel)}</AvatarFallback>
          </Avatar>
          <span className="text-sm font-medium">{opponentLabel}</span>
          <span className="text-xs text-muted-foreground" data-testid="spar-label">
            {hasBook
              ? `a ~${effectiveLevel} playing ${opponentLabel.toLowerCase()}'s openings`
              : participant?.strengthLabel}
          </span>
          {sparMode === "probe" && (
            <span
              className="inline-block px-2 py-0.5 rounded-md text-[11px] font-medium bg-violet-400/10 text-violet-300 border border-violet-400/30"
              data-testid="spar-mode-badge"
              title="Improve his personality mode: End game aborts with no result recorded."
            >
              Probe
            </span>
          )}
          {bookStartMode === "movebymove" && bookStatus && (
            <span className="text-[11px] text-muted-foreground" data-testid="spar-book-status">
              {bookStatus === "book" ? "in book" : `out of book — playing like a ~${effectiveLevel}`}
            </span>
          )}
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
        <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-3" data-testid="spar-board">
          <Board
            key={boardNonce}
            fen={derivedFen}
            orientation={userColor}
            movableColor={userColor}
            onMove={onBoardMove}
            legalMoves={legalMoves}
            autoShapes={lastShape}
            viewOnly={!userToMove || reviewing}
          />

          <div className="flex items-center gap-2 h-7">
            <Button
              variant="outline"
              size="sm"
              onClick={() => stepReview(-1)}
              disabled={plies.length === 0}
              title="Step back one ply (←)"
              data-testid="spar-review-back"
            >
              ← Back
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => stepReview(1)}
              disabled={plies.length === 0}
              title="Step forward one ply (→)"
              data-testid="spar-review-forward"
            >
              Forward →
            </Button>
            {reviewing && (
              <>
                <span
                  className="text-xs px-2 py-1 rounded-md bg-amber-400/10 text-amber-300 border border-amber-400/30"
                  data-testid="spar-review-pill"
                >
                  Reviewing move {reviewCursor === -1 ? 0 : reviewCursor! + 1} of {plies.length} —{" "}
                  <button className="underline hover:text-amber-200" onClick={goLive} data-testid="spar-review-live">
                    Live
                  </button>
                </span>
              </>
            )}
          </div>
        </div>

        <div className="w-72 shrink-0 flex flex-col gap-4 overflow-auto">
          {entry && (
            <div className="text-sm">
              <div className="text-muted-foreground">Opening (from {opponentLabel.toLowerCase()}&apos;s games)</div>
              <div className="font-mono text-foreground mt-0.5" data-testid="spar-line">
                {entry.line}
              </div>
            </div>
          )}

          <div className="text-sm" data-testid="spar-turn">
            {probeEnded && !status.over ? (
              // Probe abort: honestly NOT a result — never styled or worded
              // like one (spec 214: "no result, never counts toward metrics").
              <span className="text-violet-300 font-medium" data-testid="spar-probe-ended">
                Game ended (not recorded) — leave feedback below, then start a new game.
              </span>
            ) : status.over ? (
              <span className="text-amber-300 font-medium" data-testid="spar-status">
                {status.label}
              </span>
            ) : thinking ? (
              <span className="text-muted-foreground" data-testid="spar-thinking">
                {opponentLabel} is thinking…
              </span>
            ) : userToMove ? (
              <span className="text-emerald-300">Your move.</span>
            ) : (
              <span className="text-muted-foreground">Waiting…</span>
            )}
          </div>

          {drawDeclinedNote && (
            <p className="text-xs text-muted-foreground" data-testid="spar-draw-declined">
              {opponentLabel} declined the draw offer.
            </p>
          )}

          <MoveList
            plies={plies}
            userColor={userColor}
            startFen={startFen}
            rivalLabel={opponentLabel}
            reviewCursor={reviewCursor}
            onSelectPly={setReviewCursor}
          />

          {moveError && (
            <p className="text-xs text-red-400" data-testid="spar-error">
              {moveError}
            </p>
          )}

          {/* Realism feedback capture (spec 214) — a quiet research affordance,
              tappable any time during or after the game; not a game feature. */}
          <div className="border-t border-white/10 pt-3 flex flex-col gap-2" data-testid="spar-feedback">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Realism:</span>
              <button
                data-testid="spar-feedback-felt"
                onClick={() => toggleFeedback("felt_like")}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  feedbackOpen === "felt_like"
                    ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                    : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
                }`}
              >
                Felt like him
              </button>
              <button
                data-testid="spar-feedback-not"
                onClick={() => toggleFeedback("did_not_feel_like")}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  feedbackOpen === "did_not_feel_like"
                    ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                    : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
                }`}
              >
                Didn&apos;t feel like him
              </button>
            </div>

            {feedbackOpen && (
              <div className="flex flex-col gap-1.5" data-testid="spar-feedback-form">
                <textarea
                  data-testid="spar-feedback-note"
                  className="w-full bg-white/[0.03] border border-white/10 rounded-md px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-1 focus:ring-white/20"
                  rows={3}
                  placeholder={
                    feedbackOpen === "did_not_feel_like"
                      ? "What gave it away? (required)"
                      : "What felt right? (optional)"
                  }
                  value={feedbackNote}
                  onChange={(e) => setFeedbackNote(e.target.value)}
                  autoFocus
                />
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">Confidence:</span>
                  {(["gut", "fairly_sure"] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      data-testid={`spar-feedback-confidence-${c}`}
                      onClick={() => setFeedbackConfidence(c)}
                      className={`px-2 py-0.5 text-[11px] rounded-full border transition-colors ${
                        feedbackConfidence === c
                          ? "border-white/30 bg-white/10 text-foreground"
                          : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
                      }`}
                    >
                      {c === "gut" ? "Gut feel" : "Fairly sure"}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={cancelFeedback} data-testid="spar-feedback-cancel">
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={submitFeedback}
                    disabled={feedbackOpen === "did_not_feel_like" && !feedbackNote.trim()}
                    data-testid="spar-feedback-submit"
                  >
                    Submit
                  </Button>
                </div>
              </div>
            )}

            {feedbackConfirm && (
              <span className="text-xs text-emerald-300/80" data-testid="spar-feedback-confirm">
                Noted.
              </span>
            )}
          </div>

          {/* Resign / offer draw (both modes, always visible during play) +
              End game (probe mode only, aborts with no result recorded) +
              Take back / New game — pinned to the bottom as one block. */}
          <div className="mt-auto pt-2 flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={resign}
                disabled={frozen || thinking}
                data-testid="spar-resign"
              >
                Resign
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={offerDraw}
                disabled={frozen || thinking || drawOfferOnCooldown}
                title={DRAW_OFFER_RULE_DESCRIPTION}
                data-testid="spar-offer-draw"
              >
                Offer draw
              </Button>
              {sparMode === "probe" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={endGameProbe}
                  disabled={probeEnded || status.over}
                  className="border-violet-400/30 text-violet-300 hover:bg-violet-400/10"
                  title="Aborts instantly — no result is recorded anywhere. Feedback below still applies."
                  data-testid="spar-end-game"
                >
                  End game
                </Button>
              )}
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={takeBack}
                disabled={thinking || (plies.length === 0 && !manualEnd && !probeEnded)}
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
    </div>
  )
}

// A move-number row (spec 218 ship-now polish, user request — "for easier
// reference in 'didn't feel like him'", e.g. "12.Nxe5" instead of prose),
// matching the numbered-pairs pattern in components/move-list.tsx (the main
// analysis board's move list). Honors a start FEN that's already mid-game
// (drop-into-line, or a move-by-move start with the rival on White) the same
// way sanMoveText() above does.
interface MoveRow {
  number: number
  white?: { ply: SparPly; index: number }
  black?: { ply: SparPly; index: number }
}

function buildMoveRows(startFen: string, plies: SparPly[]): MoveRow[] {
  const fields = startFen.split(" ")
  let toMove: SparColor = fields[1] === "b" ? "black" : "white"
  let moveNum = parseInt(fields[5] ?? "1", 10) || 1
  const rows: MoveRow[] = []
  let current: MoveRow | null = null
  for (let i = 0; i < plies.length; i++) {
    const p = plies[i]
    if (toMove === "white") {
      current = { number: moveNum, white: { ply: p, index: i } }
      rows.push(current)
    } else {
      if (!current || current.number !== moveNum) {
        current = { number: moveNum }
        rows.push(current)
      }
      current.black = { ply: p, index: i }
      moveNum += 1
    }
    toMove = toMove === "white" ? "black" : "white"
  }
  return rows
}

function MoveEntry({
  ply,
  index,
  isUserPly,
  isCurrent,
  who,
  onSelectPly,
}: {
  ply: SparPly
  index: number
  isUserPly: boolean
  isCurrent: boolean
  who: string
  onSelectPly: (i: number) => void
}) {
  return (
    <span
      title={who}
      onClick={() => onSelectPly(index)}
      className={`font-mono px-1 py-px rounded-sm cursor-pointer ${
        isCurrent
          ? "font-bold text-white bg-amber-400/25"
          : isUserPly
            ? "text-foreground hover:bg-white/5"
            : "text-sky-300/90 hover:bg-white/5"
      }`}
    >
      {ply.san}
    </span>
  )
}

function MoveList({
  plies,
  userColor,
  startFen,
  rivalLabel,
  reviewCursor,
  onSelectPly,
}: {
  plies: SparPly[]
  userColor: SparColor
  /** The game's start position — who's to move here decides who plays ply 0.
   *  Drop-into-line starts always land on the user's turn; a move-by-move
   *  start with the rival on White does NOT (his own first move goes first). */
  startFen: string
  rivalLabel: string
  /** Back/forward review (spec 218): null = live, -1 = start position, i =
   *  the position after plies[i] — highlights the reviewed ply and, when
   *  clicked, jumps the review cursor there without touching the live game. */
  reviewCursor: number | null
  onSelectPly: (i: number) => void
}) {
  const userMovesFirst = turnOf(startFen) === userColor
  const rows = useMemo(() => buildMoveRows(startFen, plies), [startFen, plies])
  const whoFor = (i: number) => ((userMovesFirst ? i % 2 === 0 : i % 2 === 1) ? "You" : rivalLabel)
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 flex-1 min-h-0 overflow-auto">
      <div className="text-xs font-semibold text-muted-foreground mb-2">Moves</div>
      {plies.length === 0 ? (
        <p className="text-xs text-muted-foreground">No moves yet — make yours.</p>
      ) : (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm" data-testid="spar-movelist">
          {rows.map((row) => (
            <div key={row.number} className="flex items-baseline gap-1">
              <span className="text-xs text-muted-foreground font-mono select-none">{row.number}.</span>
              {row.white && (
                <MoveEntry
                  ply={row.white.ply}
                  index={row.white.index}
                  isUserPly={userMovesFirst ? row.white.index % 2 === 0 : row.white.index % 2 === 1}
                  isCurrent={reviewCursor === row.white.index}
                  who={whoFor(row.white.index)}
                  onSelectPly={onSelectPly}
                />
              )}
              {row.black && (
                <MoveEntry
                  ply={row.black.ply}
                  index={row.black.index}
                  isUserPly={userMovesFirst ? row.black.index % 2 === 0 : row.black.index % 2 === 1}
                  isCurrent={reviewCursor === row.black.index}
                  who={whoFor(row.black.index)}
                  onSelectPly={onSelectPly}
                />
              )}
            </div>
          ))}
        </div>
      )}
      <span className="sr-only">{userColor}</span>
    </div>
  )
}

// Roster card browser (spec 218 "Roster" checklist item, decision 5: the
// card-style browser with avatars belongs to Play vs Bot, not the tournament
// tab's dropdown). Every card shows an avatar (initials fallback — spec 218
// "Avatars" checklist item, ships with zero art in v1), the honest strength
// label (spec 216: no unmeasured realism claims), and its action set: Play
// for everyone, Improve profile only where the participant carries it (the
// private rival, v1's only two-action entry).
function RosterScreen({
  roster,
  onPick,
}: {
  roster: Participant[]
  onPick: (p: Participant, action: "play" | "improve") => void
}) {
  return (
    <div className="flex-1 min-h-0 overflow-auto p-6" data-testid="spar-roster">
      <div className="max-w-3xl mx-auto space-y-5">
        <div>
          <h1 className="text-2xl font-bold">Play vs Bot</h1>
          <p className="text-muted-foreground mt-1">
            Pick an opponent. Every card states its honest strength — nothing here
            claims to BE the person it&apos;s modeled on.
          </p>
        </div>

        {roster.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading roster…</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3" data-testid="roster-grid">
            {roster.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-white/10 bg-white/[0.03] p-4 flex flex-col gap-3"
                data-testid={`roster-card-${p.id}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar className="h-10 w-10 shrink-0">
                    {p.avatar && <AvatarImage src={p.avatar} alt={p.displayName} />}
                    <AvatarFallback>{initialsFor(p.displayName)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{p.displayName}</div>
                    <div className="text-xs text-muted-foreground">{p.strengthLabel}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 mt-auto">
                  <Button size="sm" onClick={() => onPick(p, "play")} data-testid={`roster-play-${p.id}`}>
                    Play
                  </Button>
                  {p.actions.includes("improve") && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onPick(p, "improve")}
                      data-testid={`roster-improve-${p.id}`}
                    >
                      Improve profile
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// Per-participant options screen — was SparIntro when the private rival was
// the only possible opponent; now parameterized by whichever roster entry
// was picked. hasBook (only the private rival in v1) gates the level dial
// and the opening-source picker; canImprove (same entry) gates the
// serious/probe mode picker — everyone else plays one fixed-strength,
// book-less, serious-only game (spec 218 decision 4).
function SparConfig({
  participant,
  hasBook,
  side,
  setSide,
  level,
  setLevel,
  bookStartMode,
  setBookStartMode,
  sparMode,
  setSparMode,
  canImprove,
  onStart,
  onBack,
  canStart,
  bookError,
  book,
}: {
  participant: Participant
  hasBook: boolean
  side: SideChoice
  setSide: (s: SideChoice) => void
  level: number
  setLevel: (n: number) => void
  bookStartMode: BookStartMode
  setBookStartMode: (m: BookStartMode) => void
  sparMode: SparGameMode
  setSparMode: (m: SparGameMode) => void
  canImprove: boolean
  onStart: () => void
  onBack: () => void
  canStart: boolean
  bookError: string | null
  book: RivalBook | null
}) {
  const sides: { id: SideChoice; label: string }[] = [
    { id: "either", label: "Either" },
    { id: "white", label: "White" },
    { id: "black", label: "Black" },
  ]
  const opponentLabel = participant.displayName
  return (
    <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6" data-testid="spar-config">
      <div className="max-w-xl w-full space-y-5">
        <div>
          <button
            onClick={onBack}
            className="text-xs text-muted-foreground hover:text-foreground"
            data-testid="spar-config-back"
          >
            ‹ Roster
          </button>
          <h1 className="text-2xl font-bold mt-1">Play vs {opponentLabel}</h1>
          <p className="text-muted-foreground mt-1">
            {hasBook ? (
              <>
                Play a full game against <span className="text-foreground">a ~{level}</span>{" "}
                playing {opponentLabel.toLowerCase()}&apos;s lines — from move 1 with his real
                recorded replies, or dropped into one of his openings. The opponent
                isn&apos;t {opponentLabel.toLowerCase()}
                {" "}— it&apos;s a Maia human-move model at that strength, opening the way he
                does.
              </>
            ) : (
              participant.strengthLabel
            )}
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

        {hasBook ? (
          <>
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
              His FIDE-listed rating is below family lore&apos;s estimate, so the level is
              dial-able. Start at {DEFAULT_LEVEL} and dial to match what you see over a few
              games.
            </p>

            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Opening:</span>
              <div className="flex gap-1">
                {(
                  [
                    ["movebymove", "From move 1 (his book, move by move)"],
                    ["dropin", "Drop into one of his lines"],
                  ] as [BookStartMode, string][]
                ).map(([id, label]) => (
                  <button
                    key={id}
                    data-testid={`spar-book-mode-${id}`}
                    onClick={() => setBookStartMode(id)}
                    className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                      bookStartMode === id
                        ? "border-white/30 bg-white/10 text-foreground"
                        : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="spar-fixed-strength">
            Fixed strength: {participant.strengthLabel}
          </p>
        )}

        {canImprove && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Mode:</span>
            <div className="flex gap-1">
              {(
                [
                  ["serious", "Serious spar"],
                  ["probe", "Improve his personality"],
                ] as [SparGameMode, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  data-testid={`spar-game-mode-${id}`}
                  onClick={() => setSparMode(id)}
                  className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                    sparMode === id
                      ? "border-white/30 bg-white/10 text-foreground"
                      : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        {canImprove && sparMode === "probe" && (
          <p className="text-xs text-muted-foreground -mt-2">
            Probe mode adds an End game button to stop, give feedback, and try again — feedback
            tunes the NEXT persona iteration, not this game.
          </p>
        )}

        <Button onClick={onStart} size="lg" className="w-full" disabled={!canStart} data-testid="spar-start">
          {canStart ? "Start game" : "Loading rival book…"}
        </Button>

        {hasBook && book?.stats?.positions != null && (
          <p className="text-xs text-muted-foreground text-center">
            {book.stats.positions} book positions from {opponentLabel.toLowerCase()}&apos;s games.
          </p>
        )}
        {hasBook && bookError && (
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

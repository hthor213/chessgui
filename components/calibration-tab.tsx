"use client"

// Eval Calibration — the Learn view (spec 213 data collection).
//
// Shows the user a stratified set of positions and asks, for each, what they
// think the eval is (in pawns, + = White) and why — bare perception, no eval
// bar, no engine lines, no move list. When they finish, it scores them against
// Stockfish (correlation, mean error, per-band accuracy, best-move hit rate,
// biggest misses) and writes the whole thing out as spec-213 ground truth.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import type { Key } from "@lichess-org/chessground/types"
import type { DrawShape } from "@lichess-org/chessground/draw"
import { Chess } from "chessops/chess"
import { parseFen } from "chessops/fen"
import { chessgroundDests } from "chessops/compat"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import {
  sampleSession,
  saveResults,
  normalizeAnswer,
  RESULTS_VERSION,
  MIN_PHASE_N,
  type CalibrationAnswer,
  type CalibrationPosition,
  type CalibrationProgress,
  type CalibrationSession,
  type PhaseStat,
} from "@/lib/calibration"
import { summarize, scoredAnswers, sfEvalPawns, formatPawns, type Scored } from "@/lib/calibration-stats"

const Board = dynamic(() => import("@/components/board").then((m) => ({ default: m.Board })), {
  ssr: false,
})

const STORAGE_KEY = "chessgui:calibration"
const SIZE_OPTIONS = [20, 50, 100]
const QUICK_EVALS = [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3]

type Phase = "intro" | "resume" | "sampling" | "answering" | "results"

interface Saved {
  session: CalibrationSession
  answers: CalibrationAnswer[]
  index: number
  /** Session-level reveal setting; older saves omit it (default shown). */
  showReveal?: boolean
}

/** A locked answer paired with its position, for the post-answer reveal card. */
interface Reveal {
  answer: CalibrationAnswer
  position: CalibrationPosition
}

interface CalibrationTabProps {
  /** Load a position (bare FEN) onto the analyze board — used from the results
   *  screen to inspect a miss. */
  onLoadPosition: (fen: string) => void
}

/** Chessground legal-move map for a FEN (same construction as the main board). */
function legalDests(fen: string): Map<Key, Key[]> {
  const setup = parseFen(fen)
  if (setup.isErr) return new Map()
  const pos = Chess.fromSetup(setup.unwrap())
  if (pos.isErr) return new Map()
  return chessgroundDests(pos.unwrap()) as Map<Key, Key[]>
}

/** UCI for a from→to drag, appending a queen promotion when a pawn reaches the
 *  last rank (calibration records intent, not underpromotion choice). */
function moveToUci(fen: string, from: Key, to: Key): string {
  const whiteToMove = fen.includes(" w ")
  const setup = parseFen(fen)
  let promo = ""
  if (!setup.isErr) {
    const board = setup.unwrap().board
    const sq = from as string
    const isPawn = board.pawn.has(parseSquareIndex(sq))
    const lastRank = whiteToMove ? "8" : "1"
    if (isPawn && (to as string)[1] === lastRank) promo = "q"
  }
  return `${from}${to}${promo}`
}

/** a1..h8 → 0..63 (chessops square index). */
function parseSquareIndex(sq: string): number {
  const file = sq.charCodeAt(0) - 97
  const rank = sq.charCodeAt(1) - 49
  return rank * 8 + file
}

/** Post-answer reveal of what a rated human actually played from this position,
 *  e.g. "In the game (White 2210), 24. Rc1 was played". Null if no move was
 *  captured (final position of the source game). */
function playedReveal(pos: CalibrationPosition): string | null {
  if (!pos.played_san) return null
  const who = pos.to_move === "white" ? "White" : "Black"
  const moverElo = pos.to_move === "white" ? pos.white_elo : pos.black_elo
  const eloStr = moverElo != null ? ` ${moverElo}` : ""
  const fullmove = Math.floor(pos.ply / 2) + 1
  const dots = pos.to_move === "white" ? "." : "..."
  return `In the game (${who}${eloStr}), ${fullmove}${dots} ${pos.played_san} was played`
}

export function CalibrationTab({ onLoadPosition }: CalibrationTabProps) {
  const [phase, setPhase] = useState<Phase>("intro")
  const [size, setSize] = useState(100)
  const [session, setSession] = useState<CalibrationSession | null>(null)
  const [answers, setAnswers] = useState<CalibrationAnswer[]>([])
  const [index, setIndex] = useState(0)
  const [progress, setProgress] = useState<CalibrationProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [resume, setResume] = useState<Saved | null>(null)

  // Per-position input state.
  const [evalInput, setEvalInput] = useState("")
  const [why, setWhy] = useState("")
  const [moveUci, setMoveUci] = useState<string | null>(null)
  const [timeExcluded, setTimeExcluded] = useState(false)
  // Session-level: show the post-answer reveal card, or run blind (no feedback
  // between positions — methodologically distinct data).
  const [showReveal, setShowReveal] = useState(true)
  // The just-locked answer under the optional "second look" step (between commit
  // and reveal — self-correction before any engine feedback), or null.
  const [secondLook, setSecondLook] = useState<Reveal | null>(null)
  // The just-locked answer being revealed, or null when answering.
  const [revealed, setRevealed] = useState<Reveal | null>(null)
  // Position-shown time (elapsed clock) and first-interaction time (think clock).
  const startedAt = useRef<number>(Date.now())
  const firstInteractionAt = useRef<number | null>(null)
  const [boardSize, setBoardSize] = useState(480)

  // The think clock stops at the first sign the user has formed a view — first
  // keystroke or board move. Typing time is not thinking time.
  const markInteraction = useCallback(() => {
    if (firstInteractionAt.current === null) firstInteractionAt.current = Date.now()
  }, [])

  // On mount, offer to resume an unfinished session.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Saved
      if (parsed?.session && parsed.index < parsed.session.positions.length) {
        // Upgrade older answers (no think_ms) — their time is excluded so a
        // distracted early session doesn't pollute the think-time stats.
        setResume({ ...parsed, answers: parsed.answers.map(normalizeAnswer) })
        setPhase("resume")
      }
    } catch {
      /* ignore malformed storage */
    }
  }, [])

  const persist = useCallback(
    (s: CalibrationSession, a: CalibrationAnswer[], i: number, sr: boolean) => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ session: s, answers: a, index: i, showReveal: sr }),
        )
      } catch {
        /* storage full / unavailable — the session still runs in memory */
      }
    },
    [],
  )

  const clearStorage = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  const current: CalibrationPosition | null =
    session && index < session.positions.length ? session.positions[index] : null

  const resetInputs = useCallback(() => {
    setEvalInput("")
    setWhy("")
    setMoveUci(null)
    setTimeExcluded(false)
    startedAt.current = Date.now()
    firstInteractionAt.current = null
  }, [])

  const start = useCallback(async () => {
    setError(null)
    setPhase("sampling")
    setProgress({ evaluated: 0, accepted: 0, target: size })
    try {
      const s = await sampleSession(size, {}, (p) => setProgress(p))
      setSession(s)
      setAnswers([])
      setIndex(0)
      setRevealed(null)
      resetInputs()
      setPhase("answering")
      persist(s, [], 0, showReveal)
    } catch (e) {
      setError(String(e))
      setPhase("intro")
    }
  }, [size, persist, resetInputs, showReveal])

  const continueSaved = useCallback(() => {
    if (!resume) return
    setSession(resume.session)
    setAnswers(resume.answers)
    setIndex(resume.index)
    setShowReveal(resume.showReveal ?? true)
    setRevealed(null)
    resetInputs()
    setPhase("answering")
  }, [resume, resetInputs])

  const discardSaved = useCallback(() => {
    clearStorage()
    setResume(null)
    setPhase("intro")
  }, [clearStorage])

  const finish = useCallback(
    async (finalAnswers: CalibrationAnswer[], s: CalibrationSession) => {
      const summary = summarize(s, finalAnswers)
      setPhase("results")
      clearStorage()
      try {
        const path = await saveResults({
          version: RESULTS_VERSION,
          finished_at: Date.now(),
          show_reveal: showReveal,
          session: s,
          answers: finalAnswers,
          summary,
        })
        if (path) setSavedPath(path)
      } catch (e) {
        setError(String(e))
      }
    },
    [clearStorage, showReveal],
  )

  // Advance to the next position (or finish). Shared by every exit path.
  const advance = useCallback(
    (finalAnswers: CalibrationAnswer[]) => {
      if (!session) return
      setSecondLook(null)
      setRevealed(null)
      const nextIndex = index + 1
      if (nextIndex >= session.positions.length) {
        finish(finalAnswers, session)
        return
      }
      setIndex(nextIndex)
      resetInputs()
      persist(session, finalAnswers, nextIndex, showReveal)
    },
    [session, index, finish, resetInputs, persist, showReveal],
  )

  // After the (optional) second look: show the reveal, or advance if blind.
  const proceedToReveal = useCallback(
    (answer: CalibrationAnswer, position: CalibrationPosition, finalAnswers: CalibrationAnswer[]) => {
      setSecondLook(null)
      if (showReveal) setRevealed({ answer, position })
      else advance(finalAnswers)
    },
    [showReveal, advance],
  )

  const submit = useCallback(
    (skipped: boolean) => {
      if (!session || !current) return
      const parsed = parseFloat(evalInput)
      const now = Date.now()
      // answer_locked_at is stamped HERE, before any second look or reveal
      // renders — neither can influence the committed answer.
      const answer: CalibrationAnswer = {
        index,
        eval: skipped || Number.isNaN(parsed) ? null : parsed,
        why: why.trim(),
        move_uci: moveUci,
        elapsed_ms: now - startedAt.current,
        think_ms:
          firstInteractionAt.current === null
            ? null
            : firstInteractionAt.current - startedAt.current,
        time_excluded: timeExcluded,
        answer_locked_at: now,
        revised_eval: null,
        revision_note: null,
        revised_at: null,
        skipped,
      }
      const nextAnswers = [...answers.filter((a) => a.index !== index), answer].sort(
        (a, b) => a.index - b.index,
      )
      setAnswers(nextAnswers)
      // Persist immediately at the locked index so a crash mid-step never loses
      // the answer (resume lands on the next position).
      persist(session, nextAnswers, index + 1, showReveal)
      // Answered positions get the optional second look; a skip goes straight on.
      if (skipped) proceedToReveal(answer, current, nextAnswers)
      else setSecondLook({ answer, position: current })
    },
    [session, current, evalInput, why, moveUci, timeExcluded, index, answers, persist, showReveal, proceedToReveal],
  )

  // Second look done: apply an optional revision (original stays immutable), then
  // proceed to the reveal.
  const finishSecondLook = useCallback(
    (revision: { revised_eval: number | null; revision_note: string } | null) => {
      if (!secondLook || !session) return
      let answer = secondLook.answer
      let finalAnswers = answers
      if (revision && (revision.revised_eval != null || revision.revision_note.trim() !== "")) {
        answer = {
          ...answer,
          revised_eval: revision.revised_eval,
          revision_note: revision.revision_note.trim() || null,
          revised_at: Date.now(),
        }
        finalAnswers = answers.map((a) => (a.index === answer.index ? answer : a))
        setAnswers(finalAnswers)
        persist(session, finalAnswers, index + 1, showReveal)
      }
      proceedToReveal(answer, secondLook.position, finalAnswers)
    },
    [secondLook, session, answers, index, persist, showReveal, proceedToReveal],
  )

  const onContinueReveal = useCallback(() => advance(answers), [advance, answers])

  // Input setters that also stop the think clock on first use.
  const onEvalChange = useCallback(
    (v: string) => {
      markInteraction()
      setEvalInput(v)
    },
    [markInteraction],
  )
  const onWhyChange = useCallback(
    (v: string) => {
      markInteraction()
      setWhy(v)
    },
    [markInteraction],
  )

  const canSubmit = evalInput.trim() !== "" && !Number.isNaN(parseFloat(evalInput))

  const legalMoves = useMemo(() => (current ? legalDests(current.fen) : new Map<Key, Key[]>()), [current])
  const arrow = (uci: string, brush: string): DrawShape => ({
    orig: uci.slice(0, 2) as Key,
    dest: uci.slice(2, 4) as Key,
    brush,
  })
  // While answering / second look: the user's own move (green). While revealing:
  // their move (green) plus Stockfish's best (blue), for a side-by-side compare.
  const moveShapes = useMemo<DrawShape[]>(() => {
    if (revealed) {
      const shapes: DrawShape[] = []
      if (revealed.answer.move_uci) shapes.push(arrow(revealed.answer.move_uci, "green"))
      const best = revealed.position.sf_best_uci
      if (best && best.length >= 4) shapes.push(arrow(best, "blue"))
      return shapes
    }
    if (secondLook) {
      return secondLook.answer.move_uci ? [arrow(secondLook.answer.move_uci, "green")] : []
    }
    return moveUci ? [arrow(moveUci, "green")] : []
  }, [revealed, secondLook, moveUci])

  const onBoardMove = useCallback(
    (from: Key, to: Key) => {
      if (!current) return
      markInteraction()
      setMoveUci(moveToUci(current.fen, from, to))
    },
    [current, markInteraction],
  )

  // Keyboard: Enter submits, S skips (when not typing in the textarea handled
  // by the input focus naturally — Enter in the number field submits).
  const onEvalKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && canSubmit) {
        e.preventDefault()
        submit(false)
      }
    },
    [canSubmit, submit],
  )

  return (
    <div className="h-full flex flex-col text-foreground">
      {phase === "intro" && (
        <IntroScreen
          size={size}
          setSize={setSize}
          showReveal={showReveal}
          setShowReveal={setShowReveal}
          onStart={start}
          error={error}
        />
      )}

      {phase === "resume" && resume && (
        <ResumeScreen
          saved={resume}
          onContinue={continueSaved}
          onDiscard={discardSaved}
        />
      )}

      {phase === "sampling" && <SamplingScreen progress={progress} />}

      {phase === "answering" && session && current && (
        <AnsweringScreen
          session={session}
          index={index}
          position={current}
          boardSize={boardSize}
          setBoardSize={setBoardSize}
          legalMoves={legalMoves}
          moveShapes={moveShapes}
          moveUci={moveUci}
          onBoardMove={onBoardMove}
          onClearMove={() => setMoveUci(null)}
          evalInput={evalInput}
          setEvalInput={onEvalChange}
          why={why}
          setWhy={onWhyChange}
          onEvalKeyDown={onEvalKeyDown}
          canSubmit={canSubmit}
          timeExcluded={timeExcluded}
          onToggleTimeExcluded={() => setTimeExcluded((v) => !v)}
          secondLook={secondLook}
          onFinishSecondLook={finishSecondLook}
          reveal={revealed}
          onContinueReveal={onContinueReveal}
          onNext={() => submit(false)}
          onSkip={() => submit(true)}
        />
      )}

      {phase === "results" && session && (
        <ResultsScreen
          session={session}
          answers={answers}
          savedPath={savedPath}
          onLoadPosition={onLoadPosition}
          onRestart={() => {
            setSession(null)
            setAnswers([])
            setIndex(0)
            setSavedPath(null)
            setPhase("intro")
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function IntroScreen({
  size,
  setSize,
  showReveal,
  setShowReveal,
  onStart,
  error,
}: {
  size: number
  setSize: (n: number) => void
  showReveal: boolean
  setShowReveal: (b: boolean) => void
  onStart: () => void
  error: string | null
}) {
  return (
    <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6">
      <div className="max-w-xl w-full space-y-5">
        <div>
          <h1 className="text-2xl font-bold">Eval Calibration</h1>
          <p className="text-muted-foreground mt-1">
            How well does your eye match the engine? Judge a series of positions by feel, then see
            where you land against Stockfish.
          </p>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-3 text-sm">
          <p className="font-medium text-foreground">For each position:</p>
          <ul className="space-y-1.5 text-muted-foreground list-disc list-inside">
            <li>
              Type your eval in pawns — <span className="text-foreground">+ favours White</span>{" "}
              (e.g. <code className="text-foreground">+1.5</code>,{" "}
              <code className="text-foreground">-0.7</code>, <code className="text-foreground">0</code>).
            </li>
            <li>Write <span className="text-foreground">why</span> in a sentence or two.</li>
            <li>Optionally click the move you&apos;d play.</li>
            <li>Work at a glance-then-think pace — first instinct, then a moment to check.</li>
          </ul>
          <p className="text-muted-foreground">
            No eval bar, no hints, no engine lines — just your read of the board.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Positions:</span>
          <div className="flex gap-1">
            {SIZE_OPTIONS.map((n) => (
              <button
                key={n}
                data-testid={`calib-size-${n}`}
                onClick={() => setSize(n)}
                className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                  size === n
                    ? "border-white/30 bg-white/10 text-foreground"
                    : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showReveal}
            onChange={(e) => setShowReveal(e.target.checked)}
            data-testid="calib-show-reveal"
            className="mt-0.5 accent-emerald-500"
          />
          <span>
            <span className="text-foreground">Show answers after each position</span>
            <span className="text-muted-foreground">
              {" "}— see Stockfish&apos;s eval, best move, and what the game player did once
              you&apos;ve committed. Turn off for a blind run.
            </span>
          </span>
        </label>
        <Button onClick={onStart} size="lg" className="w-full" data-testid="calib-start">
          Start session
        </Button>
        <p className="text-xs text-muted-foreground text-center">
          Building a {size}-position session runs Stockfish over candidate positions and takes a
          couple of minutes.
        </p>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </div>
  )
}

function ResumeScreen({
  saved,
  onContinue,
  onDiscard,
}: {
  saved: Saved
  onContinue: () => void
  onDiscard: () => void
}) {
  const done = saved.answers.length
  const total = saved.session.positions.length
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-md w-full space-y-4 text-center">
        <h1 className="text-xl font-bold">Unfinished session</h1>
        <p className="text-muted-foreground">
          You have a calibration session in progress — {done} of {total} positions answered.
        </p>
        <div className="flex gap-2 justify-center">
          <Button onClick={onContinue}>Continue</Button>
          <Button variant="outline" onClick={onDiscard}>
            Discard &amp; start over
          </Button>
        </div>
      </div>
    </div>
  )
}

function SamplingScreen({ progress }: { progress: CalibrationProgress | null }) {
  const pct = progress && progress.target > 0 ? (progress.accepted / progress.target) * 100 : 0
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-md w-full space-y-4 text-center">
        <h1 className="text-xl font-bold">Building your session…</h1>
        <p className="text-muted-foreground">
          Sampling positions across eval bands and game phases, and scoring each with Stockfish.
        </p>
        <div className="h-2 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        {progress && (
          <p className="text-sm text-muted-foreground tabular-nums">
            {progress.accepted} / {progress.target} positions ready
            {progress.evaluated > progress.accepted
              ? ` · ${progress.evaluated} evaluated`
              : ""}
          </p>
        )}
      </div>
    </div>
  )
}

function AnsweringScreen({
  session,
  index,
  position,
  boardSize,
  setBoardSize,
  legalMoves,
  moveShapes,
  moveUci,
  onBoardMove,
  onClearMove,
  evalInput,
  setEvalInput,
  why,
  setWhy,
  onEvalKeyDown,
  canSubmit,
  timeExcluded,
  onToggleTimeExcluded,
  secondLook,
  onFinishSecondLook,
  reveal,
  onContinueReveal,
  onNext,
  onSkip,
}: {
  session: CalibrationSession
  index: number
  position: CalibrationPosition
  boardSize: number
  setBoardSize: (n: number) => void
  legalMoves: Map<Key, Key[]>
  moveShapes: DrawShape[]
  moveUci: string | null
  onBoardMove: (from: Key, to: Key) => void
  onClearMove: () => void
  evalInput: string
  setEvalInput: (s: string) => void
  why: string
  setWhy: (s: string) => void
  onEvalKeyDown: (e: React.KeyboardEvent) => void
  canSubmit: boolean
  timeExcluded: boolean
  onToggleTimeExcluded: () => void
  secondLook: Reveal | null
  onFinishSecondLook: (r: { revised_eval: number | null; revision_note: string } | null) => void
  reveal: Reveal | null
  onContinueReveal: () => void
  onNext: () => void
  onSkip: () => void
}) {
  const whiteToMove = position.fen.includes(" w ")
  const total = session.positions.length
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-6 py-3 border-b border-white/10 flex items-center justify-between">
        <span className="text-sm font-medium tabular-nums">
          Position {index + 1} <span className="text-muted-foreground">of {total}</span>
        </span>
        <div className="h-1.5 w-48 rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full bg-emerald-500"
            style={{ width: `${((index + 1) / total) * 100}%` }}
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 flex gap-8 p-6">
        {/* Board — always White at the bottom so "+ = White" is unambiguous. */}
        <div className="flex-1 min-w-0 flex items-center justify-center" data-testid="calib-board">
          <Board
            fen={position.fen}
            orientation="white"
            movableColor={whiteToMove ? "white" : "black"}
            onMove={onBoardMove}
            legalMoves={legalMoves}
            autoShapes={moveShapes}
            viewOnly={!!(reveal || secondLook)}
            onBoardSize={setBoardSize}
          />
        </div>
        {/* Controls */}
        <div className="w-80 shrink-0 flex flex-col gap-4 overflow-auto">
          <div>
            <span
              className={`inline-block px-2.5 py-1 rounded-md text-sm font-medium ${
                whiteToMove ? "bg-white/90 text-black" : "bg-black/80 text-white border border-white/20"
              }`}
            >
              {whiteToMove ? "White" : "Black"} to move
            </span>
          </div>

          {secondLook ? (
            <SecondLookCard answer={secondLook.answer} onDone={onFinishSecondLook} />
          ) : reveal ? (
            <RevealCard reveal={reveal} onContinue={onContinueReveal} />
          ) : (
          <>

          <div className="space-y-2">
            <label className="text-sm font-medium">Your eval (pawns, + = White)</label>
            <Input
              type="number"
              step={0.1}
              inputMode="decimal"
              autoFocus
              data-testid="calib-eval"
              value={evalInput}
              onChange={(e) => setEvalInput(e.target.value)}
              onKeyDown={onEvalKeyDown}
              placeholder="e.g. +1.5"
              className="text-lg tabular-nums"
            />
            <div className="flex flex-wrap gap-1">
              {QUICK_EVALS.map((v) => (
                <button
                  key={v}
                  onClick={() => setEvalInput(String(v))}
                  className="px-2 py-1 text-xs rounded border border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5 tabular-nums"
                >
                  {v > 0 ? `+${v}` : v}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Why?</label>
            <Textarea
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              data-testid="calib-why"
              placeholder="What do you see? (e.g. White's up a pawn but Black has the bishop pair and pressure on the king)"
              rows={4}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Your move</label>
            {moveUci ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="font-mono text-foreground">{moveUci}</span>
                <button className="text-xs hover:text-foreground underline" onClick={onClearMove}>
                  clear
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-sm text-amber-200/90">
                <span aria-hidden>↳</span>
                <span>Click the move you&apos;d play — optional, but valuable data.</span>
              </div>
            )}
          </div>

          <div className="mt-auto pt-2 space-y-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={timeExcluded}
                onChange={onToggleTimeExcluded}
                data-testid="calib-exclude-time"
                className="accent-emerald-500"
              />
              Don&apos;t count my time on this one (distracted / stepped away)
            </label>
            <div className="flex gap-2">
              <Button onClick={onNext} disabled={!canSubmit} className="flex-1" data-testid="calib-next">
                Next
              </Button>
              <Button variant="outline" onClick={onSkip} data-testid="calib-skip">
                Skip
              </Button>
            </div>
          </div>
          </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Optional self-correction between commit and reveal — still no engine info, so
 *  it measures the user's own second look, not a reaction to feedback. The
 *  original answer is immutable; this only records a revision when given. */
function SecondLookCard({
  answer,
  onDone,
}: {
  answer: CalibrationAnswer
  onDone: (r: { revised_eval: number | null; revision_note: string } | null) => void
}) {
  const [revisedEval, setRevisedEval] = useState("")
  const [note, setNote] = useState("")
  const save = () => {
    const parsed = parseFloat(revisedEval)
    onDone({ revised_eval: Number.isNaN(parsed) ? null : parsed, revision_note: note })
  }
  const hasRevision = revisedEval.trim() !== "" || note.trim() !== ""
  return (
    <div className="flex flex-col gap-3" data-testid="calib-secondlook">
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-2">
        <p className="text-sm font-medium text-foreground">Take a second look — see anything new?</p>
        <p className="text-xs text-muted-foreground">
          Your answer is locked{answer.eval != null ? ` at ${formatPawns(answer.eval)}` : ""}. If a
          fresh glance changes your mind, note it — otherwise skip. (No engine info yet.)
        </p>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Revised eval (optional)</label>
          <Input
            type="number"
            step={0.1}
            inputMode="decimal"
            value={revisedEval}
            onChange={(e) => setRevisedEval(e.target.value)}
            data-testid="calib-revised-eval"
            placeholder={answer.eval != null ? formatPawns(answer.eval) : "e.g. +1.0"}
            className="tabular-nums"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">What did you catch? (optional)</label>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="calib-revision-note"
            placeholder="e.g. missed the Qe1 defending"
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button onClick={save} disabled={!hasRevision} className="flex-1" data-testid="calib-save-revision">
          Save revision
        </Button>
        <Button variant="outline" onClick={() => onDone(null)} data-testid="calib-skip-secondlook">
          Nothing new
        </Button>
      </div>
    </div>
  )
}

/** Post-answer feedback: shown only after the answer is locked (so it can't
 *  anchor the eval). Compares the user's eval to Stockfish, names the best move
 *  and its margin, and — for v2 sessions — what the rated human actually played. */
function RevealCard({ reveal, onContinue }: { reveal: Reveal; onContinue: () => void }) {
  const { answer, position } = reveal
  const sf = sfEvalPawns(position)
  const played = playedReveal(position)
  const gapPawns = position.multipv_gap_cp == null ? null : position.multipv_gap_cp / 100
  return (
    <div className="flex flex-col gap-3" data-testid="calib-reveal">
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-2.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Your eval</span>
          <span className="font-mono tabular-nums">
            {answer.skipped || answer.eval == null ? "skipped" : formatPawns(answer.eval)}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Stockfish</span>
          <span className="font-mono tabular-nums text-foreground">{formatPawns(sf)}</span>
        </div>
        {!answer.skipped && answer.eval != null && (
          <div className="flex items-center justify-between text-sm border-t border-white/10 pt-2">
            <span className="text-muted-foreground">Off by</span>
            <span className="font-mono tabular-nums text-amber-300">
              {Math.abs(answer.eval - sf).toFixed(1)}
            </span>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-1.5 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Best move</span>
          <span className="font-mono text-blue-300">{position.sf_best_san ?? position.sf_best_uci}</span>
        </div>
        {gapPawns != null && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Margin over 2nd</span>
            <span className="font-mono tabular-nums text-muted-foreground">
              {gapPawns < 0.3 ? `${gapPawns.toFixed(1)} (close)` : gapPawns.toFixed(1)}
            </span>
          </div>
        )}
      </div>

      {played && <p className="text-sm text-emerald-300/90">{played}</p>}

      <Button onClick={onContinue} className="w-full mt-1" data-testid="calib-continue">
        Continue
      </Button>
    </div>
  )
}

function ResultsScreen({
  session,
  answers,
  savedPath,
  onLoadPosition,
  onRestart,
}: {
  session: CalibrationSession
  answers: CalibrationAnswer[]
  savedPath: string | null
  onLoadPosition: (fen: string) => void
  onRestart: () => void
}) {
  const summary = useMemo(() => summarize(session, answers), [session, answers])
  const points = useMemo(() => scoredAnswers(session, answers), [session, answers])

  return (
    <div className="flex-1 min-h-0 overflow-auto p-6" data-testid="calib-results">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl font-bold">Your calibration</h1>
          <Button variant="outline" size="sm" onClick={onRestart}>
            New session
          </Button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <Stat label="Correlation" value={summary.pearson == null ? "—" : summary.pearson.toFixed(2)} hint="vs Stockfish" />
          <Stat label="Mean error" value={summary.mae == null ? "—" : `${summary.mae.toFixed(2)}`} hint="pawns" />
          <Stat
            label="Best-move hits"
            value={
              summary.bestMoveHitRate == null
                ? "—"
                : `${Math.round(summary.bestMoveHitRate * 100)}%`
            }
            hint={`${summary.moveAnswers} with a move`}
          />
          <Stat
            label="Median think"
            value={summary.medianThinkMs == null ? "—" : `${(summary.medianThinkMs / 1000).toFixed(1)}s`}
            hint={summary.timeExcludedCount > 0 ? `${summary.timeExcludedCount} time-excluded` : "per position"}
          />
          <Stat label="Answered" value={`${summary.answered}`} hint={`${summary.skipped} skipped`} />
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">You vs Stockfish</h2>
            <Scatter points={points} />
          </div>
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">Error by eval band</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground text-left border-b border-white/10">
                  <th className="py-1.5 font-medium">|SF eval|</th>
                  <th className="py-1.5 font-medium text-right">Positions</th>
                  <th className="py-1.5 font-medium text-right">Your MAE</th>
                </tr>
              </thead>
              <tbody>
                {summary.perBand.map((b) => (
                  <tr key={b.band} className="border-b border-white/5">
                    <td className="py-1.5 tabular-nums">{b.band}</td>
                    <td className="py-1.5 text-right tabular-nums">{b.count}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {b.mae == null ? "—" : b.mae.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <PhaseTable perPhase={summary.perPhase} />

        {summary.biggestMisses.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">Biggest misses</h2>
            <div className="rounded-lg border border-white/10 divide-y divide-white/5">
              {summary.biggestMisses.map((m) => {
                const pos = session.positions[m.index]
                const reveal = pos ? playedReveal(pos) : null
                return (
                  <button
                    key={m.index}
                    onClick={() => onLoadPosition(m.fen)}
                    className="w-full flex items-center justify-between gap-4 px-4 py-2.5 text-left hover:bg-white/5 transition-colors"
                    title="Open this position on the analyze board"
                  >
                    <span className="min-w-0 flex flex-col gap-0.5">
                      <span className="text-xs font-mono text-muted-foreground truncate">{m.fen}</span>
                      {reveal && <span className="text-xs text-emerald-300/80">{reveal}</span>}
                    </span>
                    <span className="flex items-center gap-3 shrink-0 text-sm tabular-nums">
                      <span>
                        you <span className="text-foreground">{formatPawns(m.userEval)}</span>
                      </span>
                      <span>
                        SF <span className="text-foreground">{formatPawns(m.sfEval)}</span>
                      </span>
                      <span className="text-red-400">Δ{m.absError.toFixed(1)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {savedPath ? `Saved to ${savedPath}` : "Session complete."} Your answers help calibrate the
          human evaluator (spec 213).
        </p>
      </div>
    </div>
  )
}

/** Per-phase accuracy — a chess eval skill is per-phase, not scalar. Absent
 *  phases get an explicit note rather than an empty row (the sampler barely
 *  reaches endgames given the ply-40 index cap), and thin phases are flagged. */
function PhaseTable({ perPhase }: { perPhase: PhaseStat[] }) {
  const fmt = (v: number | null, digits = 2) => (v == null ? "—" : v.toFixed(digits))
  const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`)
  const present = perPhase.filter((p) => p.count > 0)
  const empty = perPhase.filter((p) => p.count === 0)
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">By game phase</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground text-left border-b border-white/10">
            <th className="py-1.5 font-medium">Phase</th>
            <th className="py-1.5 font-medium text-right">Positions</th>
            <th className="py-1.5 font-medium text-right">MAE</th>
            <th className="py-1.5 font-medium text-right">Correlation</th>
            <th className="py-1.5 font-medium text-right">Best-move</th>
          </tr>
        </thead>
        <tbody>
          {present.map((p) => (
            <tr key={p.phase} className="border-b border-white/5">
              <td className="py-1.5 capitalize">
                {p.phase}
                {p.count < MIN_PHASE_N && (
                  <span className="ml-2 text-xs text-amber-400/80">thin sample</span>
                )}
              </td>
              <td className="py-1.5 text-right tabular-nums">{p.count}</td>
              <td className="py-1.5 text-right tabular-nums">{fmt(p.mae)}</td>
              <td className="py-1.5 text-right tabular-nums">{fmt(p.pearson)}</td>
              <td className="py-1.5 text-right tabular-nums">
                {p.bestMoveHitRate == null ? "—" : `${pct(p.bestMoveHitRate)}`}
                {p.moveAnswers > 0 && (
                  <span className="text-muted-foreground text-xs"> ({p.moveAnswers})</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {empty.map((p) => (
        <p key={p.phase} className="text-xs text-muted-foreground">
          No {p.phase} positions in this session — the position index only reaches ply 40, so{" "}
          {p.phase}s are barely sampled yet.
        </p>
      ))}
      {present.some((p) => p.count > 0 && p.count < MIN_PHASE_N) && (
        <p className="text-xs text-muted-foreground">
          A phase with fewer than {MIN_PHASE_N} positions is too thin to read much into.
        </p>
      )}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-0.5">{value}</div>
      {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  )
}

/** User (y) vs Stockfish (x) scatter, both in pawns, with a y=x reference line.
 *  Inline SVG in the eval-graph idiom — no chart library. */
function Scatter({ points }: { points: Scored[] }) {
  const SIZE = 300
  const PAD = 28
  const LIM = 8 // pawns, clamp axis range to ±8
  const toX = (v: number) => PAD + ((clamp(v, LIM) + LIM) / (2 * LIM)) * (SIZE - 2 * PAD)
  const toY = (v: number) => SIZE - PAD - ((clamp(v, LIM) + LIM) / (2 * LIM)) * (SIZE - 2 * PAD)
  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full max-w-[320px] rounded-lg bg-[#12100e]">
      {/* axes */}
      <line x1={toX(0)} y1={PAD} x2={toX(0)} y2={SIZE - PAD} stroke="rgba(255,255,255,0.12)" />
      <line x1={PAD} y1={toY(0)} x2={SIZE - PAD} y2={toY(0)} stroke="rgba(255,255,255,0.12)" />
      {/* y = x reference: perfect agreement */}
      <line
        x1={toX(-LIM)}
        y1={toY(-LIM)}
        x2={toX(LIM)}
        y2={toY(LIM)}
        stroke="rgba(16,185,129,0.4)"
        strokeDasharray="4,4"
      />
      {points.map((p) => (
        <circle key={p.index} cx={toX(p.sfEval)} cy={toY(p.userEval)} r={3.5} fill="rgba(155,199,0,0.85)" />
      ))}
      <text x={SIZE - PAD} y={toY(0) - 4} textAnchor="end" fontSize={9} fill="rgba(255,255,255,0.4)">
        Stockfish →
      </text>
      <text x={toX(0) + 4} y={PAD + 8} fontSize={9} fill="rgba(255,255,255,0.4)">
        ↑ You
      </text>
    </svg>
  )
}

function clamp(v: number, lim: number): number {
  return Math.max(-lim, Math.min(lim, v))
}

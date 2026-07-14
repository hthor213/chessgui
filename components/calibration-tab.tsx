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
  RESULTS_VERSION,
  type CalibrationAnswer,
  type CalibrationPosition,
  type CalibrationProgress,
  type CalibrationSession,
} from "@/lib/calibration"
import { summarize, scoredAnswers, formatPawns, type Scored } from "@/lib/calibration-stats"

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
  const startedAt = useRef<number>(Date.now())
  const [boardSize, setBoardSize] = useState(480)

  // On mount, offer to resume an unfinished session.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Saved
      if (parsed?.session && parsed.index < parsed.session.positions.length) {
        setResume(parsed)
        setPhase("resume")
      }
    } catch {
      /* ignore malformed storage */
    }
  }, [])

  const persist = useCallback((s: CalibrationSession, a: CalibrationAnswer[], i: number) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ session: s, answers: a, index: i }))
    } catch {
      /* storage full / unavailable — the session still runs in memory */
    }
  }, [])

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
    startedAt.current = Date.now()
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
      resetInputs()
      setPhase("answering")
      persist(s, [], 0)
    } catch (e) {
      setError(String(e))
      setPhase("intro")
    }
  }, [size, persist, resetInputs])

  const continueSaved = useCallback(() => {
    if (!resume) return
    setSession(resume.session)
    setAnswers(resume.answers)
    setIndex(resume.index)
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
          session: s,
          answers: finalAnswers,
          summary,
        })
        if (path) setSavedPath(path)
      } catch (e) {
        setError(String(e))
      }
    },
    [clearStorage],
  )

  const submit = useCallback(
    (skipped: boolean) => {
      if (!session || !current) return
      const parsed = parseFloat(evalInput)
      const answer: CalibrationAnswer = {
        index,
        eval: skipped || Number.isNaN(parsed) ? null : parsed,
        why: why.trim(),
        move_uci: moveUci,
        elapsed_ms: Date.now() - startedAt.current,
        skipped,
      }
      const nextAnswers = [...answers.filter((a) => a.index !== index), answer].sort(
        (a, b) => a.index - b.index,
      )
      setAnswers(nextAnswers)
      const nextIndex = index + 1
      if (nextIndex >= session.positions.length) {
        finish(nextAnswers, session)
        return
      }
      setIndex(nextIndex)
      resetInputs()
      persist(session, nextAnswers, nextIndex)
    },
    [session, current, evalInput, why, moveUci, index, answers, finish, resetInputs, persist],
  )

  const canSubmit = evalInput.trim() !== "" && !Number.isNaN(parseFloat(evalInput))

  const legalMoves = useMemo(() => (current ? legalDests(current.fen) : new Map<Key, Key[]>()), [current])
  const moveShapes = useMemo<DrawShape[]>(() => {
    if (!moveUci) return []
    return [{ orig: moveUci.slice(0, 2) as Key, dest: moveUci.slice(2, 4) as Key, brush: "green" }]
  }, [moveUci])

  const onBoardMove = useCallback(
    (from: Key, to: Key) => {
      if (!current) return
      setMoveUci(moveToUci(current.fen, from, to))
    },
    [current],
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
          setEvalInput={setEvalInput}
          why={why}
          setWhy={setWhy}
          onEvalKeyDown={onEvalKeyDown}
          canSubmit={canSubmit}
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
  onStart,
  error,
}: {
  size: number
  setSize: (n: number) => void
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
            <label className="text-sm font-medium">Your move (optional)</label>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {moveUci ? (
                <>
                  <span className="font-mono text-foreground">{moveUci}</span>
                  <button className="text-xs hover:text-foreground underline" onClick={onClearMove}>
                    clear
                  </button>
                </>
              ) : (
                <span>Click a move on the board</span>
              )}
            </div>
          </div>

          <div className="flex gap-2 mt-auto pt-2">
            <Button onClick={onNext} disabled={!canSubmit} className="flex-1" data-testid="calib-next">
              Next
            </Button>
            <Button variant="outline" onClick={onSkip} data-testid="calib-skip">
              Skip
            </Button>
          </div>
        </div>
      </div>
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

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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

        {summary.biggestMisses.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">Biggest misses</h2>
            <div className="rounded-lg border border-white/10 divide-y divide-white/5">
              {summary.biggestMisses.map((m) => (
                <button
                  key={m.index}
                  onClick={() => onLoadPosition(m.fen)}
                  className="w-full flex items-center justify-between gap-4 px-4 py-2.5 text-left hover:bg-white/5 transition-colors"
                  title="Open this position on the analyze board"
                >
                  <span className="text-xs font-mono text-muted-foreground truncate">{m.fen}</span>
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
              ))}
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

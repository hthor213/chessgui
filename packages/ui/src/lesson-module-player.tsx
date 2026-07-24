"use client"

// Concept Lessons — the module player (specs/227, D3).
//
// A DUMB renderer over the pure `lessonPlayerReducer` (packages/core): the
// three-beat stepper (principle → illustrate → practice) plus the interleaved
// predict-the-move board. It holds NO chess state of its own beyond a local
// FEN→SAN conversion for the board; every progression decision is the reducer's.
//
// Fair-play boundary (spec 227 D5): this imports ONLY @chessgui/core lesson
// modules + the shared Board — never useChessGame, the notebook, or any
// live-game state. It renders and functions with no game loaded.

import { useReducer, useMemo, useCallback, useState, useEffect } from "react"
import dynamic from "next/dynamic"
import type { Key } from "@lichess-org/chessground/types"
import { Chess, normalizeMove } from "chessops/chess"
import { parseFen } from "chessops/fen"
import { makeSan } from "chessops/san"
import { chessgroundDests } from "chessops/compat"
import type { NormalMove } from "chessops"
import { Card } from "@chessgui/ui/ui/card"
import { Button } from "@chessgui/ui/ui/button"
import { Badge } from "@chessgui/ui/ui/badge"
import { Textarea } from "@chessgui/ui/ui/textarea"
import { ScrollArea } from "@chessgui/ui/ui/scroll-area"
import type { Module } from "@chessgui/core/lessons"
import {
  initLessonPlayer,
  lessonPlayerReducer,
  boardFen,
  currentFocusNote,
  currentLine,
  currentQuestion,
  moduleScore,
} from "@chessgui/core/lesson-player"
import type { GradeResult, SelfGrade, ModuleScore } from "@chessgui/core/lesson-grade"

const Board = dynamic(() => import("@chessgui/ui/board").then((m) => ({ default: m.Board })), {
  ssr: false,
})

// ── Local FEN → SAN driver (mirrors use-chess-game.ts:123-129; no live state) ──

function posFromFen(fen: string): Chess | null {
  const setup = parseFen(fen)
  if (setup.isErr) return null
  const pos = Chess.fromSetup(setup.unwrap())
  return pos.isErr ? null : pos.unwrap()
}

function legalDestsOf(fen: string): Map<Key, Key[]> {
  const pos = posFromFen(fen)
  if (!pos) return new Map()
  return chessgroundDests(pos) as Map<Key, Key[]>
}

function sqIndex(key: string): number {
  const file = key.charCodeAt(0) - 97
  const rank = key.charCodeAt(1) - 49
  return rank * 8 + file
}

/** Convert a board drag into SAN in the given position. Auto-queens a pawn that
 *  reaches the last rank (lessons offer no underpromotion picker — Tier 0). */
function dragToSan(fen: string, from: Key, to: Key): string | null {
  const pos = posFromFen(fen)
  if (!pos) return null
  const fromSq = sqIndex(from as string)
  const toSq = sqIndex(to as string)
  if (fromSq < 0 || toSq < 0) return null
  let move: NormalMove = { from: fromSq, to: toSq }
  const piece = pos.board.get(fromSq)
  const lastRank = pos.turn === "white" ? 7 : 0
  if (piece?.role === "pawn" && toSq >> 3 === lastRank) {
    move = { ...move, promotion: "queen" }
  }
  const norm = normalizeMove(pos, move) as NormalMove
  if (!pos.isLegal(norm)) return null
  return makeSan(pos, norm)
}

function uciToLastMove(uci: string | undefined): [Key, Key] | undefined {
  if (!uci || uci.length < 4) return undefined
  return [uci.slice(0, 2) as Key, uci.slice(2, 4) as Key]
}

// ── Minimal inline markdown (bold only — the principle text) ──────────────────

function renderInline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((chunk, i) => {
    if (chunk.startsWith("**") && chunk.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {chunk.slice(2, -2)}
        </strong>
      )
    }
    return <span key={i}>{chunk}</span>
  })
}

// ── Stepper header ────────────────────────────────────────────────────────────

const BEATS: { key: "principle" | "illustrate" | "practice"; label: string }[] = [
  { key: "principle", label: "Principle" },
  { key: "illustrate", label: "Illustrate" },
  { key: "practice", label: "Practice" },
]

function Stepper({ active }: { active: string }) {
  const activeIndex =
    active === "done" ? 3 : BEATS.findIndex((b) => b.key === active)
  return (
    <div className="flex items-center gap-2" data-testid="lesson-stepper">
      {BEATS.map((b, i) => {
        const done = i < activeIndex
        const current = b.key === active
        return (
          <div key={b.key} className="flex items-center gap-2">
            <div
              className={`flex items-center gap-2 px-3 py-1 rounded-full text-sm ${
                current
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                  : done
                    ? "text-emerald-400"
                    : "text-muted-foreground"
              }`}
            >
              <span
                className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                  current || done ? "bg-emerald-500 text-black" : "bg-white/10"
                }`}
              >
                {done ? "✓" : i + 1}
              </span>
              {b.label}
            </div>
            {i < BEATS.length - 1 && <span className="text-white/20">→</span>}
          </div>
        )
      })}
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface LessonModulePlayerProps {
  module: Module
  /** Back to the module list. */
  onExit: () => void
  /** Fired once when the module's practice beat completes, with the score.
   *  The parent persists a progress entry (spec 227 D2 store). */
  onComplete?: (score: ModuleScore) => void
}

export function LessonModulePlayer({ module, onExit, onComplete }: LessonModulePlayerProps) {
  const [state, dispatch] = useReducer(lessonPlayerReducer, module, initLessonPlayer)
  const [freeText, setFreeText] = useState("")
  const [completedFired, setCompletedFired] = useState(false)

  // Fire onComplete exactly once when the module reaches its scorecard.
  const done = state.beat === "done"
  useEffect(() => {
    if (done && !completedFired) {
      setCompletedFired(true)
      onComplete?.(moduleScore(state))
    }
    // moduleScore(state) is read only when we fire; state is captured then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, completedFired])

  const line = currentLine(state)
  const fen = boardFen(state)
  const focus = currentFocusNote(state)
  const question = currentQuestion(state)

  const legalMoves = useMemo(
    () => (fen && state.awaiting ? legalDestsOf(fen) : new Map<Key, Key[]>()),
    [fen, state.awaiting],
  )

  const onPredict = useCallback(
    (from: Key, to: Key) => {
      if (!fen) return
      const san = dragToSan(fen, from, to)
      if (san) dispatch({ type: "PLAY_PREDICTION", san })
    },
    [fen],
  )

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6 min-h-0 flex-1" data-testid="lesson-player">
      {/* Header: title + stepper + exit */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <button
            onClick={onExit}
            className="text-sm text-muted-foreground hover:text-foreground"
            data-testid="lesson-exit"
          >
            ← All modules
          </button>
          <h2 className="text-lg font-semibold mt-1">{module.title}</h2>
        </div>
        <Stepper active={state.beat} />
      </div>

      {/* ── Beat: Principle ─────────────────────────────────────────────── */}
      {state.beat === "principle" && (
        <Card
          className="bg-card/50 backdrop-blur-sm border-white/10 p-6 max-w-2xl"
          data-testid="lesson-beat-principle"
        >
          <p className="text-[15px] leading-7 text-muted-foreground">
            {renderInline(module.principle.markdown)}
          </p>
          <div className="mt-5 rounded-md border-l-2 border-emerald-500 bg-emerald-500/10 px-4 py-3">
            <span className="text-xs uppercase tracking-wide text-emerald-400">Remember</span>
            <p className="text-[15px] text-foreground mt-1">{module.principle.remember}</p>
          </div>
          <div className="mt-6">
            <Button onClick={() => dispatch({ type: "START" })} data-testid="lesson-start">
              Start
            </Button>
          </div>
        </Card>
      )}

      {/* ── Beat: Illustrate ────────────────────────────────────────────── */}
      {state.beat === "illustrate" && line && fen && (
        <div
          className="flex flex-col lg:flex-row gap-6 min-h-0"
          data-testid="lesson-beat-illustrate"
        >
          <div className="shrink-0">
            <Board
              fen={fen}
              orientation={line.orientation}
              viewOnly={!state.awaiting}
              movableColor={state.awaiting ? "both" : "white"}
              legalMoves={legalMoves}
              onMove={onPredict}
              lastMove={uciToLastMove(line.ucis[state.ply])}
              coordinates
            />
          </div>
          <div className="flex flex-col gap-3 flex-1 min-w-0 max-w-lg">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{line.title}</span>
              <Badge variant="outline" className="text-[10px]">
                {line.source.split(";")[0]}
              </Badge>
            </div>

            {/* Focus note / ask prompt */}
            {state.awaiting && focus?.ask ? (
              <Card
                className="bg-emerald-500/10 border-emerald-500/40 p-4"
                data-testid="lesson-ask"
              >
                <span className="text-xs uppercase tracking-wide text-emerald-400">
                  Your move
                </span>
                <p className="text-[15px] text-foreground mt-1">{focus.ask.prompt}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  Play the move on the board.
                </p>
              </Card>
            ) : focus ? (
              <Card className="bg-card/50 border-white/10 p-4" data-testid="lesson-focus">
                <p className="text-[15px] leading-6 text-muted-foreground">{focus.text}</p>
              </Card>
            ) : (
              <Card className="bg-card/50 border-white/10 p-4">
                <p className="text-sm text-muted-foreground">
                  Step through the game with Next. Watch for the pauses.
                </p>
              </Card>
            )}

            {/* Interleave feedback */}
            {state.feedback && (
              <Card
                className={`p-4 ${
                  state.feedback.correct
                    ? "bg-emerald-500/10 border-emerald-500/40"
                    : "bg-red-500/10 border-red-500/40"
                }`}
                data-testid="lesson-feedback"
              >
                <span
                  className={`text-xs uppercase tracking-wide ${
                    state.feedback.correct ? "text-emerald-400" : "text-red-400"
                  }`}
                >
                  {state.feedback.correct ? "Correct" : "Not the move"}
                </span>
                <p className="text-[15px] text-foreground mt-1">{state.feedback.text}</p>
              </Card>
            )}

            {/* Move strip — hide the continuation while predicting, so the answer isn't spoiled */}
            <MoveStrip line={line} ply={state.ply} awaiting={state.awaiting} />

            {/* Controls */}
            <div className="flex items-center gap-2 mt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => dispatch({ type: "ILLUSTRATE_PREV" })}
                disabled={state.awaiting || state.ply <= line.startPly}
                data-testid="lesson-illustrate-prev"
              >
                Prev
              </Button>
              <Button
                size="sm"
                onClick={() => dispatch({ type: "ILLUSTRATE_NEXT" })}
                disabled={state.awaiting}
                data-testid="lesson-illustrate-next"
              >
                Next
              </Button>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => dispatch({ type: "GO_TO_PRACTICE" })}
                data-testid="lesson-skip-to-practice"
              >
                Skip to practice →
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Beat: Practice ──────────────────────────────────────────────── */}
      {state.beat === "practice" && question && (
        <div className="flex flex-col gap-4 min-h-0" data-testid="lesson-beat-practice">
          <div className="text-sm text-muted-foreground">
            Question {state.qIndex + 1} of {module.questions.length}
          </div>

          {question.kind === "multiple_choice" && (
            <MultipleChoice
              key={state.qIndex}
              question={question}
              revealed={state.revealed}
              onAnswer={(i) => dispatch({ type: "ANSWER", answer: i })}
              onNext={() => dispatch({ type: "NEXT_QUESTION" })}
              lastIndex={state.qIndex === module.questions.length - 1}
            />
          )}

          {question.kind === "choose_move" && (
            <ChooseMove
              key={state.qIndex}
              question={question}
              revealed={state.revealed}
              onAnswer={(san) => dispatch({ type: "ANSWER", answer: san })}
              onNext={() => dispatch({ type: "NEXT_QUESTION" })}
              lastIndex={state.qIndex === module.questions.length - 1}
            />
          )}

          {question.kind === "free_text" && (
            <FreeText
              key={state.qIndex}
              question={question}
              revealed={state.revealed}
              value={freeText}
              onChange={setFreeText}
              selfGraded={
                state.answers[state.qIndex]?.kind === "free_text"
                  ? (state.answers[state.qIndex] as { selfGrade: SelfGrade | null }).selfGrade
                  : null
              }
              onReveal={() => dispatch({ type: "ANSWER", answer: undefined })}
              onSelfGrade={(g) => {
                dispatch({ type: "SELF_GRADE", grade: g })
              }}
              onNext={() => {
                setFreeText("")
                dispatch({ type: "NEXT_QUESTION" })
              }}
              lastIndex={state.qIndex === module.questions.length - 1}
            />
          )}
        </div>
      )}

      {/* ── Scorecard ───────────────────────────────────────────────────── */}
      {state.beat === "done" && (
        <ScoreCard
          score={moduleScore(state)}
          module={module}
          onExit={onExit}
          onRestart={() => {
            setCompletedFired(false)
            setFreeText("")
            dispatch({ type: "RESTART" })
          }}
        />
      )}
    </div>
  )
}

// ── Move strip (read-only SAN, current ply highlighted) ───────────────────────

function MoveStrip({
  line,
  ply,
  awaiting = false,
}: {
  line: ReturnType<typeof currentLine>
  ply: number
  awaiting?: boolean
}) {
  if (!line) return null
  // While the user is predicting the move, never render the continuation — it
  // holds the answer. Show the line only up to the current position.
  const lastVisible = awaiting ? ply : line.maxPly
  const tokens: React.ReactNode[] = []
  for (let p = 1; p <= lastVisible; p++) {
    const san = line.sans[p]
    if (!san) continue
    const white = p % 2 === 1
    if (white) tokens.push(
      <span key={`n${p}`} className="text-muted-foreground/60 mr-1">
        {Math.ceil(p / 2)}.
      </span>,
    )
    tokens.push(
      <span
        key={`m${p}`}
        className={`mr-2 ${p === ply ? "bg-emerald-500/30 text-foreground rounded px-1" : "text-muted-foreground"}`}
        data-testid={p === ply ? "lesson-current-move" : undefined}
      >
        {san}
      </span>,
    )
  }
  if (awaiting && line.maxPly > lastVisible) {
    tokens.push(
      <span key="hidden" className="text-muted-foreground/50" data-testid="lesson-move-strip-masked">
        …
      </span>,
    )
  }
  return (
    <Card className="bg-card/50 border-white/10 p-3">
      <span className="text-[11px] font-semibold text-muted-foreground mb-1 block">Model game</span>
      <ScrollArea className="max-h-24">
        <div className="text-sm leading-6">{tokens}</div>
      </ScrollArea>
    </Card>
  )
}

// ── Question renderers ────────────────────────────────────────────────────────

function Explanation({ text, correct }: { text: string; correct: boolean | null }) {
  return (
    <Card
      className={`p-4 mt-3 ${
        correct === true
          ? "bg-emerald-500/10 border-emerald-500/40"
          : correct === false
            ? "bg-red-500/10 border-red-500/40"
            : "bg-white/5 border-white/10"
      }`}
      data-testid="lesson-explanation"
    >
      {correct !== null && (
        <span
          className={`text-xs uppercase tracking-wide ${
            correct ? "text-emerald-400" : "text-red-400"
          }`}
        >
          {correct ? "Correct" : "Not quite"}
        </span>
      )}
      <p className="text-[15px] text-foreground mt-1 leading-6">{text}</p>
    </Card>
  )
}

function NextButton({ onNext, lastIndex }: { onNext: () => void; lastIndex: boolean }) {
  return (
    <Button className="mt-4" onClick={onNext} data-testid="lesson-next-question">
      {lastIndex ? "See score" : "Next question"}
    </Button>
  )
}

function MultipleChoice({
  question,
  revealed,
  onAnswer,
  onNext,
  lastIndex,
}: {
  question: Extract<Module["questions"][number], { kind: "multiple_choice" }>
  revealed: GradeResult | null
  onAnswer: (index: number) => void
  onNext: () => void
  lastIndex: boolean
}) {
  const [chosen, setChosen] = useState<number | null>(null)
  const answered = revealed !== null
  return (
    <Card className="bg-card/50 border-white/10 p-5 max-w-2xl" data-testid="lesson-question-mc">
      <p className="text-[15px] text-foreground mb-4">{question.prompt}</p>
      <div className="flex flex-col gap-2">
        {question.options.map((opt, i) => {
          const isCorrect = i === question.correct
          const isChosen = i === chosen
          return (
            <button
              key={i}
              disabled={answered}
              data-testid={`lesson-mc-option-${i}`}
              onClick={() => {
                setChosen(i)
                onAnswer(i)
              }}
              className={`text-left rounded-md border px-4 py-3 text-sm transition-colors ${
                answered && isCorrect
                  ? "border-emerald-500/60 bg-emerald-500/10 text-foreground"
                  : answered && isChosen
                    ? "border-red-500/60 bg-red-500/10 text-foreground"
                    : "border-white/10 hover:border-white/30 text-muted-foreground"
              } ${answered ? "cursor-default" : "cursor-pointer"}`}
            >
              {opt}
            </button>
          )
        })}
      </div>
      {answered && revealed.kind === "multiple_choice" && (
        <>
          <Explanation text={revealed.explanation} correct={revealed.correct} />
          <NextButton onNext={onNext} lastIndex={lastIndex} />
        </>
      )}
    </Card>
  )
}

function ChooseMove({
  question,
  revealed,
  onAnswer,
  onNext,
  lastIndex,
}: {
  question: Extract<Module["questions"][number], { kind: "choose_move" }>
  revealed: GradeResult | null
  onAnswer: (san: string) => void
  onNext: () => void
  lastIndex: boolean
}) {
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>(undefined)
  const answered = revealed !== null
  const orientation: "white" | "black" = / b /.test(question.fen) ? "black" : "white"
  const legalMoves = useMemo(
    () => (answered ? new Map<Key, Key[]>() : legalDestsOf(question.fen)),
    [question.fen, answered],
  )
  const onMove = useCallback(
    (from: Key, to: Key) => {
      const san = dragToSan(question.fen, from, to)
      if (!san) return
      setLastMove([from, to])
      onAnswer(san)
    },
    [question.fen, onAnswer],
  )
  return (
    <div className="flex flex-col lg:flex-row gap-6" data-testid="lesson-question-move">
      <div className="shrink-0">
        <Board
          fen={question.fen}
          orientation={orientation}
          viewOnly={answered}
          movableColor={answered ? "white" : "both"}
          legalMoves={legalMoves}
          onMove={onMove}
          lastMove={lastMove}
          coordinates
        />
      </div>
      <div className="flex-1 min-w-0 max-w-lg">
        <Card className="bg-card/50 border-white/10 p-5">
          <p className="text-[15px] text-foreground">{question.prompt}</p>
          {!answered && (
            <p className="text-xs text-muted-foreground mt-2">Play your move on the board.</p>
          )}
        </Card>
        {answered && revealed.kind === "choose_move" && (
          <>
            <Explanation text={revealed.explanation} correct={revealed.correct} />
            <NextButton onNext={onNext} lastIndex={lastIndex} />
          </>
        )}
      </div>
    </div>
  )
}

function FreeText({
  question,
  revealed,
  value,
  onChange,
  selfGraded,
  onReveal,
  onSelfGrade,
  onNext,
  lastIndex,
}: {
  question: Extract<Module["questions"][number], { kind: "free_text" }>
  revealed: GradeResult | null
  value: string
  onChange: (v: string) => void
  selfGraded: SelfGrade | null
  onReveal: () => void
  onSelfGrade: (g: SelfGrade) => void
  onNext: () => void
  lastIndex: boolean
}) {
  const revealedNow = revealed !== null && revealed.kind === "free_text"
  const grades: { key: SelfGrade; label: string }[] = [
    { key: "got_it", label: "Got it" },
    { key: "partial", label: "Partial" },
    { key: "missed", label: "Missed" },
  ]
  return (
    <Card className="bg-card/50 border-white/10 p-5 max-w-2xl" data-testid="lesson-question-freetext">
      <p className="text-[15px] text-foreground mb-3">{question.prompt}</p>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Write your plan in prose…"
        rows={5}
        disabled={revealedNow}
        data-testid="lesson-freetext-input"
      />
      {!revealedNow ? (
        <Button className="mt-3" onClick={onReveal} data-testid="lesson-freetext-reveal">
          Reveal model answer
        </Button>
      ) : (
        <>
          <Card className="bg-white/5 border-white/10 p-4 mt-4" data-testid="lesson-model-answer">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Model answer</span>
            <p className="text-[15px] text-foreground mt-1 leading-6">
              {revealed.kind === "free_text" ? revealed.modelAnswer : ""}
            </p>
            {revealed.kind === "free_text" && revealed.rubric.length > 0 && (
              <ul className="mt-3 space-y-1">
                {revealed.rubric.map((r, i) => (
                  <li key={i} className="text-sm text-muted-foreground flex gap-2">
                    <span className="text-emerald-400">•</span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <div className="mt-4">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Grade yourself
            </span>
            <div className="flex gap-2 mt-2">
              {grades.map((g) => (
                <Button
                  key={g.key}
                  variant={selfGraded === g.key ? "default" : "outline"}
                  size="sm"
                  onClick={() => onSelfGrade(g.key)}
                  data-testid={`lesson-selfgrade-${g.key}`}
                >
                  {g.label}
                </Button>
              ))}
            </div>
          </div>
          {selfGraded && <NextButton onNext={onNext} lastIndex={lastIndex} />}
        </>
      )}
    </Card>
  )
}

// ── Scorecard ─────────────────────────────────────────────────────────────────

function ScoreCard({
  score,
  module,
  onExit,
  onRestart,
}: {
  score: ModuleScore
  module: Module
  onExit: () => void
  onRestart: () => void
}) {
  const pct = score.total > 0 ? Math.round((score.score / score.total) * 100) : 100
  return (
    <Card
      className="bg-card/50 backdrop-blur-sm border-white/10 p-6 max-w-xl"
      data-testid="lesson-scorecard"
    >
      <h3 className="text-lg font-semibold">Module complete</h3>
      <p className="text-sm text-muted-foreground">{module.title}</p>
      <div className="mt-4 flex items-baseline gap-2">
        <span className="text-4xl font-bold text-emerald-400" data-testid="lesson-score">
          {score.score}/{score.total}
        </span>
        <span className="text-muted-foreground">graded questions correct ({pct}%)</span>
      </div>
      <ul className="mt-4 space-y-2">
        {score.outcomes.map((o) => (
          <li key={o.index} className="flex items-center gap-3 text-sm">
            <span className="w-6 text-muted-foreground">{o.index + 1}.</span>
            <span className="flex-1 text-muted-foreground capitalize">
              {o.kind.replace("_", " ")}
            </span>
            {o.countsTowardScore ? (
              <Badge variant={o.result.correct ? "default" : "destructive"}>
                {o.result.correct ? "Correct" : "Missed"}
              </Badge>
            ) : (
              <Badge variant="secondary">
                {o.selfGrade ? o.selfGrade.replace("_", " ") : "self-graded"}
              </Badge>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-6 flex gap-2">
        <Button onClick={onExit} data-testid="lesson-scorecard-done">
          Back to modules
        </Button>
        <Button variant="outline" onClick={onRestart}>
          Retry module
        </Button>
      </div>
    </Card>
  )
}

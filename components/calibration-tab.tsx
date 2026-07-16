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
  loadPriorResults,
  coachFeedback,
  coachFollowup,
  coachInputFor,
  normalizeAnswer,
  answerRange,
  rangePoint,
  POSITIVE_RANGES,
  LEVEL_RANGE,
  RESULTS_VERSION,
  MIN_PHASE_N,
  type CalibrationAnswer,
  type CalibrationPosition,
  type CalibrationProgress,
  type CalibrationSession,
  type CoachFeedback,
  type CoachInput,
  type DeckStat,
  type EvalRange,
  type LabelerProfile,
  type PhaseStat,
} from "@/lib/calibration"
import {
  applyLockIn,
  buildProfileFromResults,
  emptyProfile,
  mergeProfiles,
  profileOfSession,
  PROFILE_LOCK_N,
} from "@/lib/calibration-profile"
import {
  summarize,
  scoredAnswers,
  sfEvalPawns,
  formatPawns,
  formatRange,
  rangeError,
  type Scored,
} from "@/lib/calibration-stats"
import { getProviders } from "@/lib/platform"
import { evalPawnsOf, levelForEloBand, type PlayoutRequest } from "@/lib/playout"
import { PlayoutScreen } from "@/components/playout-screen"

const Board = dynamic(() => import("@/components/board").then((m) => ({ default: m.Board })), {
  ssr: false,
})

const STORAGE_KEY = "chessgui:calibration"
const SIZE_OPTIONS = [20, 50, 100]
// Point-mode quick buttons — only shown when resuming a session that predates
// range elicitation (new sessions use EVAL_RANGES).
const QUICK_EVALS = [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3]

type Phase = "intro" | "resume" | "sampling" | "answering" | "results"

/** How evals are elicited. Fixed at session creation: new sessions are always
 *  "range" (spec 213 range elicitation); a resumed session that started with
 *  point answers stays "point" — mixing the two mid-session would muddy the
 *  per-player curve. */
type Elicitation = "point" | "range"

interface Saved {
  session: CalibrationSession
  answers: CalibrationAnswer[]
  index: number
  /** Session-level reveal setting; older saves omit it (default shown). */
  showReveal?: boolean
  /** Session-level AI-coach setting; older saves omit it (default on). */
  showCoach?: boolean
  /** Elicitation mode; saves that predate ranges omit it (⇒ point). */
  elicitation?: Elicitation
  /** Phase A: size of the lock-in burst at the session's head (0 = the prior
   *  profile was already locked). Saves that predate Phase A omit it (⇒ 0). */
  lockInN?: number
  /** Phase A: the labeler profile from prior saved results at session start,
   *  or null for a fresh labeler. Older saves omit it. */
  profilePrior?: LabelerProfile | null
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

  // Elicitation mode for the running session. New sessions are always "range";
  // only a resumed pre-range session runs in "point" mode.
  const [elicitation, setElicitation] = useState<Elicitation>("range")
  // Phase A (spec 213 adaptive elicitation): how many opening positions are
  // the profile lock-in burst, and the prior profile they were planned from.
  // Fixed at session creation, like the elicitation mode.
  const [lockInN, setLockInN] = useState(0)
  const [profilePrior, setProfilePrior] = useState<LabelerProfile | null>(null)
  // Per-position input state.
  const [evalInput, setEvalInput] = useState("")
  const [evalRange, setEvalRange] = useState<EvalRange | null>(null)
  const [why, setWhy] = useState("")
  const [moveUci, setMoveUci] = useState<string | null>(null)
  const [timeExcluded, setTimeExcluded] = useState(false)
  // Session-level: show the post-answer reveal card, or run blind (no feedback
  // between positions — methodologically distinct data).
  const [showReveal, setShowReveal] = useState(true)
  // Session-level: AI coach feedback on the reveal (off = no API calls).
  const [showCoach, setShowCoach] = useState(true)
  // The just-locked answer under the optional "second look" step (between commit
  // and reveal — self-correction before any engine feedback), or null.
  const [secondLook, setSecondLook] = useState<Reveal | null>(null)
  // Bumped on take-back to force a Board rebuild (resets the dragged piece).
  const [boardNonce, setBoardNonce] = useState(0)
  // The just-locked answer being revealed, or null when answering.
  const [revealed, setRevealed] = useState<Reveal | null>(null)
  // "Play it out" (spec 211): a live playout launched from the reveal card.
  // While set, the playout screen replaces the tab's content; the session
  // state underneath stays mounted, so exiting returns to the same reveal.
  const [playout, setPlayout] = useState<PlayoutRequest | null>(null)
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
      const raw = getProviders().storage.get(STORAGE_KEY)
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
    (
      s: CalibrationSession,
      a: CalibrationAnswer[],
      i: number,
      sr: boolean,
      sc: boolean,
      el: Elicitation,
      li: number,
      pp: LabelerProfile | null,
    ) => {
      // Storage full / unavailable — the session still runs in memory.
      getProviders().storage.set(
        STORAGE_KEY,
        JSON.stringify({
          session: s,
          answers: a,
          index: i,
          showReveal: sr,
          showCoach: sc,
          elicitation: el,
          lockInN: li,
          profilePrior: pp,
        }),
      )
    },
    [],
  )

  const clearStorage = useCallback(() => {
    getProviders().storage.remove(STORAGE_KEY)
  }, [])

  const current: CalibrationPosition | null =
    session && index < session.positions.length ? session.positions[index] : null

  const resetInputs = useCallback(() => {
    setEvalInput("")
    setEvalRange(null)
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
      const sampled = await sampleSession(size, {}, (p) => setProgress(p))
      // Phase A (spec 213 adaptive elicitation): reorder the sampled set so
      // the head of the session pins the labeler's least-pinned phase. Prior
      // saved sessions are the prior — a returning user with a locked profile
      // gets no burst at all. Best-effort: an unreadable prior means a fresh-
      // labeler plan, never a blocked session.
      let prior: LabelerProfile | null = null
      try {
        prior = buildProfileFromResults(await loadPriorResults())
      } catch {
        prior = null
      }
      const { session: s, lockInCount } = applyLockIn(sampled, prior)
      setSession(s)
      setAnswers([])
      setIndex(0)
      setRevealed(null)
      // Range elicitation applies at NEW session boundaries only — every fresh
      // session is a range session (spec 213).
      setElicitation("range")
      setLockInN(lockInCount)
      setProfilePrior(prior)
      resetInputs()
      setPhase("answering")
      persist(s, [], 0, showReveal, showCoach, "range", lockInCount, prior)
    } catch (e) {
      setError(String(e))
      setPhase("intro")
    }
  }, [size, persist, resetInputs, showReveal, showCoach])

  const continueSaved = useCallback(() => {
    if (!resume) return
    setSession(resume.session)
    setAnswers(resume.answers)
    setIndex(resume.index)
    setShowReveal(resume.showReveal ?? true)
    setShowCoach(resume.showCoach ?? true)
    // A session that started with point answers finishes with point answers —
    // never mix elicitation modes mid-session.
    setElicitation(resume.elicitation ?? "point")
    // A pre-Phase-A save had no lock-in burst; its order stands as saved.
    setLockInN(resume.lockInN ?? 0)
    setProfilePrior(resume.profilePrior ?? null)
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
          show_coach: showCoach,
          elicitation,
          lock_in_n: lockInN,
          profile_prior: profilePrior,
          session: s,
          answers: finalAnswers,
          summary,
        })
        if (path) setSavedPath(path)
      } catch (e) {
        setError(String(e))
      }
    },
    [clearStorage, showReveal, showCoach, elicitation, lockInN, profilePrior],
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
      persist(session, finalAnswers, nextIndex, showReveal, showCoach, elicitation, lockInN, profilePrior)
    },
    [session, index, finish, resetInputs, persist, showReveal, showCoach, elicitation, lockInN, profilePrior],
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
      const now = Date.now()
      // Range sessions store the asserted range plus a DERIVED representative
      // point in `eval` (point back-compat: correlation/scatter/coach keep
      // working); point sessions store the typed number and no range.
      let evalPoint: number | null = null
      let evalLo: number | null = null
      let evalHi: number | null = null
      if (!skipped) {
        if (elicitation === "range") {
          if (evalRange) {
            evalLo = evalRange.lo
            evalHi = evalRange.hi
            evalPoint = rangePoint(evalRange)
          }
        } else {
          const parsed = parseFloat(evalInput)
          evalPoint = Number.isNaN(parsed) ? null : parsed
        }
      }
      // answer_locked_at is stamped HERE, before any second look or reveal
      // renders — neither can influence the committed answer.
      const answer: CalibrationAnswer = {
        index,
        eval: evalPoint,
        eval_lo: evalLo,
        eval_hi: evalHi,
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
        coach: null,
        rebuttal: null,
        coach_reply: null,
        skipped,
      }
      const nextAnswers = [...answers.filter((a) => a.index !== index), answer].sort(
        (a, b) => a.index - b.index,
      )
      setAnswers(nextAnswers)
      // Persist immediately at the locked index so a crash mid-step never loses
      // the answer (resume lands on the next position).
      persist(session, nextAnswers, index + 1, showReveal, showCoach, elicitation, lockInN, profilePrior)
      // Straight to the reveal. (The second-look step was retired 2026-07-14:
      // under the X/✓ commit model everything is editable until commit, so a
      // post-commit "revise" prompt added friction without adding data. Old
      // answers keep their revised_* fields.)
      proceedToReveal(answer, current, nextAnswers)
    },
    [session, current, elicitation, evalRange, evalInput, why, moveUci, timeExcluded, index, answers, persist, showReveal, showCoach, lockInN, profilePrior, proceedToReveal],
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
        persist(session, finalAnswers, index + 1, showReveal, showCoach, elicitation, lockInN, profilePrior)
      }
      proceedToReveal(answer, secondLook.position, finalAnswers)
    },
    [secondLook, session, answers, index, persist, showReveal, showCoach, elicitation, lockInN, profilePrior, proceedToReveal],
  )

  const onContinueReveal = useCallback(() => advance(answers), [advance, answers])

  // Store the coach's critique on its answer when it arrives (async, after the
  // reveal). Doesn't touch the committed eval/why — additive only.
  const onCoachResult = useCallback(
    (answerIndex: number, coach: CoachFeedback) => {
      setAnswers((prev) => {
        const next = prev.map((a) => (a.index === answerIndex ? { ...a, coach } : a))
        if (session) persist(session, next, index + 1, showReveal, showCoach, elicitation, lockInN, profilePrior)
        return next
      })
    },
    [session, index, persist, showReveal, showCoach, elicitation, lockInN, profilePrior],
  )

  // Store the user's rebuttal + the coach's follow-up reply on its answer.
  // Additive only, like onCoachResult — the committed answer never changes.
  const onRebuttal = useCallback(
    (answerIndex: number, rebuttal: string, reply: string | null) => {
      setAnswers((prev) => {
        const next = prev.map((a) => (a.index === answerIndex ? { ...a, rebuttal, coach_reply: reply } : a))
        if (session) persist(session, next, index + 1, showReveal, showCoach, elicitation, lockInN, profilePrior)
        return next
      })
    },
    [session, index, persist, showReveal, showCoach, elicitation, lockInN, profilePrior],
  )

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
  const onRangeSelect = useCallback(
    (r: EvalRange) => {
      markInteraction()
      setEvalRange(r)
    },
    [markInteraction],
  )

  // Committing requires a move AND an eval (2026-07-14). The written "why" is
  // bonus — the coach evaluates the move alone and the dialogue can fill in
  // the reasoning afterwards.
  const evalGiven =
    elicitation === "range"
      ? evalRange !== null
      : evalInput.trim() !== "" && !Number.isNaN(parseFloat(evalInput))
  const canSubmit = evalGiven && moveUci !== null

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

  // Launch a playout from the revealed position (spec 211 "Play it out"): the
  // user plays the side the ENGINE eval favours — that's the claim under test
  // — at a default level from the source game's Elo band.
  const startPlayout = useCallback(() => {
    if (!revealed) return
    const p = revealed.position
    setPlayout({
      fen: p.fen,
      evalPawns: evalPawnsOf(p.sf_cp, p.sf_mate),
      source: "calibration",
      label: p.deck,
      defaultLevel: levelForEloBand(p.elo_band),
    })
  }, [revealed])

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

  // Playout takes over the whole tab while active; everything else (session,
  // answers, the open reveal) stays mounted in state underneath.
  if (playout) {
    return (
      <div className="h-full flex flex-col text-foreground">
        <PlayoutScreen request={playout} onExit={() => setPlayout(null)} />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col text-foreground">
      {phase === "intro" && (
        <IntroScreen
          size={size}
          setSize={setSize}
          showReveal={showReveal}
          setShowReveal={setShowReveal}
          showCoach={showCoach}
          setShowCoach={setShowCoach}
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
          lockInN={lockInN}
          position={current}
          boardSize={boardSize}
          setBoardSize={setBoardSize}
          legalMoves={legalMoves}
          moveShapes={moveShapes}
          moveUci={moveUci}
          onBoardMove={onBoardMove}
          onClearMove={() => {
            // Take-back: clear the stored move AND force a board rebuild so
            // the visually-moved piece snaps home (chessground keeps its own
            // state; the fen prop alone doesn't change here).
            setMoveUci(null)
            setBoardNonce((n) => n + 1)
          }}
          boardNonce={boardNonce}
          elicitation={elicitation}
          evalInput={evalInput}
          setEvalInput={onEvalChange}
          evalRange={evalRange}
          onRangeSelect={onRangeSelect}
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
          showCoach={showCoach}
          onCoachResult={onCoachResult}
          onRebuttal={onRebuttal}
          onPlayout={startPlayout}
          onNext={() => submit(false)}
          onSkip={() => submit(true)}
        />
      )}

      {phase === "results" && session && (
        <ResultsScreen
          session={session}
          answers={answers}
          profilePrior={profilePrior}
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
  showCoach,
  setShowCoach,
  onStart,
  error,
}: {
  size: number
  setSize: (n: number) => void
  showReveal: boolean
  setShowReveal: (b: boolean) => void
  showCoach: boolean
  setShowCoach: (b: boolean) => void
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
              Pick the eval <span className="text-foreground">range</span> that matches your read —{" "}
              <span className="text-foreground">+ favours White</span> (e.g.{" "}
              <code className="text-foreground">1–2</code> on the White row means &ldquo;White is
              better by one to two pawns&rdquo;). Nobody distinguishes +1.6 from +1.8, so the
              ranges are the honest scale.
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
        <label
          className={`flex items-start gap-2 text-sm select-none ${
            showReveal ? "cursor-pointer" : "opacity-50 cursor-not-allowed"
          }`}
        >
          <input
            type="checkbox"
            checked={showCoach && showReveal}
            disabled={!showReveal}
            onChange={(e) => setShowCoach(e.target.checked)}
            data-testid="calib-show-coach"
            className="mt-0.5 accent-emerald-500"
          />
          <span>
            <span className="text-foreground">AI coach feedback</span>
            <span className="text-muted-foreground">
              {" "}— after each reveal, Claude reads your written reasoning and points out where it
              diverged from the engine. Needs an API key; off means no API calls.
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
  lockInN,
  position,
  boardSize,
  setBoardSize,
  legalMoves,
  moveShapes,
  moveUci,
  onBoardMove,
  onClearMove,
  boardNonce,
  elicitation,
  evalInput,
  setEvalInput,
  evalRange,
  onRangeSelect,
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
  showCoach,
  onCoachResult,
  onRebuttal,
  onPlayout,
  onNext,
  onSkip,
}: {
  session: CalibrationSession
  index: number
  /** Phase A: positions before this index are the profile lock-in burst. */
  lockInN: number
  position: CalibrationPosition
  boardSize: number
  setBoardSize: (n: number) => void
  legalMoves: Map<Key, Key[]>
  moveShapes: DrawShape[]
  moveUci: string | null
  onBoardMove: (from: Key, to: Key) => void
  onClearMove: () => void
  boardNonce: number
  elicitation: Elicitation
  evalInput: string
  setEvalInput: (s: string) => void
  evalRange: EvalRange | null
  onRangeSelect: (r: EvalRange) => void
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
  showCoach: boolean
  onCoachResult: (index: number, coach: CoachFeedback) => void
  onRebuttal: (index: number, rebuttal: string, reply: string | null) => void
  /** "Play it out" (spec 211): start a live playout from the revealed position. */
  onPlayout: () => void
  onNext: () => void
  onSkip: () => void
}) {
  const whiteToMove = position.fen.includes(" w ")
  const total = session.positions.length
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-6 py-3 border-b border-white/10 flex items-center justify-between">
        <span className="text-sm font-medium tabular-nums flex items-center gap-2">
          <span>
            Position {index + 1} <span className="text-muted-foreground">of {total}</span>
          </span>
          {/* Phase-A lock-in chip: safe to show while answering — it says only
              that this opening position pins the per-phase profile, nothing
              about the eval (the phase is visible on the board anyway). */}
          {index < lockInN && (
            <span
              data-testid="calib-lockin"
              title="Profile lock-in (spec 213 Phase A): these opening positions pin your per-phase profile so the rest of your answers read as a known-level human's perception. Sessions after your profile locks skip this."
              className="px-1.5 py-0.5 rounded text-[11px] font-normal bg-sky-500/15 text-sky-200/90"
            >
              lock-in {index + 1}/{lockInN}
            </span>
          )}
          {/* Deck chip only AFTER the answer is locked (reveal/second-look):
              during answering it would anchor — "level" literally says the
              eval is near zero, "conversion" says there's a real advantage. */}
          {position.deck && (reveal || secondLook) && (
            <span
              data-testid="calib-deck"
              className="px-1.5 py-0.5 rounded text-[11px] font-normal capitalize bg-white/10 text-muted-foreground"
            >
              {position.deck}
            </span>
          )}
        </span>
        <div className="h-1.5 w-48 rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full bg-emerald-500"
            style={{ width: `${((index + 1) / total) * 100}%` }}
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 flex gap-8 p-6">
        {/* Board — side to move at the bottom, like playing the game yourself.
            Eval signs stay absolute (+ = White) regardless of orientation. */}
        <div className="flex-1 min-w-0 flex items-center justify-center" data-testid="calib-board">
          <Board
            key={boardNonce}
            fen={position.fen}
            orientation={whiteToMove ? "white" : "black"}
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
            <RevealCard
              reveal={reveal}
              onContinue={onContinueReveal}
              showCoach={showCoach}
              onCoachResult={onCoachResult}
              onRebuttal={onRebuttal}
              onPlayout={onPlayout}
            />
          ) : (
          <>

          {elicitation === "range" ? (
            <RangePicker selected={evalRange} onSelect={onRangeSelect} />
          ) : (
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
                    className="px-2.5 py-1.5 text-sm rounded border border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5 tabular-nums"
                  >
                    {v > 0 ? `+${v}` : v}
                  </button>
                ))}
              </div>
            </div>
          )}

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
            <label className="text-base font-medium">Your move</label>
            {moveUci ? (
              <div className="flex items-center gap-2 text-base text-muted-foreground">
                <span className="font-mono text-foreground">{moveUci}</span>
                <button
                  className="px-2 py-0.5 rounded border border-red-400/30 text-red-300/90 hover:bg-red-500/10 text-sm"
                  onClick={onClearMove}
                  title="Take back — try a different move"
                  data-testid="calib-takeback"
                >
                  ✕ take back
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-base text-amber-200/90">
                <span aria-hidden>↳</span>
                <span>Click the move you&apos;d play — required.</span>
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
              <Button
                onClick={onNext}
                disabled={!canSubmit}
                className="flex-1 text-base bg-emerald-600 hover:bg-emerald-500 text-white"
                title={canSubmit ? "Commit this answer" : "A move and an eval are required to commit"}
                data-testid="calib-next"
              >
                ✓ Commit
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

/** Compact magnitude label for a positive-side range: "0.1–0.3" … "2–4", "4+". */
function magnitudeLabel(r: EvalRange): string {
  if (r.hi == null) return `${r.lo}+`
  return `${r.lo}–${r.hi}`
}

/** Log-spaced range picker (spec 213 range elicitation): six White-better
 *  magnitudes, a level button, and the six mirrored Black-better magnitudes.
 *  Weber-Fechner spacing — the buttons ARE the answer scale; there is no
 *  free-typed point in range sessions. Button testids are stable:
 *  calib-range-w0..w5 (White, smallest magnitude first), calib-range-level,
 *  calib-range-b0..b5 (Black, smallest magnitude first). */
function RangePicker({
  selected,
  onSelect,
}: {
  selected: EvalRange | null
  onSelect: (r: EvalRange) => void
}) {
  const isSel = (r: EvalRange) => selected != null && selected.lo === r.lo && selected.hi === r.hi
  const btnClass = (r: EvalRange) =>
    `px-2 py-1.5 text-sm rounded border transition-colors tabular-nums ${
      isSel(r)
        ? "border-white/30 bg-white/10 text-foreground"
        : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
    }`
  const mirrored = (r: EvalRange): EvalRange => ({
    lo: r.hi == null ? null : -r.hi,
    hi: -(r.lo as number),
  })
  return (
    <div className="space-y-2" data-testid="calib-range">
      <label className="text-sm font-medium">Your eval — pick a range (pawns)</label>
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground w-14 shrink-0">White +</span>
          {POSITIVE_RANGES.map((r, i) => (
            <button key={i} data-testid={`calib-range-w${i}`} onClick={() => onSelect(r)} className={btnClass(r)}>
              {magnitudeLabel(r)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground w-14 shrink-0" aria-hidden />
          <button
            data-testid="calib-range-level"
            onClick={() => onSelect(LEVEL_RANGE)}
            className={`${btnClass(LEVEL_RANGE)} flex-1`}
          >
            level
          </button>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground w-14 shrink-0">Black −</span>
          {POSITIVE_RANGES.map((r, i) => (
            <button
              key={i}
              data-testid={`calib-range-b${i}`}
              onClick={() => onSelect(mirrored(r))}
              className={btnClass(mirrored(r))}
            >
              {magnitudeLabel(r)}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground min-h-4" data-testid="calib-range-assertion">
        {selected ? `You're asserting ${formatRange(selected)} (White-POV)` : "Nobody distinguishes +1.6 from +1.8 — pick the band you'd stand behind."}
      </p>
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
 *  and its margin, what the rated human actually played, and — when the coach is
 *  on — Claude's read of where their written reasoning diverged. */
function RevealCard({
  reveal,
  onContinue,
  showCoach,
  onCoachResult,
  onRebuttal,
  onPlayout,
}: {
  reveal: Reveal
  onContinue: () => void
  showCoach: boolean
  onCoachResult: (index: number, coach: CoachFeedback) => void
  onRebuttal: (index: number, rebuttal: string, reply: string | null) => void
  /** "Play it out" (spec 211): hand this position to a live playout vs Maia. */
  onPlayout: () => void
}) {
  const { answer, position } = reveal
  const sf = sfEvalPawns(position)
  const played = playedReveal(position)
  const gapPawns = position.multipv_gap_cp == null ? null : position.multipv_gap_cp / 100
  // Range answers score against the range edge (0 inside); point answers as before.
  const range = answerRange(answer)
  const offBy =
    answer.skipped ? null
    : range ? rangeError(sf, range)
    : answer.eval != null ? Math.abs(answer.eval - sf)
    : null

  // Coach: fire once per reveal. Never blocks Continue; degrades to a hint.
  const [coach, setCoach] = useState<CoachFeedback | null>(answer.coach)
  const [coachError, setCoachError] = useState<string | null>(null)
  const [coachLoading, setCoachLoading] = useState(false)
  // Rebuttal round: the user's reply to the note + the coach's reply to that.
  const [rebuttalText, setRebuttalText] = useState("")
  const [sentRebuttal, setSentRebuttal] = useState<string | null>(answer.rebuttal)
  const [coachReply, setCoachReply] = useState<string | null>(answer.coach_reply)
  const [replyLoading, setReplyLoading] = useState(false)
  const wantCoach = showCoach && !answer.skipped

  const sendRebuttal = useCallback(() => {
    const text = rebuttalText.trim()
    if (!text || !coach) return
    setSentRebuttal(text)
    setReplyLoading(true)
    coachFollowup(coachInputFor(answer, position), coach.note, text)
      .then((reply) => {
        setCoachReply(reply)
        onRebuttal(answer.index, text, reply)
      })
      .catch(() => {
        // Reply failed: keep the rebuttal (it's data), degrade the reply.
        setCoachReply(null)
        onRebuttal(answer.index, text, null)
      })
      .finally(() => setReplyLoading(false))
  }, [rebuttalText, coach, answer, position, onRebuttal])
  useEffect(() => {
    if (!wantCoach || answer.coach) {
      setCoach(answer.coach)
      return
    }
    let live = true
    setCoachLoading(true)
    setCoachError(null)
    coachFeedback(coachInputFor(answer, position))
      .then((fb) => {
        if (!live) return
        setCoach(fb)
        onCoachResult(answer.index, fb)
      })
      .catch((e) => live && setCoachError(String(e)))
      .finally(() => live && setCoachLoading(false))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer.index])

  return (
    <div className="flex flex-col gap-3" data-testid="calib-reveal">
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-2.5">
        <div className="flex items-center justify-between text-base">
          <span className="text-muted-foreground">Your eval</span>
          <span className="font-mono tabular-nums" data-testid="calib-reveal-your-eval">
            {range
              ? formatRange(range)
              : answer.skipped || answer.eval == null
                ? "skipped"
                : formatPawns(answer.eval)}
          </span>
        </div>
        <div className="flex items-center justify-between text-base">
          <span className="text-muted-foreground">Stockfish</span>
          <span className="font-mono tabular-nums text-foreground">{formatPawns(sf)}</span>
        </div>
        {offBy != null && (
          <div className="flex items-center justify-between text-base border-t border-white/10 pt-2">
            <span className="text-muted-foreground">Off by</span>
            {range && offBy === 0 ? (
              <span className="font-mono tabular-nums text-emerald-300" data-testid="calib-in-range">
                in range ✓
              </span>
            ) : (
              <span className="font-mono tabular-nums text-amber-300">{offBy.toFixed(1)}</span>
            )}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-1.5 text-base">
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
        {position.sf_pv_san && position.sf_pv_san.length >= 2 && (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground shrink-0">Line</span>
            <span
              className="font-mono text-xs text-muted-foreground text-right"
              data-testid="calib-pv-line"
            >
              {position.sf_pv_san.join(" ")}
            </span>
          </div>
        )}
      </div>

      {played && <p className="text-sm text-emerald-300/90">{played}</p>}

      {wantCoach && (
        <div className="rounded-lg border border-sky-500/20 bg-sky-500/[0.06] p-3 space-y-2" data-testid="calib-coach">
          <span className="text-xs font-semibold text-sky-300/90">Coach</span>
          {coachLoading && <p className="text-sm text-muted-foreground">Reading your reasoning…</p>}
          {coach && (
            <>
              <p className="text-sm text-foreground/90">{coach.note}</p>
              {coach.cause_tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {coach.cause_tags.map((t) => (
                    <span
                      key={t}
                      className="px-1.5 py-0.5 rounded text-[11px] bg-sky-500/15 text-sky-200/90"
                    >
                      {t.replace(/_/g, " ")}
                    </span>
                  ))}
                </div>
              )}
              {sentRebuttal == null ? (
                <div className="space-y-1.5 pt-1" data-testid="calib-rebuttal-form">
                  <Textarea
                    value={rebuttalText}
                    onChange={(e) => setRebuttalText(e.target.value)}
                    placeholder="Respond to the coach (optional) — e.g. “I saw that move, but…”"
                    className="min-h-[60px] text-sm"
                    data-testid="calib-rebuttal-input"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={rebuttalText.trim() === ""}
                    onClick={sendRebuttal}
                    data-testid="calib-rebuttal-send"
                  >
                    Send
                  </Button>
                </div>
              ) : (
                <div className="space-y-1.5 pt-1 border-t border-sky-500/15" data-testid="calib-rebuttal-thread">
                  <p className="text-sm text-foreground/80 italic">You: {sentRebuttal}</p>
                  {replyLoading && <p className="text-sm text-muted-foreground">Coach is considering…</p>}
                  {coachReply && <p className="text-sm text-foreground/90">{coachReply}</p>}
                  {!replyLoading && !coachReply && (
                    <p className="text-xs text-muted-foreground">Reply unavailable — your response is saved.</p>
                  )}
                </div>
              )}
            </>
          )}
          {coachError && !coach && (
            <p className="text-xs text-muted-foreground">
              Coach unavailable ({coachError.includes("ANTHROPIC_API_KEY") || coachError.includes("not found") ? "add an ANTHROPIC_API_KEY" : "request failed"}).
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2 mt-1">
        <Button onClick={onContinue} className="flex-1" data-testid="calib-continue">
          Continue
        </Button>
        <Button
          variant="outline"
          onClick={onPlayout}
          title="Play this position to a result vs a Maia band — the outcome is scored against the engine's claim (converted / held / dropped). Your session waits here."
          data-testid="calib-playout"
        >
          Play it out
        </Button>
      </div>
    </div>
  )
}

function ResultsScreen({
  session,
  answers,
  profilePrior,
  savedPath,
  onLoadPosition,
  onRestart,
}: {
  session: CalibrationSession
  answers: CalibrationAnswer[]
  /** Phase A: the labeler profile before this session, or null (fresh). */
  profilePrior: LabelerProfile | null
  savedPath: string | null
  onLoadPosition: (fen: string) => void
  onRestart: () => void
}) {
  const summary = useMemo(() => summarize(session, answers), [session, answers])
  const points = useMemo(() => scoredAnswers(session, answers), [session, answers])
  // The labeler profile with this session folded in — the Phase-A "fun
  // by-product" display (design doc §6.1).
  const profile = useMemo(
    () => mergeProfiles(profilePrior ?? emptyProfile(), profileOfSession(session, answers)),
    [profilePrior, session, answers],
  )

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

        <DeckTable perDeck={summary.perDeck} />

        <ProfileCard profile={profile} />

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
                        you{" "}
                        <span className="text-foreground">
                          {m.userRange ? formatRange(m.userRange) : formatPawns(m.userEval)}
                        </span>
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

/** Per-deck accuracy — the v3 training axis (conversion / critical / endgame /
 *  level). Hidden entirely on v1/v2 sessions, whose positions carry no deck;
 *  only decks that actually appeared get a row. */
function DeckTable({ perDeck }: { perDeck: DeckStat[] }) {
  const fmt = (v: number | null, digits = 2) => (v == null ? "—" : v.toFixed(digits))
  const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`)
  const present = perDeck.filter((d) => d.count > 0)
  if (present.length === 0) return null
  return (
    <div className="space-y-2" data-testid="calib-deck-table">
      <h2 className="text-sm font-semibold text-muted-foreground">By training deck</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground text-left border-b border-white/10">
            <th className="py-1.5 font-medium">Deck</th>
            <th className="py-1.5 font-medium text-right">Positions</th>
            <th className="py-1.5 font-medium text-right">MAE</th>
            <th className="py-1.5 font-medium text-right">Correlation</th>
            <th className="py-1.5 font-medium text-right">Best-move</th>
          </tr>
        </thead>
        <tbody>
          {present.map((d) => (
            <tr key={d.deck} className="border-b border-white/5">
              <td className="py-1.5 capitalize">{d.deck}</td>
              <td className="py-1.5 text-right tabular-nums">{d.count}</td>
              <td className="py-1.5 text-right tabular-nums">{fmt(d.mae)}</td>
              <td className="py-1.5 text-right tabular-nums">{fmt(d.pearson)}</td>
              <td className="py-1.5 text-right tabular-nums">
                {d.bestMoveHitRate == null ? "—" : pct(d.bestMoveHitRate)}
                {d.moveAnswers > 0 && (
                  <span className="text-muted-foreground text-xs"> ({d.moveAnswers})</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The labeler profile across ALL saved sessions, this one included — Phase A's
 *  "fun by-product" (spec 213 adaptive elicitation). A locked phase means the
 *  next session skips its share of the lock-in burst; the point is provenance:
 *  labels read as THIS profile's perception. */
function ProfileCard({ profile }: { profile: LabelerProfile }) {
  const fmt = (v: number | null) => (v == null ? "—" : v.toFixed(2))
  const signed = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`)
  return (
    <div className="space-y-2" data-testid="calib-profile">
      <h2 className="text-sm font-semibold text-muted-foreground">Labeler profile</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground text-left border-b border-white/10">
            <th className="py-1.5 font-medium">Phase</th>
            <th className="py-1.5 font-medium text-right">Answers</th>
            <th className="py-1.5 font-medium text-right">MAE</th>
            <th className="py-1.5 font-medium text-right">Bias</th>
            <th className="py-1.5 font-medium text-right">Status</th>
          </tr>
        </thead>
        <tbody>
          {profile.per_phase.map((c) => (
            <tr key={c.phase} className="border-b border-white/5">
              <td className="py-1.5 capitalize">{c.phase}</td>
              <td className="py-1.5 text-right tabular-nums">{c.count}</td>
              <td className="py-1.5 text-right tabular-nums">{fmt(c.mae)}</td>
              <td className="py-1.5 text-right tabular-nums">{signed(c.bias)}</td>
              <td className="py-1.5 text-right">
                {c.count >= PROFILE_LOCK_N ? (
                  <span className="text-emerald-300">locked ✓</span>
                ) : (
                  <span className="text-muted-foreground">
                    {PROFILE_LOCK_N - c.count} more to lock
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">
        Across {profile.sessions} session{profile.sessions === 1 ? "" : "s"} ({profile.answers}{" "}
        answers): overall bias {signed(profile.bias)} (+ = you lean White), spread ±{fmt(profile.sd)}{" "}
        pawns. A locked phase means future sessions skip its lock-in burst — your labels then read
        as a known-level human&apos;s perception (spec 213 Phase A).
      </p>
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

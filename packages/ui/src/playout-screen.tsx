"use client"

// Play it out (spec 211 checklist item; spec 215 Tier 1 endgame_playout).
//
// Takes a PlayoutRequest (a FEN + the eval claim being tested) from a launch
// surface — the calibration reveal, a Training-tab endgame exercise, or a
// future 211 puzzle — and plays it to a result against a Maia band via the
// persona engine (outside Tauri the persona mock keeps this drivable headless,
// like the spar screen). The user plays the side the eval claim favours; at
// game end the result is scored against the claim (lib/playout: converted /
// held / dropped) and stored in the playout store via usePlayoutRecorder.
//
// This screen runs its own small game loop, independent of the main analysis
// board — the same pattern as spar-tab (which it deliberately does NOT wrap:
// SparTab owns roster/book/persona-feedback machinery a playout never uses,
// and it takes no start-position props; a parallel workstream owns that file).
// Like the spar loop it is unclocked and does not detect threefold repetition —
// the Offer draw rule is the honest fallback shared with spar.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import type { Key } from "@lichess-org/chessground/types"
import type { DrawShape } from "@lichess-org/chessground/draw"
import { Chess } from "chessops/chess"
import { parseFen } from "chessops/fen"
import { chessgroundDests } from "chessops/compat"
import { Button } from "@chessgui/ui/ui/button"
import { Switch } from "@chessgui/ui/ui/switch"
import { personaMove, DEFAULT_PERSONA_PARAMS } from "@/lib/persona"
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
import {
  appendPlayoutResult,
  buildPlayoutAbandon,
  claimFor,
  expectedScoreFor,
  loadPlayoutResults,
  persistPlayoutResults,
  playoutUserSide,
  DEFAULT_PLAYOUT_LEVEL,
  VERDICT_LABELS,
  type PlayoutRequest,
} from "@/lib/playout"
import { usePlayoutRecorder } from "@/hooks/use-playout-recorder"
import type { SparResultMode } from "@/lib/spar-results"
import { MAIA_ROSTER_BANDS } from "@/lib/roster"

const Board = dynamic(() => import("@chessgui/ui/board").then((m) => ({ default: m.Board })), {
  ssr: false,
})

interface PlayoutScreenProps {
  request: PlayoutRequest
  /** Back to the launching surface. Exiting an unfinished game records an
   *  abandon entry first (spec 215 playout hardening) — never a verdict. */
  onExit: () => void
}

/** A per-game seed for the persona engine's seeded sampling (spec 214 step 8);
 *  below 2^53 so it survives the JSON number round-trip to Rust. */
function newGameSeed(): number {
  return Math.floor(Math.random() * 2 ** 53)
}

function legalDests(fen: string): Map<Key, Key[]> {
  const setup = parseFen(fen)
  if (setup.isErr) return new Map()
  const pos = Chess.fromSetup(setup.unwrap())
  if (pos.isErr) return new Map()
  return chessgroundDests(pos.unwrap()) as Map<Key, Key[]>
}

/** "+2.1" / "−1.5" — White-POV pawns, signed. */
function formatSigned(pawns: number): string {
  return pawns > 0 ? `+${pawns.toFixed(1)}` : pawns.toFixed(1)
}

/** Compact numbered movetext ("31. Rd6+ Kf5 32. …"), honoring a start FEN
 *  that's mid-game with Black to move — same convention as the spar screen. */
function movetext(startFen: string, plies: SparPly[]): string {
  const fields = startFen.split(" ")
  let toMove: SparColor = fields[1] === "b" ? "black" : "white"
  let moveNum = parseInt(fields[5] ?? "1", 10) || 1
  const tokens: string[] = []
  for (const p of plies) {
    if (toMove === "white") {
      tokens.push(`${moveNum}.`, p.san)
    } else {
      if (tokens.length === 0) tokens.push(`${moveNum}…`)
      tokens.push(p.san)
      moveNum += 1
    }
    toMove = toMove === "white" ? "black" : "white"
  }
  return tokens.join(" ")
}

/** Raw backend error → one-liner (mirrors the spar screen's mapping). */
function humanizeMoveError(err: string): string {
  if (err.includes("lc0 not found")) {
    return "lc0 isn't installed — Play it out needs it (brew install lc0)."
  }
  if (err.includes("terminal")) return "No legal moves — the game is over."
  return `Opponent move failed: ${err}`
}

export function PlayoutScreen({ request, onExit }: PlayoutScreenProps) {
  const startFen = request.fen
  // The user plays the side the claim favours — fixed by the request, never a
  // choice (spec 211 "Play it out": test the claim, don't pick a side).
  const userSide = useMemo(
    () => playoutUserSide(request.evalPawns, turnOf(startFen)),
    [request.evalPawns, startFen],
  )
  const oppSide: SparColor = userSide === "white" ? "black" : "white"
  const expected = useMemo(
    () => expectedScoreFor(request.evalPawns, userSide),
    [request.evalPawns, userSide],
  )
  const claim = claimFor(expected)

  const [phase, setPhase] = useState<"config" | "playing">("config")
  const [level, setLevel] = useState(request.defaultLevel ?? DEFAULT_PLAYOUT_LEVEL)
  // Declared intent (spec 215, the spar template): serious playouts feed the
  // eg_conversion metric by default; probe playouts are stored flagged and
  // never count. Defaults to serious + counting for every launch surface.
  const [playoutMode, setPlayoutMode] = useState<SparResultMode>("serious")
  const [countsTowardTraining, setCountsTowardTraining] = useState(true)
  // Rendered disabled and forced off for probe, but this is the actual
  // recorded value — never trust the UI state alone.
  const effectiveCountsTowardTraining = playoutMode === "probe" ? false : countsTowardTraining

  const [fen, setFen] = useState(startFen)
  const [plies, setPlies] = useState<SparPly[]>([])
  const [thinking, setThinking] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [boardNonce, setBoardNonce] = useState(0)
  const [gameSeed, setGameSeed] = useState<number>(() => newGameSeed())
  const [manualEnd, setManualEnd] = useState<{ label: string } | null>(null)
  const [lastDrawOfferPly, setLastDrawOfferPly] = useState<number | null>(null)
  const [drawDeclinedNote, setDrawDeclinedNote] = useState(false)
  const drawDeclinedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(drawDeclinedTimer.current), [])

  // Stale-async guard: the FEN an opponent reply is being computed for.
  const pendingFenRef = useRef<string | null>(null)

  // Wall-clock game start, for the elapsed time an abandon entry records.
  const startedAtRef = useRef(0)

  // Start-position sanity: a malformed/terminal FEN can't be played out.
  const startProblem = useMemo(() => {
    const setup = parseFen(startFen)
    if (setup.isErr) return "This position's FEN is malformed."
    const pos = Chess.fromSetup(setup.unwrap())
    if (pos.isErr) return "This position is illegal."
    if (pos.unwrap().isEnd()) return "This position is already over — nothing to play out."
    return null
  }, [startFen])

  const status = useMemo(() => {
    if (manualEnd) return { over: true, label: manualEnd.label }
    return sparStatus(fen)
  }, [fen, manualEnd])
  const frozen = status.over

  // Record the finished game to the playout store (distinct from spar results)
  // and read back exactly what was stored, for the verdict card.
  const recorded = usePlayoutRecorder({
    active: phase === "playing",
    over: status.over,
    resultLabel: status.label,
    source: request.source,
    fen: startFen,
    positionId: request.positionId,
    evalPawns: request.evalPawns,
    userSide,
    level,
    mode: playoutMode,
    plies: plies.length,
    gameKey: boardNonce,
    countsTowardTraining: effectiveCountsTowardTraining,
  })

  const startGame = useCallback(() => {
    if (startProblem) return
    pendingFenRef.current = null
    setThinking(false)
    setMoveError(null)
    setManualEnd(null)
    setLastDrawOfferPly(null)
    setDrawDeclinedNote(false)
    setGameSeed(newGameSeed())
    setFen(startFen)
    setPlies([])
    setBoardNonce((n) => n + 1)
    startedAtRef.current = Date.now()
    setPhase("playing")
  }, [startProblem, startFen])

  // Opponent reply whenever it's their turn at the live tip — the spar loop's
  // persona path, minus the book (a Maia band has no opening book, and most
  // playouts start mid-game anyway).
  useEffect(() => {
    if (phase !== "playing" || !fen) return
    if (turnOf(fen) !== oppSide) return
    if (frozen) return

    let live = true
    pendingFenRef.current = fen
    setThinking(true)
    setMoveError(null)
    const movePly = plies.length
    personaMove(fen, {
      ...DEFAULT_PERSONA_PARAMS,
      level,
      seed: gameSeed,
      ply: movePly,
    })
      .then((decision) => {
        if (!live || pendingFenRef.current !== fen) return
        const ply = applyUci(fen, decision.uci)
        if (!ply) {
          setMoveError(`Opponent returned an illegal move (${decision.uci}).`)
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
  }, [phase, fen, oppSide, frozen, level, gameSeed, plies.length])

  const userToMove = phase === "playing" && !!fen && turnOf(fen) === userSide && !frozen
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

  // Take back to the user's previous turn; if the game was ended by resign /
  // draw agreed, take-back's first job is to undo that (the recorder withdraws
  // the stored entry — same contract as the spar recorder).
  const takeBack = useCallback(() => {
    if (thinking) return
    if (manualEnd) {
      pendingFenRef.current = null
      setManualEnd(null)
      setMoveError(null)
      return
    }
    if (plies.length === 0) return
    pendingFenRef.current = null
    const next = plies.slice()
    next.pop()
    while (next.length > 0 && turnOf(next[next.length - 1].fen) !== userSide) next.pop()
    const revertFen = next.length > 0 ? next[next.length - 1].fen : startFen
    setPlies(next)
    setFen(revertFen)
    setThinking(false)
    setMoveError(null)
    setBoardNonce((n) => n + 1)
  }, [thinking, plies, userSide, startFen, manualEnd])

  const resign = useCallback(() => {
    if (frozen || thinking) return
    pendingFenRef.current = null
    const resultTag = userSide === "white" ? "0-1" : "1-0"
    setManualEnd({ label: `You resigned — ${resultTag}` })
  }, [frozen, thinking, userSide])

  // One offer per 10 plies; acceptance by the shared honest fallback rule.
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

  // Exit mid-game records an abandon entry (spec 215 playout hardening) —
  // otherwise abandons are invisible to the training aggregates. Written
  // directly (not via the recorder hook: that fires on game ends, this on a
  // click); countsTowardTraining is forced false by the builder, so an
  // abandon can never inflate eg_conversion. A finished game just exits —
  // the recorder already stored its verdict.
  const exitPlayout = useCallback(() => {
    if (phase === "playing" && !status.over) {
      persistPlayoutResults(
        appendPlayoutResult(
          loadPlayoutResults(),
          buildPlayoutAbandon({
            source: request.source,
            fen: startFen,
            positionId: request.positionId,
            evalPawns: request.evalPawns,
            userSide,
            level,
            mode: playoutMode,
            plies: plies.length,
            elapsedMs: Date.now() - startedAtRef.current,
          }),
        ),
      )
    }
    onExit()
  }, [phase, status.over, request, startFen, userSide, level, playoutMode, plies.length, onExit])

  const lastShape = useMemo<DrawShape[]>(() => {
    if (plies.length === 0) return []
    const uci = plies[plies.length - 1].uci
    return [{ orig: uci.slice(0, 2) as Key, dest: uci.slice(2, 4) as Key, brush: "green" }]
  }, [plies])

  const sideLabel = userSide === "white" ? "White" : "Black"
  const claimLine =
    `Engine says ${formatSigned(request.evalPawns)} — ` +
    (claim === "win" ? `a win is claimed for ${sideLabel}` : `${sideLabel} should hold`) +
    ` (expected score ~${Math.round(expected * 100)}%).`

  // ---------------------------------------------------------------------
  // Config screen: the claim, the fixed side, and the opponent band.
  // ---------------------------------------------------------------------
  if (phase === "config") {
    return (
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6" data-testid="playout-config">
        <div className="max-w-xl w-full space-y-5">
          <div>
            <button
              onClick={onExit}
              className="text-xs text-muted-foreground hover:text-foreground"
              data-testid="playout-back"
            >
              ‹ Back
            </button>
            <h1 className="text-2xl font-bold mt-1">Play it out</h1>
            <p className="text-muted-foreground mt-1">
              Perceiving an advantage and converting it are different skills. Play this position to a
              result — the outcome is scored against what the eval claimed.
            </p>
          </div>

          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-1.5 text-sm">
            {request.label && (
              <div className="text-xs text-muted-foreground capitalize" data-testid="playout-label">
                {request.label}
              </div>
            )}
            <p className="text-foreground" data-testid="playout-claim">
              {claimLine}
            </p>
            <p className="text-muted-foreground">
              You play <span className="text-foreground">{sideLabel}</span> — the side whose claim is
              being tested.
            </p>
            <p className="font-mono text-xs text-muted-foreground break-all">{startFen}</p>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-muted-foreground">Opponent:</span>
            <div className="flex gap-1 flex-wrap">
              {MAIA_ROSTER_BANDS.map((n) => (
                <button
                  key={n}
                  data-testid={`playout-level-${n}`}
                  onClick={() => setLevel(n)}
                  className={`px-2.5 py-1.5 text-sm rounded-md border transition-colors tabular-nums ${
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
            Maia human-move model at that strength — the default follows the position&apos;s source
            band when one is known.
          </p>

          {/* Declared intent (spec 215, the spar template): mode picker +
              counts toggle. Probe forces the toggle off and disabled rather
              than lying about it. */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Mode:</span>
            <div className="flex gap-1">
              {(
                [
                  ["serious", "Serious playout"],
                  ["probe", "Probe (experiment)"],
                ] as [SparResultMode, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  data-testid={`playout-mode-${id}`}
                  onClick={() => setPlayoutMode(id)}
                  className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                    playoutMode === id
                      ? "border-white/30 bg-white/10 text-foreground"
                      : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {playoutMode === "probe" && (
            <p className="text-xs text-muted-foreground -mt-2">
              Probe playouts are stored flagged and never feed the endgame-conversion metric —
              experiment freely without polluting the signal.
            </p>
          )}
          <div className="flex items-center gap-2">
            <Switch
              checked={effectiveCountsTowardTraining}
              onCheckedChange={setCountsTowardTraining}
              disabled={playoutMode === "probe"}
              className="data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-white/15"
              data-testid="playout-counts-toggle"
            />
            <span
              className={`text-sm ${playoutMode === "probe" ? "text-muted-foreground/50" : "text-muted-foreground"}`}
              title={
                playoutMode === "probe"
                  ? "Probe playouts never count toward training (spec 215)."
                  : "This playout's verdict feeds the Training tab's endgame conversion."
              }
            >
              Counts toward training
            </span>
          </div>

          <Button
            onClick={startGame}
            size="lg"
            className="w-full"
            disabled={!!startProblem}
            data-testid="playout-start"
          >
            Start game
          </Button>
          {startProblem && (
            <p className="text-sm text-red-400" data-testid="playout-start-problem">
              {startProblem}
            </p>
          )}
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------
  // Playing screen.
  // ---------------------------------------------------------------------
  return (
    <div className="h-full flex flex-col" data-testid="playout-playing">
      <div className="px-6 py-3 border-b border-white/10 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-medium shrink-0">Play it out</span>
          <span className="text-xs text-muted-foreground truncate" data-testid="playout-claim">
            {claimLine} vs Maia {level}
          </span>
          {playoutMode === "probe" && (
            <span
              className="shrink-0 text-[10px] uppercase tracking-wide text-violet-300 border border-violet-300/30 rounded px-1.5 py-0.5"
              data-testid="playout-mode-badge"
              title="Probe playout: stored flagged, never counts toward training."
            >
              probe
            </span>
          )}
        </div>
        <span
          className={`inline-block px-2.5 py-1 rounded-md text-xs font-medium shrink-0 ${
            userSide === "white"
              ? "bg-white/90 text-black"
              : "bg-black/80 text-white border border-white/20"
          }`}
        >
          You play {sideLabel}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex gap-8 p-6">
        <div
          className="flex-1 min-w-0 flex items-center justify-center"
          data-testid="playout-board"
          data-fen={fen}
        >
          <Board
            key={boardNonce}
            fen={fen}
            orientation={userSide}
            movableColor={userSide}
            onMove={onBoardMove}
            legalMoves={legalMoves}
            autoShapes={lastShape}
            viewOnly={!userToMove}
          />
        </div>

        <div className="w-72 shrink-0 flex flex-col gap-4 overflow-auto">
          <div className="text-sm" data-testid="playout-turn">
            {status.over ? (
              <span className="text-amber-300 font-medium" data-testid="playout-status">
                {status.label}
              </span>
            ) : thinking ? (
              <span className="text-muted-foreground" data-testid="playout-thinking">
                Maia {level} is thinking…
              </span>
            ) : userToMove ? (
              <span className="text-emerald-300">Your move.</span>
            ) : (
              <span className="text-muted-foreground">Waiting…</span>
            )}
          </div>

          {/* The verdict — exactly what the recorder stored, never a parallel
              recompute (an unknown end label stores nothing and shows nothing). */}
          {recorded && (
            <div
              className={`rounded-lg border p-3 space-y-1 ${
                recorded.verdict === "converted"
                  ? "border-emerald-500/30 bg-emerald-500/[0.07]"
                  : recorded.verdict === "held"
                    ? "border-amber-500/30 bg-amber-500/[0.07]"
                    : "border-red-500/30 bg-red-500/[0.07]"
              }`}
              data-testid="playout-verdict"
              data-verdict={recorded.verdict}
            >
              <div
                className={`text-sm font-bold ${
                  recorded.verdict === "converted"
                    ? "text-emerald-300"
                    : recorded.verdict === "held"
                      ? "text-amber-300"
                      : "text-red-300"
                }`}
              >
                {VERDICT_LABELS[recorded.verdict]}
              </div>
              <p className="text-xs text-muted-foreground">
                The eval claimed {recorded.claim === "win" ? "a win" : "a hold"} (expected ~
                {Math.round(recorded.expectedScore * 100)}%); you scored{" "}
                {recorded.actualScore === 1 ? "1" : recorded.actualScore === 0.5 ? "½" : "0"}. Saved to
                your playout record{recorded.countsTowardTraining ? "" : " (doesn't count toward training)"}.
              </p>
            </div>
          )}

          {drawDeclinedNote && (
            <p className="text-xs text-muted-foreground" data-testid="playout-draw-declined">
              Maia {level} declined the draw offer.
            </p>
          )}

          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 flex-1 min-h-0 overflow-auto">
            <div className="text-xs font-semibold text-muted-foreground mb-2">Moves</div>
            {plies.length === 0 ? (
              <p className="text-xs text-muted-foreground">No moves yet.</p>
            ) : (
              <p className="font-mono text-sm break-words" data-testid="playout-movetext">
                {movetext(startFen, plies)}
              </p>
            )}
          </div>

          {moveError && (
            <p className="text-xs text-red-400" data-testid="playout-error">
              {moveError}
            </p>
          )}

          <div className="mt-auto pt-2 flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={resign}
                disabled={frozen || thinking}
                data-testid="playout-resign"
              >
                Resign
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={offerDraw}
                disabled={frozen || thinking || drawOfferOnCooldown}
                title={DRAW_OFFER_RULE_DESCRIPTION}
                data-testid="playout-offer-draw"
              >
                Offer draw
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={takeBack}
                disabled={thinking || (plies.length === 0 && !manualEnd)}
                data-testid="playout-takeback"
              >
                Take back
              </Button>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={startGame} data-testid="playout-retry">
                Retry position
              </Button>
              <Button variant="outline" size="sm" onClick={exitPlayout} data-testid="playout-exit">
                {status.over ? "Done" : "Exit (abandon)"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

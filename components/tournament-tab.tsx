"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { invoke, Channel } from "@tauri-apps/api/core"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  buildSeeds,
  buildParticipantSpecs,
  buildExhibitionSpec,
  newPersonaSeed,
  seedsForGames,
  buildProbabilityMap,
  buildEngineCurves,
  buildEngineWDL,
  buildTournamentResultExport,
  buildRoundRobinSpecs,
  roundRobinGameCount,
  buildCrossTable,
  buildStandings,
  estimateElo,
  buildRoundRobinExport,
  eloDelta,
  gameResult,
  gameError,
  isOk,
  summarizeErrors,
  uciSquares,
  averageEvalByPly,
  gameEvalSeries,
  evalBarDefaultForBaseMs,
  STANDARD_START_FEN,
  TIME_CONTROLS,
  MOVE_DELAY_OPTIONS,
  type BatchProgress,
  type BatchReport,
  type GameOutcome,
  type GameSpec,
  type LiveGame,
  type MoveEvent,
  type EvalEvent,
  type EvalMap,
  type ProbBin,
  type EngineCurveBin,
  type StartMode,
  type TaggedPosition,
  type EvalPoint,
  type LiveFrame,
  type ViewerControls,
  type Participant,
  type PersonaLogEntry,
  type Seed,
  type CrossTable,
  type EloEstimate,
  type RoundRobinResultExport,
  type SavedTournamentMeta,
  type PairCell,
} from "@/lib/tournament"
import { replayFens, movesToPgn, sansFromUci, numberMoves, type NumberedPly } from "@/lib/game-replay"
import { deriveWinProbCurve, type MoveSwing, type WinProbCurve } from "@/lib/win-prob"
import {
  analyzeGame,
  annotatedGamePgn,
  buildBandTrajectories,
  buildErrorProfiles,
  buildSeedBreakdown,
  buildTerminationQuality,
  errorProfileDelta,
  per100,
  DEFAULT_LOW_CLOCK_MS,
  CLOCK_BUCKETS,
  GAME_PHASES,
  type EngineErrorProfile,
  type GameAnalysis,
  type TrajectoryBand,
} from "@/lib/tournament-analysis"
import { buildTournamentRoster, type TournamentRosterEntry, type EngineOption } from "@/lib/tournament-roster"
import { loadRivalBook, type RivalBook } from "@/lib/rival-book"
import type { PersonaCandidate, PersonaDecision } from "@/lib/persona"
import { Slider } from "@/components/ui/slider"
import { Badge } from "@/components/ui/badge"
import { EvalBar } from "@/components/eval-bar"
import {
  DEFAULT_PRIOR_CURVE,
  paceFloor,
  paceStrength,
  secondsPerMoveOf,
  type EloCurve,
} from "@/lib/time-elo"
import { useMachineProfile, type MachineProfile } from "@/hooks/use-machine-profile"
import type { Key } from "@lichess-org/chessground/types"

const Board = dynamic(
  () => import("@/components/board").then((m) => ({ default: m.Board })),
  { ssr: false },
)

const STOCKFISH_DEFAULT = "/opt/homebrew/bin/stockfish"
const RECKLESS_DEFAULT =
  "/Users/hjalti/github/chessgui/engines/reckless"

const MAX_PLIES = 400

// Human-recognizable time-format presets (spec 216 UI:1) — one click fills the
// existing base/increment custom fields with the FACE VALUE (pre-pacing)
// clock. Distinct from TIME_CONTROLS above, which are engine-benchmark points
// (fast/standard/long/rapid) tuned for fair engine-vs-engine comparison rather
// than a human-recognizable format; both feed the same custom fields and are
// equally subject to playback-pace compression below.
const PLAYBACK_FORMATS: { id: string; label: string; baseS: number; incS: number }[] = [
  { id: "classical", label: "Classical — 40/2.5h+16s", baseS: 2.5 * 3600, incS: 16 },
  { id: "rapid216", label: "Rapid — 25+10", baseS: 25 * 60, incS: 10 },
  { id: "blitz216", label: "Blitz — 3+2", baseS: 3 * 60, incS: 2 },
]

// Playback-pace floor (spec 216 UI:2, tier-0 checklist 216:75): the slower of
// an observability floor (games blitz by too fast to watch below this) and
// 1.25x the machine's minimum compute time per move. Tier 0 has no measured
// per-move minimum yet (MachineProfile carries nps, not a move-time floor), so
// machineMinSeconds is a conservative placeholder until the Tier-1 time-odds
// ladder measures it directly.
const OBSERVABILITY_FLOOR_SECONDS = 0.3
const TIER0_MACHINE_MIN_SECONDS = 0.05

type RunningTally = {
  completed: number
  total: number
  engineA: number
  engineB: number
  draw: number
  errors: number
  aborted: number
}

/** One row of the live per-game result log (Phase 4 checklist item: "Per-game
 *  results stream into a compact running log"). Deliberately thinner than a
 *  full `GameOutcome` — just enough to render "game #, result, start eval"
 *  live as each `BatchProgress` event arrives, before the batch (and its full
 *  `ResultsExplorer` browser) finishes. */
type LiveResultRow = {
  gameId: number
  startEval: number | null
  result: string | null // "1-0" | "0-1" | "1/2-1/2" | null (errored)
  error: string | null
  aborted: boolean
}

// Format a millisecond duration as h:mm:ss / m:ss.
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => n.toString().padStart(2, "0")
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

// Short display label for an engine, derived from its binary path.
function engineLabel(path: string): string {
  const base = path.split("/").pop() || path
  return base.replace(/\.(exe|app)$/i, "")
}

// Display label for a wire Participant (spec 218 "Exhibition & tournament"):
// a UCI side shows its binary's short name (same derivation as engineLabel,
// pre-participant-dropdown behavior); a persona side shows its displayName
// (roster labels already carry the honest strength info — see
// lib/tournament-roster.ts — this is just the short game-log name).
function sideLabel(p: Participant): string {
  return p.kind === "uci" ? engineLabel(p.enginePath ?? p.displayName) : p.displayName
}

// Fresh per-run persona seed (spec 214 contract step 8): the runner derives
// each GAME's seed from this base + the game id, so every game in a batch is
// distinct yet reproducible from one Run click. Only persona sides carry a
// seed; a UCI side is returned unchanged.
function withFreshSeed(p: Participant): Participant {
  if (p.kind !== "persona" || !p.personaConfig) return p
  return { ...p, personaConfig: { ...p.personaConfig, seed: newPersonaSeed() } }
}

// Format a nodes-per-second bench figure for display (spec 216 machine profile).
function formatNps(nps: number): string {
  if (nps >= 1_000_000) return `${(nps / 1_000_000).toFixed(1)} Mnps`
  if (nps >= 1_000) return `${(nps / 1_000).toFixed(0)} knps`
  return `${nps} nps`
}

function formatMeasuredDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}

// Cache the tagged positions across runs so we only fetch once.
let positionsCache: TaggedPosition[] | null = null
async function loadPositions(): Promise<TaggedPosition[]> {
  if (positionsCache) return positionsCache
  const res = await fetch("/tagged_positions.json")
  if (!res.ok) throw new Error(`Failed to load positions: ${res.status}`)
  positionsCache = (await res.json()) as TaggedPosition[]
  return positionsCache
}

export function TournamentTab({
  onRunningChange,
  onLiveUpdate,
  onEvalBarChange,
  onViewerControls,
  onOpenGame,
  currentFen,
  bottomColor = "white",
  presetNonce = 0,
}: {
  /** Reports whether a batch is currently running (for the header View toggle). */
  onRunningChange?: (running: boolean) => void
  /** Streams the currently-featured live game to the board viewer (null = none). */
  onLiveUpdate?: (live: LiveGame | null) => void
  /** Reports whether the live eval bar should be shown alongside the live board. */
  onEvalBarChange?: (show: boolean) => void
  /** Hands the live-viewer control surface to the parent (null when not running). */
  onViewerControls?: (controls: ViewerControls | null) => void
  /** Load a completed game (as PGN) onto the main Analyze board. */
  onOpenGame?: (pgn: string) => void
  /** The FEN currently on the analysis board (for "Current position" mode). */
  currentFen?: string
  /** Which color is at the bottom of the user's board (board orientation). */
  bottomColor?: "white" | "black"
  /**
   * Bumped by the board view's "Play this out" button: enter Current-position
   * mode with its defaults (engine A on the user's side, 10m+5s, 2 games).
   */
  presetNonce?: number
} = {}) {
  // Participant dropdown (spec 218 "Exhibition & tournament" checklist item 1,
  // decision 5 picker style): each side is a roster entry id, not a free-text
  // binary path. Defaults to the two MVP engines so an untouched config
  // behaves exactly like the old free-text defaults did.
  const [sideAId, setSideAId] = useState("engine-stockfish")
  const [sideBId, setSideBId] = useState("engine-reckless")
  // Explicit per-side assignment (spec 218 item 1: "who is White in game 1" —
  // flipFirst still alternates within a pair, this only picks which roster
  // entry starts White). "current" mode keeps its own board-bottom-color
  // control (engineASide below) since that has a different intent ("my side
  // of the board"); this one is the general-purpose control for every mode.
  const [firstWhite, setFirstWhite] = useState<"a" | "b">("a")
  // Private rival gating (spec 218 decision 4 / spec 214 hard rule): his
  // roster entry exists only once his local book has loaded — mirrors
  // spar-tab.tsx's identical load-once-on-mount pattern so both surfaces
  // agree on when he's in scope.
  const [rivalBook, setRivalBook] = useState<RivalBook | null>(null)
  useEffect(() => {
    let live = true
    loadRivalBook()
      .then((b) => { if (live) setRivalBook(b) })
      .catch(() => { /* no local book — the rival entry simply doesn't exist */ })
    return () => { live = false }
  }, [])
  const [mode, setMode] = useState<StartMode>("eval")
  // Numeric fields are held as raw strings so they stay freely editable
  // (clearing/retyping); they are coerced to numbers with fallbacks in run().
  // Absolute imbalance band (pawns); sign is irrelevant under color flip.
  // Defaults tuned for the engine-comparison workflow (full 0-2.4 sweep, fast TC).
  const [minEval, setMinEval] = useState("0")
  const [maxEval, setMaxEval] = useState("2.4")
  const [nGames, setNGames] = useState("1000")
  const [concurrency, setConcurrency] = useState("0")
  // Time control: a preset id, or "custom" with editable base/increment (seconds).
  const [tcId, setTcId] = useState("fast")
  const [customBaseS, setCustomBaseS] = useState("60")
  const [customIncS, setCustomIncS] = useState("0.6")
  // Playback pace target (seconds/move the user wants to actually watch at).
  // null = real time (no compression, C=1); a number is the user's saved
  // preference, re-clamped to the current format's [floor, face value] range
  // on every render so it survives format changes without a stale slider jump.
  const [paceTargetSeconds, setPaceTargetSeconds] = useState<number | null>(null)
  const machineProfile = useMachineProfile()
  // Prefer this machine's measured b(t) curve once the Tier-1 ladder has fitted
  // one; fall back to the literature prior until then (spec 216:28-30). The
  // PRIOR/MEASURED badge reads its provenance straight off `curve.source`.
  const curve = (machineProfile.profile?.curve as EloCurve | null) ?? DEFAULT_PRIOR_CURVE
  // Adjudicate <=7-man positions via the tablebase (perfect play) — fair, since
  // any engine can bolt on a 7-man tablebase for free.
  const [adjudicateTb, setAdjudicateTb] = useState(true)
  // Neutral evaluator: a third engine that scores every position off the live
  // stream (never on a player's clock), driving the eval bar + progress graphs.
  const [useEvaluator, setUseEvaluator] = useState(true)
  const [evaluatorPath, setEvaluatorPath] = useState(STOCKFISH_DEFAULT)
  // "Show evaluation bar" beside the live board. Auto-derived from the time
  // control (on for base >= 60s) until the user explicitly toggles it, after
  // which their choice sticks across TC changes.
  const [showEvalBar, setShowEvalBar] = useState(false)
  const evalBarTouched = useRef(false)
  // Live-viewer batch controls (also settable pre-run). `autoStartNext` off makes
  // the runner pause between games; `moveDelayMs` throttles the on-board display.
  const [autoStartNext, setAutoStartNext] = useState(true)
  const [moveDelayMs, setMoveDelayMs] = useState(0)
  const [paused, setPaused] = useState(false)
  const [waitingForNext, setWaitingForNext] = useState(false)
  // Refs so the live stream callbacks (created once per run) read current values.
  const autoStartRef = useRef(true)
  useEffect(() => { autoStartRef.current = autoStartNext }, [autoStartNext])
  // "Current position" mode: which color engine A takes in the odd games
  // (pairs always flip). Defaults to the side at the bottom of the user's
  // board — "Stockfish plays my side" — and stays editable before launch.
  const [engineASide, setEngineASide] = useState<"white" | "black">("white")
  // Live UCI version of each configured engine (e.g. "Stockfish 18").
  const [sfVersion, setSfVersion] = useState<string | null>(null)
  const [rkVersion, setRkVersion] = useState<string | null>(null)

  const [running, setRunning] = useState(false)
  // Round-robin run state, lifted here so the head-to-head Run / exhibition
  // buttons and the round-robin Run button mutually exclude — the runner's
  // BatchControl is one shared managed state, so two concurrent batches would
  // steer each other's cancel/pause.
  const [rrRunning, setRrRunning] = useState(false)
  const [tally, setTally] = useState<RunningTally | null>(null)
  const [report, setReport] = useState<BatchReport | null>(null)
  // The two sides' display labels AS OF the run that produced `report`/`tally`
  // — snapshotted at run start so changing the dropdown selection afterward
  // (before the next Run) never relabels a finished result.
  const [reportLabels, setReportLabels] = useState<{ a: string; b: string }>({ a: "Side A", b: "Side B" })
  // Effective base clock (ms) of the run that produced `report`/`tally` —
  // snapshotted at run start like reportLabels, so the error profile's
  // clock-pressure threshold reflects the TC the games were actually played
  // at even if the user edits the form afterward.
  const [reportBaseMs, setReportBaseMs] = useState(60_000)
  const [probBins, setProbBins] = useState<ProbBin[]>([])
  const [curveBins, setCurveBins] = useState<EngineCurveBin[]>([])
  const [sfWdl, setSfWdl] = useState<ProbBin[]>([])
  const [rkWdl, setRkWdl] = useState<ProbBin[]>([])
  // Per-game live-stream log (Phase 4 checklist): newest first, capped so a
  // 1000-game run doesn't grow an unbounded DOM list while still running.
  const [liveLog, setLiveLog] = useState<LiveResultRow[]>([])
  const [error, setError] = useState<string | null>(null)
  // Wall-clock timer for the current run.
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [nowTs, setNowTs] = useState(0)

  // The id -> eval side-table for the current run, used to bucket results.
  const evalByIdRef = useRef<EvalMap>(new Map())

  // Restore the last-used config on mount; persist it on every change. So the
  // app reopens exactly where you left off instead of snapping to the defaults.
  const restored = useRef(false)
  useEffect(() => {
    try {
      const raw = localStorage.getItem("chessgui-tournament-config")
      if (raw) {
        const c = JSON.parse(raw)
        // Self-heal engine paths saved before the repo moved out of
        // ~/Documents/GitHub — a stale saved path overrides the fixed
        // default and makes every game fail at spawn.
        const healPath = (p: unknown) =>
          typeof p === "string"
            ? p.replace("/Documents/GitHub/chessgui/", "/github/chessgui/")
            : p
        // sideAId/sideBId are roster ids, not paths — no healing needed. Older
        // saved configs only have engineA/engineB (pre-dropdown paths); those
        // are silently dropped in favor of the new default roster ids rather
        // than migrated, since a path doesn't map onto a roster id 1:1.
        if (c.sideAId) setSideAId(String(c.sideAId))
        if (c.sideBId) setSideBId(String(c.sideBId))
        if (c.firstWhite === "a" || c.firstWhite === "b") setFirstWhite(c.firstWhite)
        if (c.mode) setMode(c.mode)
        if (c.minEval != null) setMinEval(String(c.minEval))
        if (c.maxEval != null) setMaxEval(String(c.maxEval))
        if (c.nGames != null) setNGames(String(c.nGames))
        if (c.concurrency != null) setConcurrency(String(c.concurrency))
        if (c.tcId) setTcId(c.tcId)
        if (c.customBaseS != null) setCustomBaseS(String(c.customBaseS))
        if (c.customIncS != null) setCustomIncS(String(c.customIncS))
        if (typeof c.paceTargetSeconds === "number" && Number.isFinite(c.paceTargetSeconds)) {
          setPaceTargetSeconds(c.paceTargetSeconds)
        }
        if (typeof c.adjudicateTb === "boolean") setAdjudicateTb(c.adjudicateTb)
        if (typeof c.useEvaluator === "boolean") setUseEvaluator(c.useEvaluator)
        if (c.evaluatorPath) setEvaluatorPath(healPath(c.evaluatorPath) as string)
        if (typeof c.autoStartNext === "boolean") setAutoStartNext(c.autoStartNext)
        if (c.moveDelayMs != null) setMoveDelayMs(Number(c.moveDelayMs) || 0)
        // Restore the eval-bar choice only if the user had explicitly set it;
        // otherwise leave it to auto-derive from the time control below.
        if (typeof c.evalBarTouched === "boolean" && c.evalBarTouched) {
          evalBarTouched.current = true
          if (typeof c.showEvalBar === "boolean") setShowEvalBar(c.showEvalBar)
        }
      }
    } catch { /* ignore corrupt config */ }
    restored.current = true
  }, [])
  useEffect(() => {
    if (!restored.current) return // don't clobber saved config before restore runs
    const c = { sideAId, sideBId, firstWhite, mode, minEval, maxEval, nGames, concurrency, tcId, customBaseS, customIncS, paceTargetSeconds, adjudicateTb, useEvaluator, evaluatorPath, showEvalBar, evalBarTouched: evalBarTouched.current, autoStartNext, moveDelayMs }
    try { localStorage.setItem("chessgui-tournament-config", JSON.stringify(c)) } catch { /* ignore */ }
  }, [sideAId, sideBId, firstWhite, mode, minEval, maxEval, nGames, concurrency, tcId, customBaseS, customIncS, paceTargetSeconds, adjudicateTb, useEvaluator, evaluatorPath, showEvalBar, autoStartNext, moveDelayMs])

  // Face-value clock (ms) implied by the current time-control selection —
  // BEFORE playback-pace compression (spec 216 UI:1). This is what the format
  // presets fill in, and what the pacing slider's ΔElo readout treats as
  // "face value".
  const faceClockConfig = useMemo(() => {
    const preset = TIME_CONTROLS.find((t) => t.id === tcId)
    return preset
      ? { baseMs: preset.baseMs, incMs: preset.incMs }
      : {
          baseMs: Math.max(100, Math.round((Number(customBaseS) || 60) * 1000)),
          incMs: Math.max(0, Math.round((Number(customIncS) || 0) * 1000)),
        }
  }, [tcId, customBaseS, customIncS])

  // Average seconds/move at face value, and the playback-pace floor/ceiling
  // around it (spec 216 UI:2, tier-0 checklist 216:75). Ceiling = real time
  // (C=1); floor = the slower of the observability floor and 1.25x the
  // machine's minimum compute time per move.
  const faceSecondsPerMove = useMemo(
    () => secondsPerMoveOf({ baseSeconds: faceClockConfig.baseMs / 1000, incrementSeconds: faceClockConfig.incMs / 1000 }),
    [faceClockConfig],
  )
  const machineMinSeconds = TIER0_MACHINE_MIN_SECONDS // no measured per-move floor yet (216 Tier 1)
  const paceFloorSeconds = Math.max(OBSERVABILITY_FLOOR_SECONDS, paceFloor(machineMinSeconds))
  const paceHasRoom = faceSecondsPerMove > paceFloorSeconds
  // The user's saved target, clamped into the current format's range so it
  // survives format changes without a stale/out-of-range slider position.
  // null (never touched) means real time — right at the ceiling.
  const clampedPaceSeconds = Math.min(
    faceSecondsPerMove,
    Math.max(paceFloorSeconds, paceTargetSeconds ?? faceSecondsPerMove),
  )
  const paceC = paceHasRoom ? faceSecondsPerMove / clampedPaceSeconds : 1
  // Effective (post-compression) game clock actually sent to the runner —
  // "the actual TC sent to the runner becomes format/C" (base AND increment
  // both divided by the same compression factor).
  const effectiveBaseMs = Math.max(50, Math.round(faceClockConfig.baseMs / paceC))
  const effectiveIncMs = Math.max(0, Math.round(faceClockConfig.incMs / paceC))
  const paceReadout = paceStrength(curve, faceSecondsPerMove, paceC, { timeSensitive: true })

  // Auto-check "show eval bar" for effective (post-pacing) clocks at 60s+
  // (where per-move eval reads are meaningful and there's time to watch),
  // until the user touches the checkbox.
  useEffect(() => {
    if (evalBarTouched.current) return
    setShowEvalBar(evalBarDefaultForBaseMs(effectiveBaseMs))
  }, [effectiveBaseMs])

  // Keep the parent's live-view eval bar visibility in sync.
  useEffect(() => {
    onEvalBarChange?.(showEvalBar)
  }, [showEvalBar, onEvalBarChange])

  // Resolve each MVP engine's UCI version (e.g. "Stockfish 18") once, for the
  // dropdown label (decision 5's literal "engine: stockfish 18" style) and the
  // inline readout below it. Paths are fixed constants now (the Participant
  // dropdown replaces the old free-text inputs — spec:210 Phase 6's
  // "Add-engine UI" for arbitrary binaries is a separate, unstarted item), so
  // this runs once on mount rather than per-keystroke.
  useEffect(() => {
    let cancelled = false
    invoke<string>("engine_id", { path: STOCKFISH_DEFAULT })
      .then((v) => { if (!cancelled) setSfVersion(v) })
      .catch(() => { if (!cancelled) setSfVersion("not found") })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    let cancelled = false
    invoke<string>("engine_id", { path: RECKLESS_DEFAULT })
      .then((v) => { if (!cancelled) setRkVersion(v) })
      .catch(() => { if (!cancelled) setRkVersion("not found") })
    return () => { cancelled = true }
  }, [])

  // The two fixed engine options + the roster (spec 218 decision 5): one flat
  // dropdown per side, kind-prefixed labels. `engines` folds in the live
  // version once resolved ("engine: stockfish 18"); before that it reads
  // "engine: stockfish" so the dropdown is never empty.
  const engines: EngineOption[] = useMemo(() => {
    const sfName = sfVersion && sfVersion !== "not found" ? sfVersion : "Stockfish"
    const rkName = rkVersion && rkVersion !== "not found" ? rkVersion : "Reckless"
    return [
      { id: "engine-stockfish", displayName: sfName, enginePath: STOCKFISH_DEFAULT, label: `engine: ${sfName.toLowerCase()}` },
      { id: "engine-reckless", displayName: rkName, enginePath: RECKLESS_DEFAULT, label: `engine: ${rkName.toLowerCase()}` },
    ]
  }, [sfVersion, rkVersion])
  const roster: TournamentRosterEntry[] = useMemo(
    () => buildTournamentRoster(rivalBook, engines),
    [rivalBook, engines],
  )
  const participantA: Participant =
    roster.find((e) => e.participant.id === sideAId)?.participant ?? roster[0].participant
  const participantB: Participant =
    roster.find((e) => e.participant.id === sideBId)?.participant ?? roster[1].participant

  // Enter "Current position" mode with its defaults: engine A (Stockfish) on
  // the side at the bottom of the user's board, 10m+5s, one flipped pair.
  // Everything stays editable before Run.
  const enterCurrentMode = useCallback(() => {
    setMode("current")
    setEngineASide(bottomColor)
    setTcId("rapid")
    setNGames("2")
  }, [bottomColor])

  // "Play this out" pressed in the board view (nonce bumped by the parent).
  const lastPreset = useRef(0)
  useEffect(() => {
    if (presetNonce === 0 || presetNonce === lastPreset.current) return
    lastPreset.current = presetNonce
    if (!running) enterCurrentMode()
  }, [presetNonce, running, enterCurrentMode])

  // Keep parent informed of run state; clear the live board when a run ends.
  useEffect(() => {
    onRunningChange?.(running)
    if (!running) onLiveUpdate?.(null)
  }, [running, onRunningChange, onLiveUpdate])

  // Tick the elapsed timer once a second while running.
  useEffect(() => {
    if (!running) return
    setNowTs(Date.now())
    const i = setInterval(() => setNowTs(Date.now()), 1000)
    return () => clearInterval(i)
  }, [running])

  const run = useCallback(async () => {
    setError(null)
    setReport(null)
    setProbBins([])
    setCurveBins([])
    setSfWdl([])
    setRkWdl([])
    setLiveLog([])
    setStartedAt(Date.now())
    setNowTs(Date.now())
    setRunning(true)

    try {
      // Coerce the free-text numeric fields with sensible fallbacks/clamps.
      const nGamesNum = Math.max(2, Math.min(10000, Math.round(Number(nGames) || 100)))
      const concurrencyNum = Math.max(0, Math.round(Number(concurrency) || 0))

      // Resolve the time control (game clock, engine-managed) — the EFFECTIVE
      // (post-playback-pace) clock: face value base/increment both divided by
      // the pacing compression factor (spec 216 UI:2-3).
      const baseMs = effectiveBaseMs
      const incMs = effectiveIncMs
      // Range is an ABSOLUTE imbalance magnitude (sign is irrelevant under color
      // flip). lo/hi are |eval| bounds; the curve/map span both signs (-hi..+hi).
      const a = Number.isFinite(Number(minEval)) ? Math.abs(Number(minEval)) : 0.5
      const b = Number.isFinite(Number(maxEval)) ? Math.abs(Number(maxEval)) : 1.5
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)

      // "normal"/"current" don't need the tagged-position set — skip the fetch.
      const positions =
        mode === "normal" || mode === "current" ? [] : await loadPositions()
      const nSeeds = seedsForGames(nGamesNum)
      const seeds = buildSeeds(mode, nSeeds, positions, lo, hi, currentFen ?? null)
      // Current-position mode keeps its own board-bottom-color control
      // (engineASide); every other mode uses the general "White in game 1"
      // control (firstWhite). Either way flipFirst reverses each pair's order.
      const flipFirst = mode === "current" ? engineASide === "black" : firstWhite === "b"
      // Fresh per-run persona seed (spec 214 contract step 8) — the runner
      // derives each game's actual seed from this + the game id.
      const pA = withFreshSeed(participantA)
      const pB = withFreshSeed(participantB)
      const { specs, evalById } = buildParticipantSpecs(
        seeds,
        pA,
        pB,
        baseMs,
        incMs,
        MAX_PLIES,
        adjudicateTb,
        flipFirst,
      )
      evalByIdRef.current = evalById

      const total = specs.length
      setTally({ completed: 0, total, engineA: 0, engineB: 0, draw: 0, errors: 0, aborted: 0 })

      // --- Live game tracking (for the board viewer) ---
      const labelA = sideLabel(pA)
      const labelB = sideLabel(pB)
      setReportLabels({ a: labelA, b: labelB })
      setReportBaseMs(baseMs)
      const specMeta = new Map<number, { whiteLabel: string; blackLabel: string }>()
      // Each game's start FEN (spec 218 "Move numbers" follow-up: paired with
      // the featured game's UCI moves so the shared live viewer can build a
      // numbered SAN move list — same source `replayFens`/`movesToPgn` use).
      const specStartFenById = new Map<number, string | null>()
      for (const s of specs) {
        specMeta.set(s.id, {
          whiteLabel: s.flipped ? labelB : labelA,
          blackLabel: s.flipped ? labelA : labelB,
        })
        specStartFenById.set(s.id, s.start_fen)
      }
      // Latest frame per game (for jumping to another in-flight game), the
      // featured game's full frame history (for back/forward nav), and per-game
      // latest eval (for the bar).
      const liveById = new Map<number, LiveFrame>()
      const completed = new Set<number>()
      const latestEval = new Map<number, { cp: number | null; mate: number | null }>()
      let featuredId: number | null = null
      let featuredFrames: LiveFrame[] = []
      // UCI moves of the featured game since it became featured — same reset
      // points as featuredFrames (a mid-game switch starts fresh, same known
      // limitation as the frame history).
      let featuredUci: string[] = []

      // Emit the featured game's current view (tip + full history) to the viewer.
      const emitFeatured = () => {
        if (featuredId === null) return
        const meta = specMeta.get(featuredId)
        const last = featuredFrames[featuredFrames.length - 1]
        if (!meta || !last) return
        onLiveUpdate?.({
          gameId: featuredId,
          ply: last.ply,
          fen: last.fen,
          lastMove: last.lastMove,
          whiteLabel: meta.whiteLabel,
          blackLabel: meta.blackLabel,
          whiteTimeMs: last.whiteTimeMs,
          blackTimeMs: last.blackTimeMs,
          eval: last.eval ?? null,
          frames: featuredFrames.slice(),
          startFen: specStartFenById.get(featuredId) ?? null,
          uciMoves: featuredUci.slice(),
        })
      }

      // Move stream: one event per move per game. We "feature" a single game at
      // a time, accumulating its frames, and only switch once it finishes.
      const moveChannel = new Channel<MoveEvent>()
      moveChannel.onmessage = (m: MoveEvent) => {
        const meta = specMeta.get(m.game_id)
        if (!meta) return
        const frame: LiveFrame = {
          ply: m.ply,
          fen: m.fen,
          lastMove: uciSquares(m.uci),
          whiteTimeMs: m.wtime_ms,
          blackTimeMs: m.btime_ms,
          eval: latestEval.get(m.game_id) ?? null,
        }
        liveById.set(m.game_id, frame)
        // A move means a game is actively playing — clear any between-games wait.
        setWaitingForNext(false)
        // Feature this game if nothing is featured or the featured one finished.
        if (featuredId === null || completed.has(featuredId)) {
          if (featuredId !== m.game_id) {
            featuredId = m.game_id
            featuredFrames = []
            featuredUci = []
          }
        }
        if (m.game_id === featuredId) {
          featuredFrames.push(frame)
          featuredUci[m.ply - 1] = m.uci
          emitFeatured()
        }
      }

      // Eval stream: one event per evaluated position. Track each game's latest
      // score, patch the matching featured frame (so per-ply nav shows the right
      // eval), and refresh the viewer so the bar keeps up between moves.
      const evalChannel = new Channel<EvalEvent>()
      evalChannel.onmessage = (ev: EvalEvent) => {
        const e = { cp: ev.cp, mate: ev.mate }
        latestEval.set(ev.game_id, e)
        const lf = liveById.get(ev.game_id)
        if (lf && lf.ply === ev.ply) lf.eval = e
        if (ev.game_id === featuredId) {
          const fr = featuredFrames.find((f) => f.ply === ev.ply)
          if (fr) fr.eval = e
          emitFeatured()
        }
      }

      // Games completed so far, in arrival order — the substrate for the LIVE
      // probability map / engine curves / WDL (Phase 5 checklist: "EvalBucket
      // aggregation updates live as ... events arrive"). Cheap to recompute
      // from scratch each event at these sizes (<=10000 games); the final,
      // authoritative recompute from `result.outcomes` after `play_batch`
      // resolves (below) is unaffected either way.
      const accumulatedOutcomes: GameOutcome[] = []

      // Live progress channel. The backend sends one BatchProgress per game.
      const channel = new Channel<BatchProgress>()
      channel.onmessage = (p: BatchProgress) => {
        completed.add(p.last.id)
        accumulatedOutcomes.push(p.last)
        // If auto-start is off and games remain, the runner is now waiting.
        if (!autoStartRef.current && p.completed < p.total) {
          setWaitingForNext(true)
        }
        // If the featured game just finished, jump to another in-flight game.
        if (featuredId !== null && completed.has(featuredId)) {
          const next = [...liveById.keys()].reverse().find((id) => !completed.has(id))
          if (next !== undefined) {
            featuredId = next
            const f = liveById.get(next)
            featuredFrames = f ? [f] : []
            // No per-ply UCI history is kept for games observed only via their
            // latest frame (same limitation as featuredFrames above) — the
            // move list starts fresh from whatever plies stream in from here.
            featuredUci = []
            emitFeatured()
          }
        }
        // Per-game live-stream log (Phase 4 checklist: "results stream into a
        // compact running log DURING the batch"), newest first.
        setLiveLog((prev) => {
          const r = (p.last.result as { Ok?: { result: string } }).Ok
          const err = (p.last.result as { Err?: string }).Err
          const row: LiveResultRow = {
            gameId: p.last.id,
            startEval: evalByIdRef.current.get(p.last.id)?.eval ?? null,
            result: p.last.aborted ? null : r?.result ?? null,
            error: p.last.aborted ? null : err ?? null,
            aborted: p.last.aborted ?? false,
          }
          return [row, ...prev]
        })
        // Live EvalBucket aggregation (Phase 5 checklist item) — recompute the
        // probability map / per-engine curves / per-engine WDL from every game
        // completed so far, so the charts fill in as the batch runs instead of
        // only appearing once it finishes.
        setProbBins(buildProbabilityMap(accumulatedOutcomes, evalByIdRef.current, -hi, hi))
        setCurveBins(buildEngineCurves(accumulatedOutcomes, evalByIdRef.current, -hi, hi))
        setSfWdl(buildEngineWDL(accumulatedOutcomes, evalByIdRef.current, "a", -hi, hi))
        setRkWdl(buildEngineWDL(accumulatedOutcomes, evalByIdRef.current, "b", -hi, hi))
        setTally((prev) => {
          const base =
            prev ?? { completed: 0, total, engineA: 0, engineB: 0, draw: 0, errors: 0, aborted: 0 }
          const r = (p.last.result as { Ok?: { result: string } }).Ok
          let { engineA: aWins, engineB: bWins, draw, errors, aborted } = base
          if (p.last.aborted) {
            // Stopped mid-play: not a result and not an error.
            aborted += 1
          } else if (!r) {
            errors += 1
          } else if (r.result === "1/2-1/2") {
            draw += 1
          } else {
            // Engines swap colors per game: white==engineA only when !flipped.
            // "1-0" = white won, "0-1" = black won.
            const whiteWon = r.result === "1-0"
            const aIsWhite = !p.last.flipped
            if (whiteWon === aIsWhite) aWins += 1
            else bWins += 1
          }
          return {
            completed: p.completed,
            total: p.total,
            engineA: aWins,
            engineB: bWins,
            draw,
            errors,
            aborted,
          }
        })
      }

      // Param names MUST match the Rust command (camelCased).
      const result = await invoke<BatchReport>("play_batch", {
        specs: specs as GameSpec[],
        concurrency: concurrencyNum,
        onProgress: channel,
        onMove: moveChannel,
        onEval: evalChannel,
        evalPath: useEvaluator ? evaluatorPath : null,
        evalMovetimeMs: 100,
        autoStart: autoStartNext,
        moveDelayMs,
      })

      setReport(result)
      // Positions span both signs (|eval| in [lo,hi]); charts cover -hi..+hi.
      setProbBins(
        buildProbabilityMap(
          result.outcomes,
          evalByIdRef.current,
          -hi,
          hi,
        ),
      )
      setCurveBins(
        buildEngineCurves(
          result.outcomes,
          evalByIdRef.current,
          -hi,
          hi,
        ),
      )
      setSfWdl(buildEngineWDL(result.outcomes, evalByIdRef.current, "a", -hi, hi))
      setRkWdl(buildEngineWDL(result.outcomes, evalByIdRef.current, "b", -hi, hi))
    } catch (e) {
      setError(String(e))
    } finally {
      setNowTs(Date.now()) // freeze elapsed at the final value
      setRunning(false)
    }
  }, [participantA, participantB, firstWhite, mode, minEval, maxEval, nGames, tcId, customBaseS, customIncS, effectiveBaseMs, effectiveIncMs, concurrency, adjudicateTb, useEvaluator, evaluatorPath, autoStartNext, moveDelayMs, currentFen, engineASide, onLiveUpdate])

  // --- Exhibition ("Watch two bots play") — spec 218 "Exhibition framing" ---
  // A batch of 1 through the SAME `play_batch` runner (no separate code path
  // on the Rust side, per the checklist item), with its own small live-state
  // slice so it renders independently of the stats-first batch view above.
  const [exhibitionRunning, setExhibitionRunning] = useState(false)
  const [exhibitionError, setExhibitionError] = useState<string | null>(null)
  const [exhibitionOutcome, setExhibitionOutcome] = useState<GameOutcome | null>(null)
  const [exhibitionStartFen, setExhibitionStartFen] = useState<string>(STANDARD_START_FEN)
  const [exhibitionFen, setExhibitionFen] = useState<string>(STANDARD_START_FEN)
  const [exhibitionLastMove, setExhibitionLastMove] = useState<[string, string] | undefined>(undefined)
  const [exhibitionWhiteMs, setExhibitionWhiteMs] = useState(0)
  const [exhibitionBlackMs, setExhibitionBlackMs] = useState(0)
  const [exhibitionEval, setExhibitionEval] = useState<{ cp: number | null; mate: number | null } | null>(null)
  const [exhibitionUciMoves, setExhibitionUciMoves] = useState<string[]>([])
  const [exhibitionWhiteLabel, setExhibitionWhiteLabel] = useState("White")
  const [exhibitionBlackLabel, setExhibitionBlackLabel] = useState("Black")

  const runExhibition = useCallback(async () => {
    setExhibitionError(null)
    setExhibitionOutcome(null)
    setExhibitionUciMoves([])
    setExhibitionEval(null)
    setExhibitionRunning(true)
    try {
      const a = Number.isFinite(Number(minEval)) ? Math.abs(Number(minEval)) : 0.5
      const b = Number.isFinite(Number(maxEval)) ? Math.abs(Number(maxEval)) : 1.5
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      const positions = mode === "normal" || mode === "current" ? [] : await loadPositions()
      const seeds = buildSeeds(mode, 1, positions, lo, hi, currentFen ?? null)
      const seed: Seed = seeds[0] ?? { fen: null, eval: 0 }

      const pA = withFreshSeed(participantA)
      const pB = withFreshSeed(participantB)
      const white = firstWhite === "b" ? pB : pA
      const black = firstWhite === "b" ? pA : pB
      const { spec } = buildExhibitionSpec(
        seed,
        white,
        black,
        effectiveBaseMs,
        effectiveIncMs,
        MAX_PLIES,
        adjudicateTb,
      )
      const startFen = seed.fen ?? STANDARD_START_FEN
      setExhibitionStartFen(startFen)
      setExhibitionFen(startFen)
      setExhibitionLastMove(undefined)
      setExhibitionWhiteMs(effectiveBaseMs)
      setExhibitionBlackMs(effectiveBaseMs)
      setExhibitionWhiteLabel(sideLabel(white))
      setExhibitionBlackLabel(sideLabel(black))

      const moveChannel = new Channel<MoveEvent>()
      moveChannel.onmessage = (m: MoveEvent) => {
        setExhibitionFen(m.fen)
        setExhibitionLastMove(uciSquares(m.uci))
        setExhibitionWhiteMs(m.wtime_ms)
        setExhibitionBlackMs(m.btime_ms)
        setExhibitionUciMoves((prev) => {
          const next = prev.slice()
          next[m.ply - 1] = m.uci
          return next
        })
      }
      const evalChannel = new Channel<EvalEvent>()
      evalChannel.onmessage = (ev: EvalEvent) => setExhibitionEval({ cp: ev.cp, mate: ev.mate })
      const progressChannel = new Channel<BatchProgress>()

      const result = await invoke<BatchReport>("play_batch", {
        specs: [spec] as GameSpec[],
        concurrency: 1,
        onProgress: progressChannel,
        onMove: moveChannel,
        onEval: evalChannel,
        evalPath: useEvaluator ? evaluatorPath : null,
        evalMovetimeMs: 100,
        autoStart: true,
        moveDelayMs,
      })
      setExhibitionOutcome(result.outcomes[0] ?? null)
    } catch (e) {
      setExhibitionError(String(e))
    } finally {
      setExhibitionRunning(false)
    }
  }, [participantA, participantB, firstWhite, mode, minEval, maxEval, effectiveBaseMs, effectiveIncMs, adjudicateTb, useEvaluator, evaluatorPath, moveDelayMs, currentFen])

  const cancel = useCallback(async () => {
    try {
      await invoke("cancel_batch")
    } catch (e) {
      setError(String(e))
    }
  }, [])

  // --- Live batch controls (reachable from the viewer during a run) ---
  const togglePause = useCallback(async () => {
    const next = !paused
    setPaused(next)
    try { await invoke("pause_batch", { paused: next }) } catch (e) { setError(String(e)) }
  }, [paused])

  const toggleAutoStart = useCallback(async () => {
    const next = !autoStartNext
    setAutoStartNext(next)
    if (next) setWaitingForNext(false) // re-enabling releases the between-games gate
    try { await invoke("set_auto_start", { autoStart: next }) } catch (e) { setError(String(e)) }
  }, [autoStartNext])

  const startNext = useCallback(async () => {
    setWaitingForNext(false)
    try { await invoke("start_next_game") } catch (e) { setError(String(e)) }
  }, [])

  const setDelay = useCallback(async (ms: number) => {
    setMoveDelayMs(ms)
    try { await invoke("set_move_delay", { delayMs: ms }) } catch (e) { setError(String(e)) }
  }, [])

  // Publish the viewer control surface while a run is live (null otherwise).
  useEffect(() => {
    if (!running) {
      onViewerControls?.(null)
      return
    }
    onViewerControls?.({
      paused,
      autoStartNext,
      waitingForNext,
      delayMs: moveDelayMs,
      onStop: cancel,
      onTogglePause: togglePause,
      onToggleAutoStart: toggleAutoStart,
      onStartNext: startNext,
      onSetDelay: setDelay,
    })
  }, [running, paused, autoStartNext, waitingForNext, moveDelayMs, cancel, togglePause, toggleAutoStart, startNext, setDelay, onViewerControls])

  // Reset transient live-control state whenever a run stops.
  useEffect(() => {
    if (!running) {
      setPaused(false)
      setWaitingForNext(false)
    }
  }, [running])

  // Eval→win-prob curve derived from this run's own probability map (spec 212
  // checklist line 77) — the substrate for every swing-label consumer below.
  const winCurve = useMemo(() => deriveWinProbCurve(probBins), [probBins])
  // fen → curated-pool tag for the seed/family breakdown, from the tagged
  // positions the run sampled (already cached by loadPositions; undefined
  // when the run's mode never fetched them).
  const tagByFen = useMemo(() => {
    if (!report || !positionsCache) return undefined
    return new Map(positionsCache.map((p) => [p.fen, p.source]))
  }, [report])
  // Clock-pressure threshold (spec 212:39 "sub-N-seconds flag"): 30s, capped
  // at half the run's base clock so a blitz run isn't 100% "under pressure".
  const lowClockMs = Math.min(DEFAULT_LOW_CLOCK_MS, Math.max(1_000, Math.round(reportBaseMs / 2)))

  const pct = tally && tally.total > 0 ? (tally.completed / tally.total) * 100 : 0
  // Elapsed wall-clock and a linear ETA from completed/total.
  const elapsedMs = startedAt ? Math.max(0, nowTs - startedAt) : 0
  const etaMs =
    running && tally && tally.completed > 0 && tally.completed < tally.total
      ? (elapsedMs / tally.completed) * (tally.total - tally.completed)
      : null
  const gamesPerMin =
    tally && elapsedMs > 0 ? (tally.completed / elapsedMs) * 60_000 : null

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl flex flex-col gap-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">Engine Tournament</h1>
          <p className="text-sm text-muted-foreground">
            Headless engine-vs-engine matches with color-flipped pairing and an
            eval &rarr; conversion probability map.
          </p>
        </div>

        {/* Participant dropdown (spec 218 "Exhibition & tournament" checklist
            item 1; decision 5: one flat dropdown per side, kind-prefixed
            labels — "engine: stockfish 18", "bot: kasparov (BT3, ...)"). No
            roster-browser screen here — that's Play vs Bot's card picker. */}
        <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">Participants</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Side A</span>
              <select
                data-testid="tournament-side-a"
                className="bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
                value={sideAId}
                onChange={(e) => setSideAId(e.target.value)}
                disabled={running}
              >
                {roster.map((e) => (
                  <option key={e.participant.id} value={e.participant.id} disabled={e.disabled}>
                    {e.label}{e.disabled ? " — coming soon" : ""}
                  </option>
                ))}
              </select>
              {sideAId === "engine-stockfish" && (
                <span className={`text-xs font-mono ${sfVersion === "not found" ? "text-amber-400" : "text-green-400"}`}>
                  {sfVersion ? `→ ${sfVersion}` : "→ checking…"}
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Side B</span>
              <select
                data-testid="tournament-side-b"
                className="bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
                value={sideBId}
                onChange={(e) => setSideBId(e.target.value)}
                disabled={running}
              >
                {roster.map((e) => (
                  <option key={e.participant.id} value={e.participant.id} disabled={e.disabled}>
                    {e.label}{e.disabled ? " — coming soon" : ""}
                  </option>
                ))}
              </select>
              {sideBId === "engine-reckless" && (
                <span className={`text-xs font-mono ${rkVersion === "not found" ? "text-amber-400" : "text-sky-400"}`}>
                  {rkVersion ? `→ ${rkVersion}` : "→ checking…"}
                </span>
              )}
            </label>
          </div>

          {/* Explicit per-side assignment (spec 218 item 1: "who is White in
              game 1" — flipFirst still alternates within a pair, this only
              picks which roster entry starts). Hidden in "current" mode, which
              has its own board-bottom-color control below. */}
          {mode !== "current" && (
            <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-white/10">
              <span className="text-xs text-muted-foreground pt-3">White in game 1</span>
              <div className="flex gap-2 pt-3">
                {(["a", "b"] as const).map((side) => (
                  <button
                    key={side}
                    data-testid={`tournament-first-white-${side}`}
                    onClick={() => setFirstWhite(side)}
                    disabled={running}
                    className={`px-3 py-1 text-sm rounded-md border transition-colors disabled:opacity-50 ${
                      firstWhite === side
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-input hover:text-foreground"
                    }`}
                  >
                    {side === "a" ? sideLabel(participantA) : sideLabel(participantB)}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted-foreground pt-3">
                (colors flip every second game)
              </span>
            </div>
          )}

          {/* Exhibition entry point (spec 218 "Exhibition framing" checklist
              item): "batch of 1" through the SAME runner, featured single-game
              presentation below instead of the stats-first batch view. */}
          <div className="flex items-center gap-2 pt-1 border-t border-white/10">
            <Button
              data-testid="tournament-watch-exhibition"
              variant="outline"
              size="sm"
              onClick={runExhibition}
              disabled={running || exhibitionRunning || rrRunning}
            >
              {exhibitionRunning ? "Watching…" : "Watch two bots play"}
            </Button>
            <span className="text-xs text-muted-foreground">
              One game, right now — {sideLabel(participantA)} vs {sideLabel(participantB)}, no batch stats.
            </span>
          </div>
        </section>

        {/* Exhibition viewer (spec 218 "Exhibition framing"): board + eval bar
            + numbered SAN move list, less stats-first than the batch view. */}
        {(exhibitionRunning || exhibitionOutcome || exhibitionError) && (
          <ExhibitionView
            running={exhibitionRunning}
            fen={exhibitionFen}
            lastMove={exhibitionLastMove}
            whiteMs={exhibitionWhiteMs}
            blackMs={exhibitionBlackMs}
            evalScore={exhibitionEval}
            showEvalBar={showEvalBar && useEvaluator}
            whiteLabel={exhibitionWhiteLabel}
            blackLabel={exhibitionBlackLabel}
            rows={numberMoves(exhibitionStartFen, sansFromUci(exhibitionStartFen, exhibitionUciMoves))}
            outcome={exhibitionOutcome}
            error={exhibitionError}
          />
        )}

        {/* Machine profile (spec 216 Tier 0) — calibrates the pacing floor and,
            eventually, cross-machine equivalence. */}
        <MachineProfileCard
          profile={machineProfile.profile}
          benching={machineProfile.benching}
          error={machineProfile.error}
          onBench={() => {
            const enginePath =
              typeof window !== "undefined" ? localStorage.getItem("engine-path") ?? undefined : undefined
            machineProfile.runBench(enginePath)
          }}
        />

        {/* Start mode + run params */}
        <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-foreground">Start mode</h2>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["normal", "Start Normal"],
                ["book", "Use Opening Book"],
                ["eval", "Eval-Qualified (range)"],
                ["current", "Current Position"],
              ] as [StartMode, string][]
            ).map(([m, label]) => (
              <button
                key={m}
                data-testid={`tournament-mode-${m}`}
                onClick={() => (m === "current" ? enterCurrentMode() : setMode(m))}
                disabled={running}
                className={`px-3 py-1.5 text-sm rounded-md border transition-colors disabled:opacity-50 ${
                  mode === m
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-muted-foreground border-input hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === "current" && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  Starting position (the board in the Analyze view)
                </span>
                <span
                  data-testid="tournament-current-fen"
                  className="bg-background border border-input rounded-md px-2 py-1.5 text-xs text-foreground font-mono break-all"
                >
                  {currentFen ?? "—"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  {sideLabel(participantA)} plays the first game as
                </span>
                {(["white", "black"] as const).map((c) => (
                  <button
                    key={c}
                    data-testid={`tournament-side-${c}`}
                    onClick={() => setEngineASide(c)}
                    disabled={running}
                    className={`px-3 py-1 text-sm rounded-md border transition-colors disabled:opacity-50 ${
                      engineASide === c
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-input hover:text-foreground"
                    }`}
                  >
                    {c === "white" ? "White" : "Black"}
                  </button>
                ))}
                <span className="text-xs text-muted-foreground">
                  (defaults to the side at the bottom of your board; colors flip
                  every second game)
                </span>
              </div>
            </div>
          )}

          {mode === "eval" && (
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Imbalance from (pawns)</span>
                <input
                  type="number"
                  min="0"
                  step="0.25"
                  className="w-28 bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
                  value={minEval}
                  onChange={(e) => setMinEval(e.target.value)}
                  disabled={running}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Imbalance to (pawns)</span>
                <input
                  type="number"
                  min="0"
                  step="0.25"
                  className="w-28 bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
                  value={maxEval}
                  onChange={(e) => setMaxEval(e.target.value)}
                  disabled={running}
                />
              </label>
              <span className="text-xs text-muted-foreground pb-2 max-w-[18rem]">
                Absolute edge, either color (each position is played both ways).
              </span>
            </div>
          )}

          {/* Time-format presets (spec 216 UI:1) — one click fills the base/increment
              fields below with a human-recognizable format's face value. */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              Time format (fills base + increment below; playback pace compresses it)
            </span>
            <div className="flex flex-wrap gap-2">
              {PLAYBACK_FORMATS.map((f) => {
                const active =
                  tcId === "custom" &&
                  Number(customBaseS) === f.baseS &&
                  Number(customIncS) === f.incS
                return (
                  <button
                    key={f.id}
                    onClick={() => {
                      setTcId("custom")
                      setCustomBaseS(String(f.baseS))
                      setCustomIncS(String(f.incS))
                    }}
                    disabled={running}
                    className={`px-3 py-1.5 text-sm rounded-md border transition-colors disabled:opacity-50 ${
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-input hover:text-foreground"
                    }`}
                  >
                    {f.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Games (max 10000, 2 per opening)
              </span>
              <input
                type="number"
                min={2}
                max={10000}
                className="bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
                value={nGames}
                onChange={(e) => setNGames(e.target.value)}
                disabled={running}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Time control (per side)</span>
              <select
                className="bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
                value={tcId}
                onChange={(e) => setTcId(e.target.value)}
                disabled={running}
              >
                {TIME_CONTROLS.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Concurrency (0 = auto)
              </span>
              <input
                type="number"
                min={0}
                className="bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
                disabled={running}
              />
            </label>
          </div>

          {tcId === "custom" && (
            <div className="flex flex-wrap gap-4">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Base time (seconds)</span>
                <input
                  type="number"
                  min={0.1}
                  step={1}
                  className="w-32 bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
                  value={customBaseS}
                  onChange={(e) => setCustomBaseS(e.target.value)}
                  disabled={running}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Increment (seconds)</span>
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  className="w-32 bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
                  value={customIncS}
                  onChange={(e) => setCustomIncS(e.target.value)}
                  disabled={running}
                />
              </label>
            </div>
          )}

          {/* Playback pace slider (spec 216 UI:2-3): compression factor C from
              1x (real time) down to the pacing floor. Base AND increment are
              both divided by C for the actual runner clock (effectiveBaseMs/
              effectiveIncMs above); the readout uses this machine's MEASURED
              curve once the Tier-1 ladder has fitted one, else the PRIOR. */}
          <div className="flex flex-col gap-2 border-t border-white/10 pt-4">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground">
                Playback pace —{" "}
                {paceHasRoom
                  ? `${clampedPaceSeconds < 1 ? `${Math.round(clampedPaceSeconds * 1000)}ms` : `${clampedPaceSeconds.toFixed(1)}s`}/move (face value ${faceSecondsPerMove.toFixed(1)}s/move)`
                  : `already at the floor for this format (${faceSecondsPerMove.toFixed(2)}s/move)`}
              </span>
              {paceC > 1.01 && (
                <span className="text-xs font-mono text-muted-foreground">
                  {paceC.toFixed(1)}&times; faster
                </span>
              )}
            </div>
            <Slider
              data-testid="tournament-pace-slider"
              min={0}
              max={100}
              step={0.5}
              value={[
                paceHasRoom
                  ? ((Math.log2(clampedPaceSeconds) - Math.log2(paceFloorSeconds)) /
                      (Math.log2(faceSecondsPerMove) - Math.log2(paceFloorSeconds))) *
                    100
                  : 100,
              ]}
              onValueChange={([v]) => {
                if (!paceHasRoom) return
                const logFloor = Math.log2(paceFloorSeconds)
                const logFace = Math.log2(faceSecondsPerMove)
                const frac = v / 100
                setPaceTargetSeconds(2 ** (logFloor + frac * (logFace - logFloor)))
              }}
              disabled={running || !paceHasRoom}
            />
            <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono">
              <span>
                fastest ({paceFloorSeconds < 1 ? `${Math.round(paceFloorSeconds * 1000)}ms` : `${paceFloorSeconds.toFixed(2)}s`}/move)
              </span>
              <span>real time (1&times;)</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="secondary" className="font-mono text-[10px]">
                {curve.source.toUpperCase()}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Both engines {paceReadout.reason}
              </span>
            </div>
            {!machineProfile.profile && (
              <span className="text-[10px] text-muted-foreground/70">
                Bench this machine (below) for an exact pacing floor — using a
                conservative estimate until then.
              </span>
            )}
          </div>

          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="mt-0.5 accent-green-600"
              checked={adjudicateTb}
              onChange={(e) => setAdjudicateTb(e.target.checked)}
              disabled={running}
            />
            <span className="flex flex-col">
              <span className="text-sm text-foreground">
                Adjudicate 7-man endgames (tablebase)
              </span>
              <span className="text-xs text-muted-foreground">
                At &le;7 pieces, score the perfect-play result instead of playing
                it out — faster, and fair since any engine can use a tablebase.
              </span>
            </span>
          </label>

          {/* Neutral evaluator (third engine) */}
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              data-testid="tournament-use-evaluator"
              className="mt-0.5 accent-green-600"
              checked={useEvaluator}
              onChange={(e) => setUseEvaluator(e.target.checked)}
              disabled={running}
            />
            <span className="flex flex-col gap-1 flex-1">
              <span className="text-sm text-foreground">
                Neutral evaluator (third engine, scores every position)
              </span>
              <span className="text-xs text-muted-foreground">
                A background engine evaluates each position at ~100ms off the live
                stream — never on a player&apos;s clock — to drive the eval bar and
                the per-move eval graphs. Default Stockfish.
              </span>
              {useEvaluator && (
                <input
                  className="mt-1 bg-background border border-input rounded-md px-2 py-1 text-xs text-foreground font-mono w-full max-w-md"
                  value={evaluatorPath}
                  onChange={(e) => setEvaluatorPath(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  disabled={running}
                  spellCheck={false}
                  aria-label="Evaluator engine path"
                />
              )}
            </span>
          </label>

          {/* Show evaluation bar beside the live board */}
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              data-testid="tournament-show-eval-bar"
              className="mt-0.5 accent-green-600"
              checked={showEvalBar}
              onChange={(e) => {
                evalBarTouched.current = true
                setShowEvalBar(e.target.checked)
              }}
              disabled={running || !useEvaluator}
            />
            <span className="flex flex-col">
              <span className="text-sm text-foreground">
                Show evaluation bar beside the live board
              </span>
              <span className="text-xs text-muted-foreground">
                Auto-on for time controls of 60s+ (until you set it yourself).
                {!useEvaluator && " Requires the neutral evaluator."}
              </span>
            </span>
          </label>

          {/* Watch pacing: auto-start next game + min per-move display time */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                data-testid="tournament-auto-start"
                className="mt-0.5 accent-green-600"
                checked={autoStartNext}
                onChange={(e) => setAutoStartNext(e.target.checked)}
                disabled={running}
              />
              <span className="flex flex-col">
                <span className="text-sm text-foreground">Auto-start next game</span>
                <span className="text-xs text-muted-foreground">
                  Off pauses between games (runs one at a time) so you can study
                  the final position before advancing.
                </span>
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Min move display</span>
              <select
                data-testid="tournament-move-delay"
                className="bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
                value={moveDelayMs}
                onChange={(e) => setMoveDelayMs(Number(e.target.value))}
                disabled={running}
              >
                {MOVE_DELAY_OPTIONS.map((o) => (
                  <option key={o.ms} value={o.ms}>{o.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={run} disabled={running || rrRunning}>
              {running ? "Running…" : "Run Tournament"}
            </Button>
            {running && (
              <Button variant="destructive" onClick={cancel}>
                Cancel
              </Button>
            )}
          </div>
        </section>

        {error && (
          <div className="bg-red-900/40 border border-red-700/50 text-red-100 rounded-md px-4 py-2 text-sm">
            {error}
          </div>
        )}

        {/* Live progress */}
        {tally && (
          <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">
                {running ? "Running" : "Finished"}
              </h2>
              <span className="text-xs text-muted-foreground font-mono">
                {tally.completed} / {tally.total}
              </span>
            </div>
            <Progress value={pct} />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground font-mono">
              <span>Elapsed {formatDuration(elapsedMs)}</span>
              {etaMs !== null && <span>ETA {formatDuration(etaMs)}</span>}
              {gamesPerMin !== null && <span>{gamesPerMin.toFixed(1)} games/min</span>}
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-green-400">{reportLabels.a} wins: {tally.engineA}</span>
              <span className="text-muted-foreground">Draws: {tally.draw}</span>
              <span className="text-sky-400">{reportLabels.b} wins: {tally.engineB}</span>
              {tally.errors > 0 && (
                <span className="text-amber-400">Errors: {tally.errors}</span>
              )}
              {tally.aborted > 0 && (
                <span className="text-muted-foreground">Aborted: {tally.aborted}</span>
              )}
            </div>
          </section>
        )}

        {/* Per-game live-stream log (Phase 4 checklist item): compact,
            newest-first, streams in DURING the run — distinct from the
            full ResultsExplorer browser below, which needs the completed
            batch (board hop, "Open in Analyze", etc). */}
        {liveLog.length > 0 && (
          <LiveResultLog rows={liveLog} labelA={reportLabels.a} labelB={reportLabels.b} />
        )}

        {/* Final summary */}
        {report && (
          <SummaryCard
            outcomes={report.outcomes}
            labelA={reportLabels.a}
            labelB={reportLabels.b}
          />
        )}

        {/* Average eval progress across completed games (neutral evaluator) */}
        {report && (
          <AverageEvalGraph
            outcomes={report.outcomes}
            labelA={reportLabels.a}
            labelB={reportLabels.b}
          />
        )}

        {/* Per-game browser: select a game, hop to any position, open in Analyze */}
        {report && (
          <ResultsExplorer
            outcomes={report.outcomes}
            labelA={reportLabels.a}
            labelB={reportLabels.b}
            onOpenGame={onOpenGame}
            curve={winCurve}
          />
        )}

        {/* Spec 212 analyses over the completed run: per-engine error
            profiles (label × phase × clock pressure) + delta, band
            trajectories, seed/family breakdown, termination quality. */}
        {report && (
          <ErrorProfileSection
            outcomes={report.outcomes}
            curve={winCurve}
            labelA={reportLabels.a}
            labelB={reportLabels.b}
            lowClockMs={lowClockMs}
          />
        )}
        {report && (
          <BandTrajectorySection
            outcomes={report.outcomes}
            evalById={evalByIdRef.current}
            labelA={reportLabels.a}
            labelB={reportLabels.b}
          />
        )}
        {report && (
          <SeedBreakdownSection
            outcomes={report.outcomes}
            evalById={evalByIdRef.current}
            tagByFen={tagByFen}
            labelA={reportLabels.a}
          />
        )}
        {report && (
          <TerminationQualitySection
            outcomes={report.outcomes}
            curve={winCurve}
            labelA={reportLabels.a}
            labelB={reportLabels.b}
          />
        )}

        {/* Per-engine performance curve (primary analysis). Live: recomputed
            from every game completed so far, not just the final report. */}
        {curveBins.some((b) => b.a.games > 0 || b.b.games > 0) && (
          <EngineCurve
            bins={curveBins}
            labelA={reportLabels.a}
            labelB={reportLabels.b}
          />
        )}

        {/* Per-engine W/D/L: how each engine fared when up vs down each amount. */}
        {sfWdl.length > 0 && (
          <ProbabilityMap
            bins={sfWdl}
            title={`${reportLabels.a} — results by its own starting eval`}
            desc={`How ${reportLabels.a} fared from its own perspective: +x bins = it began up x pawns (conversion), −x bins = down x pawns (defense). The dot is its mean score; the tick is the classical Elo-naive expectation.`}
            winLabel={`${reportLabels.a} win`}
            lossLabel="loss"
            scoreLabel="avg score"
          />
        )}
        {rkWdl.length > 0 && (
          <ProbabilityMap
            bins={rkWdl}
            title={`${reportLabels.b} — results by its own starting eval`}
            desc={`How ${reportLabels.b} fared from its own perspective: +x bins = up x pawns (conversion), −x bins = down x pawns (defense). Compare the same bins against ${reportLabels.a} above.`}
            winLabel={`${reportLabels.b} win`}
            lossLabel="loss"
            scoreLabel="avg score"
          />
        )}

        {/* Probability map (advantaged side, both engines pooled) — the
            headline chart, live during the run and final once it completes. */}
        {probBins.length > 0 && (
          <ProbabilityMap bins={probBins} />
        )}
        {report && probBins.length === 0 && (
          <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 text-sm text-muted-foreground">
            No completed games to chart (all games errored?).
          </section>
        )}

        {/* Export the completed result as JSON (Phase 5 checklist item) —
            same Blob + object-URL download pattern app/page.tsx's PGN export
            uses; no Tauri save dialog yet, matching that precedent. */}
        {report && (
          <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Export</h2>
              <p className="text-xs text-muted-foreground">
                Save this run's probability map as JSON (engines, mode, eval range, buckets).
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const exported = buildTournamentResultExport(
                  reportLabels.a,
                  reportLabels.b,
                  report.outcomes.length,
                  mode,
                  [-Math.max(Math.abs(Number(minEval) || 0), Math.abs(Number(maxEval) || 0)),
                    Math.max(Math.abs(Number(minEval) || 0), Math.abs(Number(maxEval) || 0))],
                  probBins,
                )
                const json = JSON.stringify(exported, null, 2)
                const base = `${reportLabels.a}_vs_${reportLabels.b}`.replace(/[^\w.-]+/g, "_")
                const name = `tournament_${base}_${exported.completedAt.replace(/[:.]/g, "-")}.json`
                const blob = new Blob([json], { type: "application/json" })
                const url = URL.createObjectURL(blob)
                const a = document.createElement("a")
                a.href = url
                a.download = name
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                setTimeout(() => URL.revokeObjectURL(url), 1000)
              }}
            >
              Export JSON
            </Button>
          </section>
        )}

        {/* Round-robin tournament (spec 210 Phase 6): N participants, each
            pair plays M color-flipped games, full cross-table + standings +
            Elo estimates, with save/load persistence. Scheduled as ONE flat
            batch through the same play_batch runner as everything above. */}
        <RoundRobinSection
          roster={roster}
          baseMs={effectiveBaseMs}
          incMs={effectiveIncMs}
          concurrency={Math.max(0, Math.round(Number(concurrency) || 0))}
          adjudicateTb={adjudicateTb}
          otherRunActive={running || exhibitionRunning}
          running={rrRunning}
          onRunningChange={setRrRunning}
        />
      </div>
    </div>
  )
}

// Machine-speed profile card (spec 216 Tier 0 checklist: "bench invocation +
// nps capture + JSON storage" + its UI surface). One bench per machine —
// stored locally and reused as the pacing floor's basis (once Tier 1 measures
// a real per-move minimum) and, later, cross-machine equivalence.
function MachineProfileCard({
  profile,
  benching,
  error,
  onBench,
}: {
  profile: MachineProfile | null
  benching: boolean
  error: string | null
  onBench: () => void
}) {
  return (
    <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">Machine profile</h2>
        <Button size="sm" variant="outline" onClick={onBench} disabled={benching}>
          {benching ? "Benching…" : "Bench this machine"}
        </Button>
      </div>
      {profile ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground font-mono">
          <span className="text-foreground">{profile.hostname}</span>
          <span>{profile.engine_name}</span>
          <span>{formatNps(profile.nps)}</span>
          <span>{profile.threads} threads</span>
          <span>measured {formatMeasuredDate(profile.measured_at)}</span>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">
          Not benched yet — calibrates pace floors and cross-machine equivalence.
        </span>
      )}
      {error && <span className="text-xs text-red-400">{error}</span>}
    </section>
  )
}

/**
 * Compact per-game result log (Phase 4 checklist: "Per-game results stream
 * into a compact running log (game #, result, start eval)"), fed straight
 * off the `BatchProgress` channel as each game finishes — no waiting on the
 * blocking `play_batch` await. Newest game first; capped to the most recent
 * `maxRows` so a long batch stays a fixed-height scroller instead of an
 * ever-growing list.
 */
function LiveResultLog({
  rows,
  labelA,
  labelB,
  maxRows = 200,
}: {
  rows: LiveResultRow[]
  labelA: string
  labelB: string
  maxRows?: number
}) {
  const shown = rows.slice(0, maxRows)
  const resultText = (row: LiveResultRow): { text: string; cls: string } => {
    if (row.aborted) return { text: "stopped", cls: "text-muted-foreground" }
    if (row.error) return { text: `error`, cls: "text-amber-400" }
    if (row.result === "1-0") return { text: "1-0 (White)", cls: "text-green-400" }
    if (row.result === "0-1") return { text: "0-1 (Black)", cls: "text-red-400" }
    if (row.result === "1/2-1/2") return { text: "draw", cls: "text-muted-foreground" }
    return { text: "?", cls: "text-muted-foreground" }
  }
  return (
    <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Live results</h2>
        <span className="text-xs text-muted-foreground">
          {labelA} vs {labelB} — {rows.length} game{rows.length === 1 ? "" : "s"} so far
        </span>
      </div>
      <div className="max-h-48 overflow-y-auto">
        <table className="w-full text-xs font-mono">
          <tbody>
            {shown.map((row) => {
              const { text, cls } = resultText(row)
              return (
                <tr key={row.gameId} className="border-t border-white/5">
                  <td className="py-0.5 pr-3 text-muted-foreground">#{row.gameId}</td>
                  <td className={`py-0.5 pr-3 ${cls}`}>{text}</td>
                  <td className="py-0.5 pr-3 text-muted-foreground">
                    {row.startEval != null
                      ? `${row.startEval >= 0 ? "+" : ""}${row.startEval.toFixed(2)}`
                      : "—"}
                  </td>
                  {row.error && (
                    <td className="py-0.5 text-muted-foreground truncate max-w-[24rem]" title={row.error}>
                      {row.error}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function SummaryCard({
  outcomes,
  labelA,
  labelB,
}: {
  outcomes: GameOutcome[]
  labelA: string
  labelB: string
}) {
  // Recompute per-ENGINE results (engines swap colors each game), since the
  // backend summary only knows white/black.
  let games = 0, aWins = 0, bWins = 0, draws = 0, errors = 0, aborted = 0
  const terms: Record<string, number> = {}
  for (const o of outcomes) {
    if (o.aborted) { aborted += 1; continue } // stopped mid-play: not a result
    games += 1
    const r = gameResult(o)
    if (!r) { errors += 1; continue }
    terms[r.termination] = (terms[r.termination] ?? 0) + 1
    if (r.result === "1/2-1/2") { draws += 1; continue }
    const aIsWhite = !o.flipped
    if ((r.result === "1-0") === aIsWhite) aWins += 1
    else bWins += 1
  }
  const termList = Object.entries(terms).sort((a, b) => b[1] - a[1])
  // Distinct failure reasons (deduped, most frequent first) so an errored batch
  // shows WHY it failed — e.g. a bad engine path or an unreadable position —
  // instead of an opaque "Errors: N".
  const errorGroups = summarizeErrors(outcomes)
  const items: [string, number, string][] = [
    ["Games", games, "text-foreground"],
    [`${labelA} wins`, aWins, "text-green-400"],
    [`${labelB} wins`, bWins, "text-sky-400"],
    ["Draws", draws, "text-muted-foreground"],
    ["Errors", errors, "text-amber-400"],
  ]
  // Only surface aborted as a stat when a stop actually happened.
  if (aborted > 0) items.push(["Aborted", aborted, "text-muted-foreground"])

  // Elo of engine A relative to engine B, with a 95% confidence interval.
  const elo = eloDelta(aWins, draws, bWins)
  const sign = (n: number) => (n >= 0 ? `+${Math.round(n)}` : `${Math.round(n)}`)
  // A CI that straddles 0 means the result is not yet statistically significant.
  const significant = elo ? elo.lo > 0 || elo.hi < 0 : false

  return (
    <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-foreground">Summary</h2>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {items.map(([label, value, color]) => (
          <div key={label} className="flex flex-col">
            <span className={`text-2xl font-bold font-mono ${color}`}>{value}</span>
            <span className="text-xs text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>
      {elo && (
        <div className="flex flex-col gap-0.5 border-t border-white/10 pt-3">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">
              Elo ({labelA} vs {labelB}):
            </span>
            <span className="text-xl font-bold font-mono text-foreground">
              {sign(elo.elo)}
            </span>
            <span className="text-sm font-mono text-muted-foreground">
              95% CI [{sign(elo.lo)}, {sign(elo.hi)}]
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            {significant
              ? `Statistically significant — ${elo.elo >= 0 ? labelA : labelB} is stronger.`
              : "Not statistically significant — the interval includes 0 (need more games)."}
          </span>
        </div>
      )}
      {termList.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/10 pt-3 text-xs text-muted-foreground">
          <span className="text-foreground">Endings:</span>
          {termList.map(([name, count]) => (
            <span key={name} className="font-mono">
              {name.replace(/_/g, " ")} {count}
            </span>
          ))}
        </div>
      )}
      {errorGroups.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-amber-500/20 pt-3">
          <span className="text-xs font-semibold text-amber-400">
            Failures
          </span>
          {errorGroups.map(({ message, count }) => (
            <div
              key={message}
              className="flex items-baseline gap-2 text-xs text-amber-200/90"
            >
              <span className="font-mono shrink-0 text-amber-400">
                {count}×
              </span>
              <span className="font-mono break-all">{message}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function EngineCurve({
  bins,
  labelA,
  labelB,
}: {
  bins: EngineCurveBin[]
  labelA: string
  labelB: string
}) {
  // Only show bins where at least one engine has games.
  const shown = bins.filter((b) => b.a.games > 0 || b.b.games > 0)
  return (
    <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">
          Engine performance by starting eval
        </h2>
        {/* Legend */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-green-500" />
            {labelA}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-sky-500" />
            {labelB}
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Higher = better from that starting eval; the gap between the two engines
        is the strength difference. Each engine&apos;s score is measured from its
        own perspective (every position is played from both colors).
      </p>

      {/* Bars */}
      <div className="relative flex items-stretch gap-1 h-56">
        {/* 50% reference line */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-white/20" />
        {shown.map((bin) => {
          const aPct = bin.a.games > 0 ? bin.a.avgScore * 100 : 0
          const bPct = bin.b.games > 0 ? bin.b.avgScore * 100 : 0
          const fmtPct = (n: number) => `${(n * 100).toFixed(0)}%`
          const title =
            `eval [${bin.lo.toFixed(2)}, ${bin.hi.toFixed(2)})\n` +
            `${labelA}: n=${bin.a.games} avg=${bin.a.games ? fmtPct(bin.a.avgScore) : "—"}\n` +
            `${labelB}: n=${bin.b.games} avg=${bin.b.games ? fmtPct(bin.b.avgScore) : "—"}`
          return (
            <div
              key={bin.lo}
              className="flex-1 flex flex-col items-center gap-1 min-w-0"
              title={title}
            >
              <div className="relative w-full flex-1 flex items-end justify-center gap-0.5">
                <div className="flex-1 max-w-[14px] h-full flex items-end">
                  {bin.a.games > 0 && (
                    <div
                      className="w-full rounded-t-sm bg-green-500"
                      style={{ height: `${aPct}%` }}
                    />
                  )}
                </div>
                <div className="flex-1 max-w-[14px] h-full flex items-end">
                  {bin.b.games > 0 && (
                    <div
                      className="w-full rounded-t-sm bg-sky-500"
                      style={{ height: `${bPct}%` }}
                    />
                  )}
                </div>
              </div>
              <span className="text-[10px] text-muted-foreground font-mono whitespace-nowrap">
                {bin.center >= 0 ? "+" : ""}
                {bin.center.toFixed(1)}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function ProbabilityMap({
  bins,
  title = "Conversion probability map",
  desc = "Each bar is one ~0.25-pawn starting-eval bin (White-POV). Stacks show how the advantaged (White) side fared; the dot marks the mean White score = how often that advantage converted. The amber line is the classical Elo-naive expectation for the same eval — above it means this pairing converts advantage BETTER than eval alone predicts, below means worse (spec 210 conversion_delta).",
  winLabel = "White win",
  lossLabel = "Black win",
  scoreLabel = "avg White score",
}: {
  bins: ProbBin[]
  title?: string
  desc?: string
  winLabel?: string
  lossLabel?: string
  scoreLabel?: string
}) {
  return (
    <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">
          {title}
        </h2>
        {/* Legend */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-green-500" />
            {winLabel}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-gray-500" />
            Draw
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-red-500" />
            {lossLabel}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full bg-white" />
            {scoreLabel}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-amber-400" />
            expected (Elo-naive)
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{desc}</p>

      {/* Bars */}
      <div className="relative flex items-stretch gap-1 h-56">
        {bins.map((bin) => {
          const total = bin.count || 1
          const wPct = (bin.whiteWins / total) * 100
          const dPct = (bin.draws / total) * 100
          const bPct = (bin.blackWins / total) * 100
          // Dot vertical position: top = 1.0 score, bottom = 0.0 score.
          const dotBottomPct = bin.avgWhiteScore * 100
          const deltaPct = bin.conversionDelta * 100
          return (
            <div
              key={bin.lo}
              className="flex-1 flex flex-col items-center gap-1 min-w-0"
              title={`eval [${bin.lo.toFixed(2)}, ${bin.hi.toFixed(2)})  n=${bin.count}  W ${bin.whiteWins} / D ${bin.draws} / B ${bin.blackWins}  avgWhiteScore=${(bin.avgWhiteScore * 100).toFixed(0)}%  expected=${(bin.expectedWhiteScore * 100).toFixed(0)}%  conversionDelta=${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(0)}pp`}
            >
              <span className="text-[10px] text-muted-foreground font-mono">
                {bin.count}
              </span>
              <div className="relative w-full flex-1 flex flex-col rounded-sm overflow-hidden bg-background/40">
                <div className="bg-green-500" style={{ height: `${wPct}%` }} />
                <div className="bg-gray-500" style={{ height: `${dPct}%` }} />
                <div className="bg-red-500" style={{ height: `${bPct}%` }} />
                {/* avg White score dot */}
                <div
                  className="absolute left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-white border border-black/40"
                  style={{ bottom: `calc(${dotBottomPct}% - 4px)` }}
                />
              </div>
              <span className="text-[10px] text-muted-foreground font-mono whitespace-nowrap">
                {bin.center >= 0 ? "+" : ""}
                {bin.center.toFixed(2)}
              </span>
            </div>
          )
        })}
        {/* Conversion-delta overlay: the classical Elo-naive expected-score
            line (spec 210 Phase 5 checklist item), so actual-vs-expected is
            readable at a glance against the dots above. */}
        {bins.length > 0 && (
          <svg
            className="absolute left-0 right-0 top-0 pointer-events-none"
            style={{ height: "calc(100% - 1.25rem)" }} // stop above the eval-label row
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <polyline
              points={bins
                .map(
                  (b, i) =>
                    `${((i + 0.5) / bins.length) * 100},${(1 - b.expectedWhiteScore) * 100}`,
                )
                .join(" ")}
              fill="none"
              stroke="#fbbf24"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Eval-by-ply charts (neutral evaluator) + per-game browser
// ---------------------------------------------------------------------------

const EMPTY_DESTS = new Map<Key, Key[]>()
const noop = () => {}

// Chart inks, matched to the eval-graph (spec 202) so the tab reads as one system.
const CHART_BG = "#12100e"
const CHART_MID = "rgba(255,255,255,0.18)"
const CHART_PAD_X = 6
const CHART_PAD_Y = 6

/** A White-POV (or A-POV) eval curve, plotted by ply. Pure inline SVG. */
function EvalByPlyChart({
  points,
  maxAbs,
  height = 96,
  currentPly = null,
  onPick,
  fill = "rgba(123,179,58,0.22)",
  stroke = "#8a8783",
}: {
  points: EvalPoint[]
  maxAbs: number
  height?: number
  currentPly?: number | null
  onPick?: (ply: number) => void
  fill?: string
  stroke?: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(240)
  const [hoverPly, setHoverPly] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setWidth(Math.max(80, el.getBoundingClientRect().width))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const maxPly = points.length ? points[points.length - 1].ply : 0
  const minPly = points.length ? points[0].ply : 0
  const span = Math.max(1, maxPly - minPly)
  const dom = Math.max(0.5, maxAbs)
  const xFor = (ply: number) =>
    CHART_PAD_X + ((ply - minPly) / span) * (width - 2 * CHART_PAD_X)
  const yFor = (v: number) => {
    const c = Math.max(-dom, Math.min(dom, v))
    return CHART_PAD_Y + ((dom - c) / (2 * dom)) * (height - 2 * CHART_PAD_Y)
  }
  const yZero = yFor(0)

  const known = points.filter(
    (p): p is EvalPoint & { pawns: number } => p.pawns !== null,
  )
  const curve = known
    .map((p, i) => `${i === 0 ? "M" : "L"}${xFor(p.ply).toFixed(1)},${yFor(p.pawns).toFixed(1)}`)
    .join(" ")
  const area =
    known.length >= 2
      ? `${curve} L${xFor(known[known.length - 1].ply).toFixed(1)},${yZero.toFixed(1)} ` +
        `L${xFor(known[0].ply).toFixed(1)},${yZero.toFixed(1)} Z`
      : ""

  const plyFromMouse = (clientX: number): number | null => {
    if (!points.length) return null
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return null
    const t = (clientX - rect.left - CHART_PAD_X) / (width - 2 * CHART_PAD_X)
    return Math.min(maxPly, Math.max(minPly, Math.round(minPly + t * span)))
  }

  const hover = hoverPly !== null ? points.find((p) => p.ply === hoverPly) ?? null : null
  const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`

  return (
    <div
      ref={wrapRef}
      className="relative w-full select-none"
      style={{ height, cursor: onPick ? "pointer" : "default" }}
      onMouseMove={(e) => setHoverPly(plyFromMouse(e.clientX))}
      onMouseLeave={() => setHoverPly(null)}
      onClick={(e) => {
        if (!onPick) return
        const ply = plyFromMouse(e.clientX)
        if (ply !== null) onPick(ply)
      }}
    >
      <svg width={width} height={height} className="block rounded-sm">
        <rect x={0} y={0} width={width} height={height} fill={CHART_BG} />
        {area && <path d={area} fill={fill} />}
        {curve && <path d={curve} fill="none" stroke={stroke} strokeWidth={1.25} />}
        <line x1={0} x2={width} y1={yZero} y2={yZero} stroke={CHART_MID} strokeWidth={1} strokeDasharray="3,3" />
        {currentPly !== null && (
          <line
            x1={xFor(currentPly)}
            x2={xFor(currentPly)}
            y1={0}
            y2={height}
            stroke="rgba(155,199,0,0.9)"
            strokeWidth={1.5}
          />
        )}
        {hover && hover.pawns !== null && (
          <circle cx={xFor(hover.ply)} cy={yFor(hover.pawns)} r={3} fill="rgba(155,199,0,0.95)" stroke={CHART_BG} strokeWidth={1.5} />
        )}
      </svg>
      {hover && hover.pawns !== null && (
        <div
          className="absolute -top-1 px-1.5 py-0.5 rounded-sm bg-[#2a2825] border border-[#3a3835] text-xs font-mono text-foreground whitespace-nowrap pointer-events-none z-10"
          style={{
            left: Math.min(Math.max(xFor(hover.ply), 32), width - 32),
            transform: "translate(-50%, -100%)",
          }}
        >
          ply {hover.ply} {fmt(hover.pawns)}
        </div>
      )}
    </div>
  )
}

/**
 * Mean eval by ply across all completed games, normalized to engine A's
 * perspective (so + always favors A). Games where A played Black are
 * sign-flipped, otherwise color-flipped pairs would cancel to ~0.
 */
function AverageEvalGraph({
  outcomes,
  labelA,
  labelB,
}: {
  outcomes: GameOutcome[]
  labelA: string
  labelB: string
}) {
  const avg = useMemo(() => averageEvalByPly(outcomes), [outcomes])
  if (avg.length < 2) return null
  const maxAbs = Math.max(0.5, ...avg.map((p) => Math.abs(p.mean)))
  const points: EvalPoint[] = avg.map((p) => ({ ply: p.ply, pawns: p.mean }))
  const finalMean = avg[avg.length - 1].mean

  return (
    <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Average eval by move</h2>
        <span className="text-xs text-muted-foreground font-mono">
          n={avg[0].n} games · final {finalMean >= 0 ? "+" : ""}{finalMean.toFixed(2)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Mean neutral-evaluator eval at each ply, from{" "}
        <span className="text-green-400">{labelA}</span>&apos;s perspective (+ ={" "}
        {labelA} better, − = <span className="text-sky-400">{labelB}</span> better).
        Games where {labelA} played Black are sign-flipped so colors don&apos;t cancel.
      </p>
      <EvalByPlyChart points={points} maxAbs={maxAbs} height={110} />
    </section>
  )
}

/** Result badge text/tint for a completed game, from engine A's point of view. */
function resultBadge(result: "1-0" | "0-1" | "1/2-1/2", flipped: boolean) {
  if (result === "1/2-1/2") return { text: "½–½", cls: "text-muted-foreground" }
  const aWon = (result === "1-0") === !flipped
  return aWon
    ? { text: result, cls: "text-green-400" }
    : { text: result, cls: "text-sky-400" }
}

/**
 * Browse completed games: pick one from the list, step through it on a board
 * (arrow keys / click the eval graph), and optionally open it in Analyze.
 */
export function ResultsExplorer({
  outcomes,
  labelA,
  labelB,
  onOpenGame,
  curve,
}: {
  outcomes: GameOutcome[]
  labelA: string
  labelB: string
  onOpenGame?: (pgn: string) => void
  /** Run-derived eval→win-prob curve for the swing labels (spec 212). */
  curve: WinProbCurve
}) {
  const games = useMemo(() => outcomes.filter(isOk), [outcomes])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [ply, setPly] = useState(0)

  // Per-game swing analysis (spec 212:82 — decisive moment + error counts in
  // the list, labeled moves with click-hop in the viewer). O(plies) per game,
  // no replay; computed once per completed report.
  const analyses = useMemo(() => {
    const m = new Map<number, GameAnalysis>()
    for (const g of games) m.set(g.id, analyzeGame(g, curve))
    return m
  }, [games, curve])

  // Default to the first game once results arrive / change.
  useEffect(() => {
    setSelectedId(games.length ? games[0].id : null)
  }, [games])

  const selected = useMemo(
    () => (selectedId === null ? null : games.find((g) => g.id === selectedId) ?? null),
    [games, selectedId],
  )
  const gr = selected ? gameResult(selected) : null

  // Positions for the selected game; the board hops among these by ply.
  const fens = useMemo(
    () => (gr ? replayFens(gr.start_fen, gr.moves) : []),
    [gr],
  )
  const series = useMemo(
    () => (selected ? gameEvalSeries(selected) : []),
    [selected],
  )
  const maxAbs = useMemo(
    () => Math.max(0.5, ...series.map((p) => (p.pawns === null ? 0 : Math.abs(p.pawns)))),
    [series],
  )

  // Snap the cursor to the final position whenever the selected game changes —
  // unless the selection carried a pending hop target (a decisive-moment /
  // labeled-move click), which wins over the default snap-to-end.
  const pendingHop = useRef<number | null>(null)
  useEffect(() => {
    const maxPly = fens.length ? fens.length - 1 : 0
    const hop = pendingHop.current
    pendingHop.current = null
    setPly(hop !== null ? Math.min(hop, maxPly) : maxPly)
  }, [fens])

  const maxPly = Math.max(0, fens.length - 1)
  const step = useCallback(
    (d: number) => setPly((p) => Math.min(maxPly, Math.max(0, p + d))),
    [maxPly],
  )

  if (games.length === 0) return null

  const whiteLabel = (o: GameOutcome) => (o.flipped ? labelB : labelA)
  const blackLabel = (o: GameOutcome) => (o.flipped ? labelA : labelB)
  const fen = fens[ply] ?? gr?.start_fen ?? ""
  const lastMove =
    gr && ply > 0 && gr.moves[ply - 1] ? uciSquares(gr.moves[ply - 1]) : undefined
  const moveNo = Math.floor((ply + 1) / 2)

  return (
    <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-foreground">Games</h2>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,240px)_1fr] gap-4">
        {/* Game list */}
        <div className="max-h-[420px] overflow-y-auto rounded-md border border-white/10 divide-y divide-white/5">
          {games.map((o) => {
            const g = gameResult(o)!
            const badge = resultBadge(g.result, o.flipped)
            const an = analyses.get(o.id)
            const errs = an
              ? {
                  blunders: an.counts.a.blunder + an.counts.b.blunder,
                  mistakes: an.counts.a.mistake + an.counts.b.mistake,
                  inaccuracies: an.counts.a.inaccuracy + an.counts.b.inaccuracy,
                }
              : null
            const dec = an?.decisive ?? null
            return (
              <button
                key={o.id}
                data-testid={`tournament-game-row-${o.id}`}
                onClick={() => {
                  setSelectedId(o.id)
                  // Clicking a game with a decisive moment hops straight to it
                  // (spec 212:34-35). The immediate setPly covers re-clicks on
                  // the already-selected game; pendingHop overrides the
                  // snap-to-end effect when the selection changes.
                  if (dec) {
                    pendingHop.current = dec.ply
                    setPly(dec.ply)
                  }
                }}
                className={`w-full text-left px-2.5 py-1.5 flex flex-col gap-0.5 transition-colors ${
                  o.id === selectedId ? "bg-primary/20" : "hover:bg-white/5"
                }`}
              >
                <span className="flex items-center gap-2 w-full">
                  <span className="text-[11px] text-muted-foreground font-mono w-8 shrink-0">
                    #{o.id}
                  </span>
                  <span className="text-xs text-foreground truncate flex-1 min-w-0">
                    {whiteLabel(o)} <span className="text-muted-foreground">vs</span> {blackLabel(o)}
                  </span>
                  <span className={`text-xs font-mono ${badge.cls}`}>{badge.text}</span>
                  <span className="text-[10px] text-muted-foreground font-mono w-8 text-right shrink-0">
                    {g.plies}p
                  </span>
                </span>
                {/* Spec 212:82 — decisive moment + error counts per game. */}
                {(dec || (errs && (errs.blunders || errs.mistakes || errs.inaccuracies))) && (
                  <span className="flex items-center gap-2 pl-10 text-[10px] font-mono">
                    {dec && (
                      <span className="text-muted-foreground">
                        decided m{Math.floor((dec.ply + 1) / 2)} ·{" "}
                        <span className={dec.engine === "a" ? "text-green-400" : "text-sky-400"}>
                          {dec.engine === "a" ? labelA : labelB}
                        </span>
                      </span>
                    )}
                    {errs && errs.blunders > 0 && <span className="text-red-400">{errs.blunders}??</span>}
                    {errs && errs.mistakes > 0 && <span className="text-amber-400">{errs.mistakes}?</span>}
                    {errs && errs.inaccuracies > 0 && (
                      <span className="text-muted-foreground">{errs.inaccuracies}?!</span>
                    )}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Selected game viewer */}
        {selected && gr && (
          <div
            className="flex flex-col gap-3 outline-none"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); step(-1) }
              else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); step(1) }
              else if (e.key === "Home") { e.preventDefault(); e.stopPropagation(); setPly(0) }
              else if (e.key === "End") { e.preventDefault(); e.stopPropagation(); setPly(maxPly) }
            }}
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground">
                <span className="text-foreground">#{selected.id}</span>{" "}
                {whiteLabel(selected)} vs {blackLabel(selected)} ·{" "}
                {gr.termination.replace(/_/g, " ")}
              </span>
              {onOpenGame && (
                <button
                  data-testid="tournament-open-in-analyze"
                  onClick={() =>
                    // Annotated handoff (spec 212:58-61): swing labels arrive
                    // on the Analyze tree as NAGs + comments (plus [%eval]
                    // tags for the eval graph). Falls back to the plain PGN
                    // when the game can't be annotated (no evals is fine —
                    // annotatedGamePgn still emits the bare moves then).
                    onOpenGame(
                      annotatedGamePgn(selected, curve, {
                        event: "Engine tournament",
                        white: whiteLabel(selected),
                        black: blackLabel(selected),
                        engineNames: { a: labelA, b: labelB },
                      }) ??
                        movesToPgn(gr.start_fen, gr.moves, gr.result, {
                          event: "Engine tournament",
                          white: whiteLabel(selected),
                          black: blackLabel(selected),
                        }),
                    )
                  }
                  className="px-2.5 py-1 text-xs rounded-md border border-input text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
                >
                  Open in Analyze
                </button>
              )}
            </div>

            <div className="flex items-start gap-3">
              <div className="w-[min(46vw,320px)] shrink-0">
                <Board
                  fen={fen}
                  orientation="white"
                  viewOnly
                  legalMoves={EMPTY_DESTS}
                  onMove={noop}
                  lastMove={lastMove as [Key, Key] | undefined}
                />
              </div>
            </div>

            {/* Step controls */}
            <div className="flex items-center gap-1">
              <StepButton label="⏮" title="Start (Home)" onClick={() => setPly(0)} />
              <StepButton label="◀" title="Back (←)" onClick={() => step(-1)} />
              <span className="text-xs text-muted-foreground font-mono px-2 tabular-nums">
                move {moveNo} · ply {ply}/{maxPly}
              </span>
              <StepButton label="▶" title="Forward (→)" onClick={() => step(1)} />
              <StepButton label="⏭" title="End (End)" onClick={() => setPly(maxPly)} />
            </div>

            {/* Per-game eval curve (White-POV); click to hop the board */}
            {series.length >= 2 ? (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  Neutral eval by move (White-POV) — click to jump
                </span>
                <EvalByPlyChart
                  points={series}
                  maxAbs={maxAbs}
                  height={84}
                  currentPly={ply}
                  onPick={setPly}
                />
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">
                No per-move evals for this game (evaluator was off).
              </span>
            )}

            {/* Error report for the selected game (spec 212:23-35): decisive
                moment + every labeled move, each a click-hop to its ply. */}
            {(() => {
              const an = analyses.get(selected.id)
              if (!an || an.labeled.length === 0) return null
              const engineName = (e: "a" | "b") => (e === "a" ? labelA : labelB)
              const moveNoOf = (p: number) => Math.floor((p + 1) / 2)
              const glyph = { blunder: "??", mistake: "?", inaccuracy: "?!" } as const
              const tint = {
                blunder: "text-red-400 border-red-400/40",
                mistake: "text-amber-400 border-amber-400/40",
                inaccuracy: "text-muted-foreground border-input",
              } as const
              return (
                <div className="flex flex-col gap-1.5">
                  {an.decisive && (
                    <button
                      data-testid="tournament-decisive-hop"
                      onClick={() => setPly(Math.min(an.decisive!.ply, maxPly))}
                      className="self-start text-xs text-foreground hover:underline text-left"
                    >
                      Decided at move {moveNoOf(an.decisive.ply)} —{" "}
                      <span className={an.decisive.engine === "a" ? "text-green-400" : "text-sky-400"}>
                        {engineName(an.decisive.engine)}
                      </span>{" "}
                      {an.decisive.label ?? "swing"} (−{Math.round(an.decisive.drop * 100)}pp)
                    </button>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {an.labeled.map((s: MoveSwing) => (
                      <button
                        key={s.ply}
                        data-testid={`tournament-labeled-move-${selected.id}-${s.ply}`}
                        onClick={() => setPly(Math.min(s.ply, maxPly))}
                        title={`${engineName(s.engine)} · win prob ${Math.round(s.wpBefore * 100)}% → ${Math.round(s.wpAfter * 100)}%${
                          s.bestMoveGapCp !== null ? ` · ${s.bestMoveGapCp}cp off best` : ""
                        }${s.clockMs !== null ? ` · ${(s.clockMs / 1000).toFixed(1)}s left` : ""}`}
                        className={`px-1.5 py-0.5 text-[11px] font-mono rounded-sm border hover:bg-white/5 transition-colors ${tint[s.label!]}`}
                      >
                        m{moveNoOf(s.ply)} {glyph[s.label!]} −{Math.round(s.drop * 100)}pp
                      </button>
                    ))}
                  </div>
                </div>
              )
            })()}

            {/* Persona decision logs (spec 218 "Exhibition & tournament"
                checklist item 4): inspectable per-move "why" for any persona
                side in this game. Absent for a pure-UCI game. */}
            {selected.persona_logs && selected.persona_logs.length > 0 && (
              <PersonaLogPanel
                logs={selected.persona_logs}
                whiteLabel={whiteLabel(selected)}
                blackLabel={blackLabel(selected)}
              />
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function StepButton({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="px-2 py-1 text-sm rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
    >
      {label}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Persona decision log (spec 218 "Exhibition & tournament" checklist item 4)
// ---------------------------------------------------------------------------

/**
 * One persona move's inspectable "why" (spec 214 contract step 9): which arm
 * decided it (verify-reweight vs pure policy), the band it came from, and
 * every candidate it weighed — policy probability, verification eval, the
 * eval penalty, and the final sampling weight. Collapsed by default so a long
 * game's log doesn't dominate the page; click to expand one ply at a time.
 */
function PersonaDecisionRow({
  entry,
  sideLabel: label,
}: {
  entry: PersonaLogEntry
  sideLabel: string
}) {
  const [open, setOpen] = useState(false)
  const d: PersonaDecision = entry.decision
  return (
    <div className="border border-white/10 rounded-md overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs hover:bg-white/5 transition-colors text-left"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-muted-foreground font-mono w-10 shrink-0">ply {entry.ply}</span>
          <span className="text-foreground font-mono">{d.san}</span>
          <span className="text-muted-foreground truncate">{label} ({entry.color})</span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          <Badge variant="secondary" className="text-[10px] font-mono">
            {d.reason === "verify-reweight" ? "verified" : "policy-only"}
          </Badge>
          <span className="text-muted-foreground font-mono">band {d.band}</span>
          <span className="text-muted-foreground">{open ? "▲" : "▼"}</span>
        </span>
      </button>
      {open && (
        <div className="px-2.5 pb-2 overflow-x-auto">
          <table className="w-full text-[11px] font-mono border-collapse">
            <thead>
              <tr className="text-muted-foreground text-left">
                <th className="pr-3 py-1">move</th>
                <th className="pr-3 py-1">policy</th>
                <th className="pr-3 py-1">eval (cp)</th>
                <th className="pr-3 py-1">penalty</th>
                <th className="pr-3 py-1">weight</th>
              </tr>
            </thead>
            <tbody>
              {[...d.candidates]
                .sort((a, b) => b.weight - a.weight)
                .map((c: PersonaCandidate) => (
                  <tr
                    key={c.uci}
                    className={c.uci === d.uci ? "text-green-400" : "text-foreground/80"}
                  >
                    <td className="pr-3 py-0.5">{c.san}{c.uci === d.uci ? " ←" : ""}</td>
                    <td className="pr-3 py-0.5">{(c.policy_prob * 100).toFixed(1)}%</td>
                    <td className="pr-3 py-0.5">{c.eval_cp ?? "—"}</td>
                    <td className="pr-3 py-0.5">{c.eval_penalty.toFixed(2)}</td>
                    <td className="pr-3 py-0.5">{(c.weight * 100).toFixed(1)}%</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <div className="text-[10px] text-muted-foreground pt-1">
            derived seed {d.derived_seed}
          </div>
        </div>
      )}
    </div>
  )
}

/** Expandable per-move persona decision log for one game (spec 218 item 4) —
 *  shared by the batch ResultsExplorer and the exhibition viewer, since both
 *  read the same `GameOutcome.persona_logs`. */
function PersonaLogPanel({
  logs,
  whiteLabel,
  blackLabel,
}: {
  logs: PersonaLogEntry[]
  whiteLabel: string
  blackLabel: string
}) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-white/10 pt-3">
      <span className="text-xs text-muted-foreground">
        Persona decisions ({logs.length} move{logs.length === 1 ? "" : "s"}) — click a row for the
        full candidate weighing
      </span>
      <div className="flex flex-col gap-1 max-h-72 overflow-y-auto">
        {logs.map((entry) => (
          <PersonaDecisionRow
            key={entry.ply}
            entry={entry}
            sideLabel={entry.color === "white" ? whiteLabel : blackLabel}
          />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Exhibition viewer (spec 218 "Exhibition framing" checklist item)
// ---------------------------------------------------------------------------

/**
 * The exhibition's featured single-game presentation: board + eval bar + a
 * numbered SAN move list (spec 218 item 3 — "the live viewer currently shows
 * only 'game #N · move M' ... give it a real move list"). Deliberately
 * self-contained within this tab rather than reusing app/page.tsx's
 * LiveGameView: that shared full-screen viewer was out of THIS item's file
 * scope, so this renders inline in the tab's own scroll area instead — less
 * stats-first than the batch view above, but still a second, DIFFERENT
 * viewer from the shared one. The same numbered-move fix has since landed in
 * app/page.tsx's LiveGameView too (spec 210 Phase 4 tick-pass, 2026-07-15) —
 * both viewers now share the exact sansFromUci/numberMoves reconstruction,
 * just rendered in each one's own layout.
 */
function ExhibitionView({
  running,
  fen,
  lastMove,
  whiteMs,
  blackMs,
  evalScore,
  showEvalBar,
  whiteLabel,
  blackLabel,
  rows,
  outcome,
  error,
}: {
  running: boolean
  fen: string
  lastMove?: [string, string]
  whiteMs: number
  blackMs: number
  evalScore: { cp: number | null; mate: number | null } | null
  showEvalBar: boolean
  whiteLabel: string
  blackLabel: string
  rows: NumberedPly[]
  outcome: GameOutcome | null
  error: string | null
}) {
  const gr = outcome ? gameResult(outcome) : null
  const err = outcome ? gameError(outcome) : null
  const statusText = running
    ? "Live"
    : gr
      ? `${gr.result} · ${gr.termination.replace(/_/g, " ")}`
      : err
        ? `Error: ${err}`
        : error
          ? `Error: ${error}`
          : ""

  const barScore = evalScore
    ? evalScore.mate != null
      ? ({ type: "mate", value: evalScore.mate } as const)
      : ({ type: "cp", value: evalScore.cp ?? 0 } as const)
    : null

  return (
    <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-foreground">
          Exhibition — {whiteLabel} vs {blackLabel}
        </h2>
        <span className={`text-xs font-mono ${running ? "text-green-400" : "text-muted-foreground"}`}>
          {statusText}
        </span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-4 items-start">
        <div className="flex items-start gap-2">
          {showEvalBar && barScore && <EvalBar score={barScore} turn="white" width={20} />}
          <div className="flex flex-col gap-1 w-[min(70vw,360px)]">
            <div className="flex items-center justify-between text-xs text-muted-foreground font-mono">
              <span className="truncate">{blackLabel}</span>
              <span>{formatDuration(blackMs)}</span>
            </div>
            <Board
              fen={fen}
              orientation="white"
              viewOnly
              legalMoves={EMPTY_DESTS}
              onMove={noop}
              lastMove={lastMove as [Key, Key] | undefined}
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground font-mono">
              <span className="truncate">{whiteLabel}</span>
              <span>{formatDuration(whiteMs)}</span>
            </div>
          </div>
        </div>

        {/* Numbered SAN move list (spec 218 "Move numbers" ship-now item,
            landing here for the exhibition — "for easier reference in
            'didn't feel like him'"). */}
        <div className="flex flex-col gap-1 max-h-[360px] overflow-y-auto">
          <span className="text-xs text-muted-foreground">Moves</span>
          {rows.length === 0 ? (
            <span className="text-xs text-muted-foreground">Waiting for the first move&hellip;</span>
          ) : (
            <ol className="text-sm font-mono text-foreground grid grid-cols-[auto_1fr_1fr] gap-x-2 gap-y-0.5">
              {rows.map((row) => (
                <li key={row.no} className="contents">
                  <span className="text-muted-foreground text-right">{row.no}.</span>
                  <span>{row.white ?? ""}</span>
                  <span>{row.black ?? ""}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      {outcome?.persona_logs && outcome.persona_logs.length > 0 && (
        <PersonaLogPanel logs={outcome.persona_logs} whiteLabel={whiteLabel} blackLabel={blackLabel} />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Round-robin tournament (spec 210 Phase 6)
// ---------------------------------------------------------------------------

/** Everything the cross-table/standings/Elo views need to render one
 *  round-robin result — shared by the live run and a loaded saved result. */
type RoundRobinDisplay = {
  /** id+label per participant, snapshotted at run start (like reportLabels)
   *  so post-run roster/selection changes never relabel a finished result. */
  participants: { id: string; label: string }[]
  labels: string[]
  table: CrossTable
  estimates: EloEstimate[]
  gamesPerPairing: number
  timeControl: { baseMs: number; incMs: number }
  completedAt?: string
  name?: string
}

/** Turn a persisted result back into the display shape. Standings/Elo could
 *  be recomputed from the crossTable (buildStandings is), but the saved elo
 *  rows are kept verbatim — they record what was reported at save time. */
function displayFromSaved(saved: RoundRobinResultExport): RoundRobinDisplay {
  return {
    participants: saved.participants,
    labels: saved.participants.map((p) => p.label),
    table: { n: saved.participants.length, cells: saved.crossTable },
    estimates: saved.elo.map((e, idx) => ({
      idx,
      elo: e.elo,
      se: e.se ?? Infinity,
      games: e.games,
      anchored: e.anchored,
    })),
    gamesPerPairing: saved.gamesPerPairing,
    timeControl: saved.timeControl,
    completedAt: saved.completedAt,
    name: saved.name,
  }
}

function RoundRobinSection({
  roster,
  baseMs,
  incMs,
  concurrency,
  adjudicateTb,
  otherRunActive,
  running,
  onRunningChange,
}: {
  roster: TournamentRosterEntry[]
  baseMs: number
  incMs: number
  concurrency: number
  adjudicateTb: boolean
  /** A head-to-head batch or exhibition is running (shared BatchControl). */
  otherRunActive: boolean
  running: boolean
  onRunningChange: (running: boolean) => void
}) {
  // Selected roster entry ids, in roster order. Default: the two MVP engines.
  const [selectedIds, setSelectedIds] = useState<string[]>([
    "engine-stockfish",
    "engine-reckless",
  ])
  const [gamesPerPairing, setGamesPerPairing] = useState("2")
  // Opening variety: "book" seeds each color-flipped pair from a different
  // roughly-balanced tagged position; "normal" plays every game from the
  // standard start (deterministic engines will repeat games — personas won't).
  const [openings, setOpenings] = useState<"book" | "normal">("book")

  const [error, setError] = useState<string | null>(null)
  const [tally, setTallyRR] = useState<{ completed: number; total: number } | null>(null)
  const [display, setDisplay] = useState<RoundRobinDisplay | null>(null)
  const [isLoadedResult, setIsLoadedResult] = useState(false)

  // Persistence: saved-results list + save feedback.
  const [savedList, setSavedList] = useState<SavedTournamentMeta[]>([])
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [canSaveCurrent, setCanSaveCurrent] = useState(false)

  const refreshSaved = useCallback(async () => {
    try {
      const list = await invoke<SavedTournamentMeta[]>("list_tournament_results")
      setSavedList(list.filter((m) => m.kind === "round-robin"))
    } catch {
      // Not fatal (e.g. plain-browser dev without Tauri): the list stays empty.
    }
  }, [])
  useEffect(() => { void refreshSaved() }, [refreshSaved])

  const selected = useMemo(
    () => roster.filter((e) => selectedIds.includes(e.participant.id)),
    [roster, selectedIds],
  )
  const mNum = Math.max(1, Math.min(100, Math.round(Number(gamesPerPairing) || 2)))
  const totalScheduled = roundRobinGameCount(selected.length, mNum)

  const toggle = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const runRR = useCallback(async () => {
    setError(null)
    setSaveMsg(null)
    setDisplay(null)
    setIsLoadedResult(false)
    setCanSaveCurrent(false)
    onRunningChange(true)
    try {
      const entries = roster.filter((e) => selectedIds.includes(e.participant.id))
      if (entries.length < 2) throw new Error("Pick at least two participants.")
      // Snapshot labels/participants at run start (same reportLabels pattern
      // as the head-to-head run) — persona sides get a fresh per-run seed.
      const labels = entries.map((e) => e.label)
      const savedParticipants = entries.map((e) => ({ id: e.participant.id, label: e.label }))
      const participants = entries.map((e) => withFreshSeed(e.participant))

      // One seed per color-flipped pair per pairing.
      const nPairs = (participants.length * (participants.length - 1)) / 2
      const seedsNeeded = nPairs * Math.ceil(mNum / 2)
      const positions = openings === "book" ? await loadPositions() : []
      const seeds = buildSeeds(openings, seedsNeeded, positions)

      const { specs, pairingById } = buildRoundRobinSpecs(
        participants,
        mNum,
        seeds,
        baseMs,
        incMs,
        MAX_PLIES,
        adjudicateTb,
      )
      setTallyRR({ completed: 0, total: specs.length })

      // Live cross-table/standings/Elo: recompute from every completed game
      // as each BatchProgress event lands (cheap at these sizes).
      const accumulated: GameOutcome[] = []
      const recompute = () => {
        const table = buildCrossTable(participants.length, accumulated, pairingById)
        setDisplay({
          participants: savedParticipants,
          labels,
          table,
          estimates: estimateElo(table, 0),
          gamesPerPairing: mNum,
          timeControl: { baseMs, incMs },
        })
      }
      const channel = new Channel<BatchProgress>()
      channel.onmessage = (p: BatchProgress) => {
        accumulated.push(p.last)
        setTallyRR({ completed: p.completed, total: p.total })
        recompute()
      }
      // The round-robin view is stats-only: no live board, no evaluator.
      const moveChannel = new Channel<MoveEvent>()
      const evalChannel = new Channel<EvalEvent>()

      const result = await invoke<BatchReport>("play_batch", {
        specs: specs as GameSpec[],
        concurrency,
        onProgress: channel,
        onMove: moveChannel,
        onEval: evalChannel,
        evalPath: null,
        evalMovetimeMs: null,
        autoStart: true,
        moveDelayMs: 0,
      })

      // Authoritative final recompute from the full report.
      accumulated.length = 0
      accumulated.push(...result.outcomes)
      recompute()
      setCanSaveCurrent(true)
    } catch (e) {
      setError(String(e))
    } finally {
      onRunningChange(false)
    }
  }, [roster, selectedIds, mNum, openings, baseMs, incMs, concurrency, adjudicateTb, onRunningChange])

  const cancelRR = useCallback(async () => {
    try { await invoke("cancel_batch") } catch (e) { setError(String(e)) }
  }, [])

  const saveResult = useCallback(async () => {
    if (!display) return
    try {
      const name = `Round-robin — ${display.labels.length} participants, ${display.gamesPerPairing} games/pairing`
      const exported = buildRoundRobinExport(
        name,
        display.participants,
        display.gamesPerPairing,
        display.timeControl,
        display.table,
        display.estimates,
      )
      const file = await invoke<string>("save_tournament_result", { result: exported })
      setSaveMsg(`Saved as ${file}`)
      setCanSaveCurrent(false)
      void refreshSaved()
    } catch (e) {
      setError(String(e))
    }
  }, [display, refreshSaved])

  const loadResult = useCallback(async (file: string) => {
    setError(null)
    try {
      const v = await invoke<RoundRobinResultExport>("load_tournament_result", { file })
      if (v?.kind !== "round-robin" || !Array.isArray(v.participants)) {
        throw new Error(`Not a round-robin result: ${file}`)
      }
      setDisplay(displayFromSaved(v))
      setIsLoadedResult(true)
      setCanSaveCurrent(false)
      setTallyRR(null)
      setSaveMsg(null)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  const pct = tally && tally.total > 0 ? (tally.completed / tally.total) * 100 : 0

  return (
    <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Round-robin tournament</h2>
        <p className="text-xs text-muted-foreground">
          Every pair of participants plays {mNum} game{mNum === 1 ? "" : "s"} (colors
          flip within each pairing). Uses the time control, concurrency and
          adjudication configured above; bot entries keep their honest strength labels.
        </p>
      </div>

      {/* Participant multi-select */}
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">
          Participants ({selected.length} selected)
        </span>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 max-h-48 overflow-y-auto border border-white/10 rounded-md p-2">
          {roster.map((e) => (
            <label
              key={e.participant.id}
              className={`flex items-center gap-2 text-sm cursor-pointer select-none ${e.disabled ? "opacity-50" : ""}`}
            >
              <input
                type="checkbox"
                data-testid={`rr-participant-${e.participant.id}`}
                className="accent-green-600"
                checked={selectedIds.includes(e.participant.id)}
                onChange={() => toggle(e.participant.id)}
                disabled={running || Boolean(e.disabled)}
              />
              <span className="text-foreground truncate">{e.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Games per pairing</span>
          <input
            type="number"
            min={1}
            max={100}
            data-testid="rr-games-per-pairing"
            className="w-28 bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
            value={gamesPerPairing}
            onChange={(e) => setGamesPerPairing(e.target.value)}
            disabled={running}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Openings</span>
          <select
            data-testid="rr-openings"
            className="bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
            value={openings}
            onChange={(e) => setOpenings(e.target.value as "book" | "normal")}
            disabled={running}
          >
            <option value="book">Varied balanced openings</option>
            <option value="normal">Standard start every game</option>
          </select>
        </label>
        <span className="text-xs text-muted-foreground pb-2" data-testid="rr-total-games">
          {selected.length >= 2
            ? `${totalScheduled} games total (${selected.length} participants, ${(selected.length * (selected.length - 1)) / 2} pairings)`
            : "Pick at least two participants."}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <Button
          data-testid="rr-run"
          onClick={runRR}
          disabled={running || otherRunActive || selected.length < 2}
        >
          {running ? "Running…" : "Run Round-robin"}
        </Button>
        {running && (
          <Button variant="destructive" onClick={cancelRR}>
            Cancel
          </Button>
        )}
        {tally && (
          <span className="text-xs text-muted-foreground font-mono">
            {tally.completed} / {tally.total}
          </span>
        )}
      </div>
      {running && tally && <Progress value={pct} />}

      {error && (
        <div className="bg-red-900/40 border border-red-700/50 text-red-100 rounded-md px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {display && (
        <>
          {isLoadedResult && (
            <div className="text-xs text-muted-foreground">
              Loaded saved result{display.name ? `: ${display.name}` : ""}
              {display.completedAt ? ` (${formatMeasuredDate(display.completedAt)})` : ""}
            </div>
          )}
          <StandingsView
            labels={display.labels}
            table={display.table}
            estimates={display.estimates}
          />
          <CrossTableView labels={display.labels} cells={display.table.cells} />
          {canSaveCurrent && (
            <div className="flex items-center gap-3">
              <Button size="sm" variant="outline" data-testid="rr-save" onClick={saveResult}>
                Save result
              </Button>
              <span className="text-xs text-muted-foreground">
                Writes the cross-table + Elo estimates to this app&apos;s data folder.
              </span>
            </div>
          )}
          {saveMsg && <span className="text-xs text-green-400 font-mono">{saveMsg}</span>}
        </>
      )}

      {/* Saved results (spec 210 Phase 6 persistence checklist item) */}
      {savedList.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-white/10 pt-3" data-testid="rr-saved-list">
          <span className="text-xs font-semibold text-foreground">Saved tournaments</span>
          {savedList.map((m) => (
            <div key={m.file} className="flex items-center gap-2 text-xs">
              <button
                data-testid={`rr-load-${m.file}`}
                onClick={() => loadResult(m.file)}
                disabled={running}
                className="px-2 py-0.5 rounded-md border border-input text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                Load
              </button>
              <span className="text-foreground truncate">{m.name || m.file}</span>
              <span className="text-muted-foreground font-mono shrink-0">
                {m.total_games} games
                {m.completed_at ? ` · ${formatMeasuredDate(m.completed_at)}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** Standings + Elo estimates for one round-robin (live or loaded). */
function StandingsView({
  labels,
  table,
  estimates,
}: {
  labels: string[]
  table: CrossTable
  estimates: EloEstimate[]
}) {
  const rows = buildStandings(table)
  const eloByIdx = new Map(estimates.map((e) => [e.idx, e]))
  const anchorLabel = labels[estimates.find((e) => e.anchored)?.idx ?? 0] ?? "?"
  const fmtElo = (e: EloEstimate) => {
    const sign = e.elo >= 0 ? "+" : ""
    const pm = Number.isFinite(e.se) ? ` ± ${Math.round(e.se)}` : ""
    return `${sign}${Math.round(e.elo)}${pm}`
  }
  return (
    <div className="flex flex-col gap-1" data-testid="rr-standings">
      <span className="text-xs text-muted-foreground">Standings</span>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-muted-foreground text-left">
              <th className="pr-3 py-1">#</th>
              <th className="pr-3 py-1">participant</th>
              <th className="pr-3 py-1 text-right">games</th>
              <th className="pr-3 py-1 text-right">+ / = / −</th>
              <th className="pr-3 py-1 text-right">points</th>
              <th className="pr-3 py-1 text-right">Elo est.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, rank) => {
              const e = eloByIdx.get(r.idx)
              return (
                <tr key={r.idx} className="border-t border-white/5">
                  <td className="pr-3 py-1 text-muted-foreground">{rank + 1}</td>
                  <td className="pr-3 py-1 text-foreground">{labels[r.idx] ?? `#${r.idx}`}</td>
                  <td className="pr-3 py-1 text-right">{r.games}</td>
                  <td className="pr-3 py-1 text-right">
                    {r.wins} / {r.draws} / {r.losses}
                  </td>
                  <td className="pr-3 py-1 text-right text-foreground">{r.points}</td>
                  <td className="pr-3 py-1 text-right">
                    {e
                      ? e.anchored
                        ? "0 (anchor)"
                        : e.games > 0
                          ? `${fmtElo(e)} (from ${e.games} games)`
                          : "no games"
                      : "—"}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <span className="text-[10px] text-muted-foreground">
        Elo: logistic (Bradley–Terry) maximum likelihood over the cross-table,
        anchored to {anchorLabel} = 0. ± is an approximate standard error from
        each participant&apos;s own game count; a 1-virtual-draw-per-pairing prior
        keeps clean sweeps finite. Small samples stay honest: the ± says so.
      </span>
    </div>
  )
}

/** The full cross-table: cells[i][j] = row participant's record vs column. */
function CrossTableView({
  labels,
  cells,
}: {
  labels: string[]
  cells: (PairCell | null)[][]
}) {
  // Short column headers: index numbers keyed to the row labels.
  return (
    <div className="flex flex-col gap-1" data-testid="rr-cross-table">
      <span className="text-xs text-muted-foreground">
        Cross-table (row vs column: +wins =draws −losses, points)
      </span>
      <div className="overflow-x-auto">
        <table className="text-xs font-mono border-collapse">
          <thead>
            <tr className="text-muted-foreground text-left">
              <th className="pr-3 py-1" />
              {labels.map((_, j) => (
                <th key={j} className="px-2 py-1 text-center">{j + 1}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((label, i) => (
              <tr key={i} className="border-t border-white/5">
                <td className="pr-3 py-1 text-foreground whitespace-nowrap">
                  <span className="text-muted-foreground">{i + 1}.</span> {label}
                </td>
                {labels.map((_, j) => {
                  const c = cells[i]?.[j]
                  if (i === j || !c) {
                    return (
                      <td key={j} className="px-2 py-1 text-center text-muted-foreground">
                        {i === j ? "×" : "—"}
                      </td>
                    )
                  }
                  return (
                    <td
                      key={j}
                      className="px-2 py-1 text-center whitespace-nowrap"
                      title={`${label} vs ${labels[j]}: ${c.wins} wins, ${c.draws} draws, ${c.losses} losses (${c.games} games)`}
                    >
                      <span className="text-green-400">+{c.wins}</span>{" "}
                      <span className="text-muted-foreground">={c.draws}</span>{" "}
                      <span className="text-red-400">−{c.losses}</span>{" "}
                      <span className="text-foreground">({c.points})</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Spec 212 analyses (error profiles, band trajectories, seed breakdown,
// termination quality) — pure renders over lib/tournament-analysis.ts
// ---------------------------------------------------------------------------

const PHASE_LABEL: Record<string, string> = {
  opening: "Opening",
  middlegame: "Middlegame",
  endgame: "Endgame",
}

/** Per-engine error profile table (label × phase × clock pressure) + delta
 *  view — spec 212:37-40 / checklist "Per-engine error profile table". */
export function ErrorProfileSection({
  outcomes,
  curve,
  labelA,
  labelB,
  lowClockMs,
}: {
  outcomes: GameOutcome[]
  curve: WinProbCurve
  labelA: string
  labelB: string
  lowClockMs: number
}) {
  const profiles = useMemo(
    () => buildErrorProfiles(outcomes, curve, { lowClockMs }),
    [outcomes, curve, lowClockMs],
  )
  const deltaRows = useMemo(
    () => errorProfileDelta(profiles.a, profiles.b),
    [profiles],
  )
  if (profiles.a.moves === 0 && profiles.b.moves === 0) return null

  const fmtRate = (r: number | null) => (r === null ? "—" : r.toFixed(1))
  const fmtRatio = (r: number | null) =>
    r === null ? "—" : r === Infinity ? "∞" : `${r.toFixed(1)}×`
  const lowLabel = `<${Math.round(lowClockMs / 1000)}s`

  const profileTable = (label: string, p: EngineErrorProfile, tint: string) => (
    <div className="flex flex-col gap-1 min-w-0">
      <span className={`text-xs font-semibold ${tint}`}>
        {label}{" "}
        <span className="text-muted-foreground font-normal">
          ({p.moves} scored moves · {p.counts.blunder}?? {p.counts.mistake}? {p.counts.inaccuracy}?!)
        </span>
      </span>
      <div className="overflow-x-auto">
        <table className="text-[11px] font-mono w-full">
          <thead>
            <tr className="text-muted-foreground text-left">
              <th className="pr-2 py-0.5 font-normal">phase · clock</th>
              <th className="pr-2 py-0.5 font-normal text-right">moves</th>
              <th className="pr-2 py-0.5 font-normal text-right">??/100</th>
              <th className="pr-2 py-0.5 font-normal text-right">?/100</th>
              <th className="pr-2 py-0.5 font-normal text-right">?!/100</th>
            </tr>
          </thead>
          <tbody>
            {GAME_PHASES.flatMap((phase) =>
              CLOCK_BUCKETS.map((clock) => {
                const cell = p.cells[phase][clock]
                if (cell.moves === 0) return null
                return (
                  <tr key={`${phase}-${clock}`} className="border-t border-white/5">
                    <td className="pr-2 py-0.5 text-muted-foreground">
                      {PHASE_LABEL[phase]} · {clock === "low" ? lowLabel : "ok"}
                    </td>
                    <td className="pr-2 py-0.5 text-right">{cell.moves}</td>
                    <td className="pr-2 py-0.5 text-right text-red-400">{fmtRate(per100(cell, "blunder"))}</td>
                    <td className="pr-2 py-0.5 text-right text-amber-400">{fmtRate(per100(cell, "mistake"))}</td>
                    <td className="pr-2 py-0.5 text-right text-muted-foreground">{fmtRate(per100(cell, "inaccuracy"))}</td>
                  </tr>
                )
              }),
            )}
          </tbody>
        </table>
      </div>
    </div>
  )

  // Delta rows worth showing: at least one engine erred in the cell.
  const shownDelta = deltaRows.filter(
    (r) => (r.aRate ?? 0) > 0 || (r.bRate ?? 0) > 0,
  )

  return (
    <section
      data-testid="tournament-error-profile"
      className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-3"
    >
      <h2 className="text-sm font-semibold text-foreground">Error profile</h2>
      <p className="text-xs text-muted-foreground">
        Win-prob swing labels (thresholds 5/10/20pp on this run&apos;s own
        eval→win-prob curve) per 100 scored moves, split by game phase and
        clock pressure (mover under {Math.round(lowClockMs / 1000)}s after the
        move). ?? blunder · ? mistake · ?! inaccuracy.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {profileTable(labelA, profiles.a, "text-green-400")}
        {profileTable(labelB, profiles.b, "text-sky-400")}
      </div>
      {shownDelta.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-white/10 pt-3">
          <span className="text-xs font-semibold text-foreground">
            Delta — {labelB} vs {labelA}
          </span>
          <div className="overflow-x-auto">
            <table className="text-[11px] font-mono">
              <thead>
                <tr className="text-muted-foreground text-left">
                  <th className="pr-3 py-0.5 font-normal">cell</th>
                  <th className="pr-3 py-0.5 font-normal text-right">{labelA}</th>
                  <th className="pr-3 py-0.5 font-normal text-right">{labelB}</th>
                  <th className="pr-3 py-0.5 font-normal text-right">B/A</th>
                </tr>
              </thead>
              <tbody>
                {shownDelta.map((r) => (
                  <tr key={`${r.phase}-${r.clock}-${r.label}`} className="border-t border-white/5">
                    <td className="pr-3 py-0.5 text-muted-foreground">
                      {PHASE_LABEL[r.phase]} · {r.clock === "low" ? lowLabel : "ok"} ·{" "}
                      {r.label === "blunder" ? "??" : r.label === "mistake" ? "?" : "?!"}
                    </td>
                    <td className="pr-3 py-0.5 text-right">{fmtRate(r.aRate)}</td>
                    <td className="pr-3 py-0.5 text-right">{fmtRate(r.bRate)}</td>
                    <td className="pr-3 py-0.5 text-right text-foreground">{fmtRatio(r.ratio)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <span className="text-[10px] text-muted-foreground">
            Rates are errors per 100 scored moves; B/A &gt; 1 means {labelB} errs
            more in that cell.
          </span>
        </div>
      )}
    </section>
  )
}

/** Mean ± 1sd trajectory chart for one starting-eval band (inline SVG,
 *  matching the EvalByPlyChart inks). Engine-A perspective. */
function BandChart({ band, height = 90 }: { band: TrajectoryBand; height?: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(240)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setWidth(Math.max(80, el.getBoundingClientRect().width))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pts = band.points
  if (pts.length < 2) return null
  const minPly = pts[0].ply
  const maxPly = pts[pts.length - 1].ply
  const span = Math.max(1, maxPly - minPly)
  const dom = Math.max(1, ...pts.map((p) => Math.abs(p.mean) + p.sd))
  const xFor = (ply: number) => CHART_PAD_X + ((ply - minPly) / span) * (width - 2 * CHART_PAD_X)
  const yFor = (v: number) => {
    const c = Math.max(-dom, Math.min(dom, v))
    return CHART_PAD_Y + ((dom - c) / (2 * dom)) * (height - 2 * CHART_PAD_Y)
  }
  const mean = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${xFor(p.ply).toFixed(1)},${yFor(p.mean).toFixed(1)}`)
    .join(" ")
  const bandPath =
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${xFor(p.ply).toFixed(1)},${yFor(p.mean + p.sd).toFixed(1)}`).join(" ") +
    " " +
    [...pts]
      .reverse()
      .map((p) => `L${xFor(p.ply).toFixed(1)},${yFor(p.mean - p.sd).toFixed(1)}`)
      .join(" ") +
    " Z"
  const yZero = yFor(0)
  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      <svg width={width} height={height} className="block rounded-sm">
        <rect x={0} y={0} width={width} height={height} fill={CHART_BG} />
        <path d={bandPath} fill="rgba(123,179,58,0.18)" />
        <path d={mean} fill="none" stroke="#9bc700" strokeWidth={1.5} />
        <line x1={0} x2={width} y1={yZero} y2={yZero} stroke={CHART_MID} strokeWidth={1} strokeDasharray="3,3" />
      </svg>
    </div>
  )
}

/** Band trajectories (spec 212:45-47): mean ± spread of the A-perspective
 *  eval by ply, one small chart per starting-eval bucket. */
export function BandTrajectorySection({
  outcomes,
  evalById,
  labelA,
  labelB,
}: {
  outcomes: GameOutcome[]
  evalById: EvalMap
  labelA: string
  labelB: string
}) {
  const bands = useMemo(
    () => buildBandTrajectories(outcomes, evalById).filter((b) => b.games >= 2 && b.points.length >= 2),
    [outcomes, evalById],
  )
  if (bands.length === 0) return null
  const sign = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`
  return (
    <section
      data-testid="tournament-band-trajectories"
      className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-3"
    >
      <h2 className="text-sm font-semibold text-foreground">Band trajectories</h2>
      <p className="text-xs text-muted-foreground">
        How the advantage typically evolves from each starting-eval band, from{" "}
        <span className="text-green-400">{labelA}</span>&apos;s perspective (+ = {labelA}{" "}
        better, − = <span className="text-sky-400">{labelB}</span> better). Line =
        mean eval by ply; shading = ±1 sd across the band&apos;s games.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {bands.map((b) => (
          <div key={b.lo} className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground font-mono">
              start {sign(b.lo)}…{sign(b.hi)} · {b.games} game{b.games === 1 ? "" : "s"}
            </span>
            <BandChart band={b} />
          </div>
        ))}
      </div>
    </section>
  )
}

/** Seed / opening-family breakdown (spec 212:49-51): per-family score for
 *  engine A, lopsided families flagged. */
export function SeedBreakdownSection({
  outcomes,
  evalById,
  tagByFen,
  labelA,
}: {
  outcomes: GameOutcome[]
  evalById: EvalMap
  tagByFen?: Map<string, string>
  labelA: string
}) {
  const rows = useMemo(
    () => buildSeedBreakdown(outcomes, evalById, tagByFen),
    [outcomes, evalById, tagByFen],
  )
  if (rows.length <= 1) return null // a single family says nothing
  return (
    <section
      data-testid="tournament-seed-breakdown"
      className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-3"
    >
      <h2 className="text-sm font-semibold text-foreground">Starting-position families</h2>
      <p className="text-xs text-muted-foreground">
        Games grouped by curated-pool tag × |starting eval| bucket (each seed is
        played from both colors). Lopsided families — where {labelA} scores far
        from 50% with a real sample — are flagged: those are the position types
        one engine misplays.
      </p>
      <div className="overflow-x-auto">
        <table className="text-[11px] font-mono w-full">
          <thead>
            <tr className="text-muted-foreground text-left">
              <th className="pr-3 py-0.5 font-normal">family</th>
              <th className="pr-3 py-0.5 font-normal text-right">seeds</th>
              <th className="pr-3 py-0.5 font-normal text-right">games</th>
              <th className="pr-3 py-0.5 font-normal text-right">+/=/−</th>
              <th className="pr-3 py-0.5 font-normal text-right">{labelA} score</th>
              <th className="pr-3 py-0.5 font-normal" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-white/5">
                <td className="pr-3 py-0.5 text-muted-foreground">{r.key}</td>
                <td className="pr-3 py-0.5 text-right">{r.seeds}</td>
                <td className="pr-3 py-0.5 text-right">{r.games}</td>
                <td className="pr-3 py-0.5 text-right whitespace-nowrap">
                  <span className="text-green-400">{r.aWins}</span>
                  <span className="text-muted-foreground">/{r.draws}/</span>
                  <span className="text-sky-400">{r.aLosses}</span>
                </td>
                <td className="pr-3 py-0.5 text-right text-foreground">
                  {(r.aScore * 100).toFixed(0)}%
                </td>
                <td className="py-0.5">
                  {r.lopsided && (
                    <span className="text-amber-400" title="Lopsided: ≥4 games and ≥25pp from even">
                      ⚑ lopsided
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** Termination-quality cross table (spec 212:53-56): how games ended × how
 *  the loss happened (loser-error classification). */
export function TerminationQualitySection({
  outcomes,
  curve,
  labelA,
  labelB,
}: {
  outcomes: GameOutcome[]
  curve: WinProbCurve
  labelA: string
  labelB: string
}) {
  const rows = useMemo(
    () => buildTerminationQuality(outcomes, curve),
    [outcomes, curve],
  )
  if (rows.length === 0) return null
  return (
    <section
      data-testid="tournament-termination-quality"
      className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-3"
    >
      <h2 className="text-sm font-semibold text-foreground">Termination quality</h2>
      <p className="text-xs text-muted-foreground">
        Decisive games classified by the LOSER&apos;s labeled errors: ground
        down = lost with no move worse than an inaccuracy (the engine-gap
        signal between {labelA} and {labelB}); single blunder = one ?? decided
        it; multi-error = several errors ≥ mistake. &quot;Clean conversion&quot;
        counts the winner&apos;s side of the same games (no winner errors) and
        can overlap the loser columns.
      </p>
      <div className="overflow-x-auto">
        <table className="text-[11px] font-mono w-full">
          <thead>
            <tr className="text-muted-foreground text-left">
              <th className="pr-3 py-0.5 font-normal">termination</th>
              <th className="pr-3 py-0.5 font-normal text-right">games</th>
              <th className="pr-3 py-0.5 font-normal text-right">draws</th>
              <th className="pr-3 py-0.5 font-normal text-right">ground down</th>
              <th className="pr-3 py-0.5 font-normal text-right">single ??</th>
              <th className="pr-3 py-0.5 font-normal text-right">multi-error</th>
              <th className="pr-3 py-0.5 font-normal text-right">clean conv.</th>
              <th className="pr-3 py-0.5 font-normal text-right">unscored</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.termination} className="border-t border-white/5">
                <td className="pr-3 py-0.5 text-muted-foreground">
                  {r.termination.replace(/_/g, " ")}
                </td>
                <td className="pr-3 py-0.5 text-right">{r.games}</td>
                <td className="pr-3 py-0.5 text-right">{r.draws}</td>
                <td className="pr-3 py-0.5 text-right text-foreground">{r.groundDown}</td>
                <td className="pr-3 py-0.5 text-right text-red-400">{r.singleBlunder}</td>
                <td className="pr-3 py-0.5 text-right text-amber-400">{r.multiError}</td>
                <td className="pr-3 py-0.5 text-right text-green-400">{r.cleanConversion}</td>
                <td className="pr-3 py-0.5 text-right text-muted-foreground">{r.unscored}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

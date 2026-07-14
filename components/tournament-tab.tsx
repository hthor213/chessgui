"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { invoke, Channel } from "@tauri-apps/api/core"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  buildSeeds,
  buildSpecs,
  seedsForGames,
  buildProbabilityMap,
  buildEngineCurves,
  buildEngineWDL,
  eloDelta,
  gameResult,
  isOk,
  summarizeErrors,
  uciSquares,
  averageEvalByPly,
  gameEvalSeries,
  evalBarDefaultForBaseMs,
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
} from "@/lib/tournament"
import { replayFens, movesToPgn } from "@/lib/game-replay"
import type { Key } from "@lichess-org/chessground/types"

const Board = dynamic(
  () => import("@/components/board").then((m) => ({ default: m.Board })),
  { ssr: false },
)

const STOCKFISH_DEFAULT = "/opt/homebrew/bin/stockfish"
const RECKLESS_DEFAULT =
  "/Users/hjalti/github/chessgui/engines/reckless"

const MAX_PLIES = 400

type RunningTally = {
  completed: number
  total: number
  engineA: number
  engineB: number
  draw: number
  errors: number
  aborted: number
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
  const [engineA, setEngineA] = useState(STOCKFISH_DEFAULT)
  const [engineB, setEngineB] = useState(RECKLESS_DEFAULT)
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
  const [tally, setTally] = useState<RunningTally | null>(null)
  const [report, setReport] = useState<BatchReport | null>(null)
  const [probBins, setProbBins] = useState<ProbBin[]>([])
  const [curveBins, setCurveBins] = useState<EngineCurveBin[]>([])
  const [sfWdl, setSfWdl] = useState<ProbBin[]>([])
  const [rkWdl, setRkWdl] = useState<ProbBin[]>([])
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
        if (c.engineA) setEngineA(healPath(c.engineA) as string)
        if (c.engineB) setEngineB(healPath(c.engineB) as string)
        if (c.mode) setMode(c.mode)
        if (c.minEval != null) setMinEval(String(c.minEval))
        if (c.maxEval != null) setMaxEval(String(c.maxEval))
        if (c.nGames != null) setNGames(String(c.nGames))
        if (c.concurrency != null) setConcurrency(String(c.concurrency))
        if (c.tcId) setTcId(c.tcId)
        if (c.customBaseS != null) setCustomBaseS(String(c.customBaseS))
        if (c.customIncS != null) setCustomIncS(String(c.customIncS))
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
    const c = { engineA, engineB, mode, minEval, maxEval, nGames, concurrency, tcId, customBaseS, customIncS, adjudicateTb, useEvaluator, evaluatorPath, showEvalBar, evalBarTouched: evalBarTouched.current, autoStartNext, moveDelayMs }
    try { localStorage.setItem("chessgui-tournament-config", JSON.stringify(c)) } catch { /* ignore */ }
  }, [engineA, engineB, mode, minEval, maxEval, nGames, concurrency, tcId, customBaseS, customIncS, adjudicateTb, useEvaluator, evaluatorPath, showEvalBar, autoStartNext, moveDelayMs])

  // Base clock (ms) implied by the current time-control selection, used to
  // derive the eval-bar default and (in run) the actual game clock.
  const baseMsConfig = useMemo(() => {
    const preset = TIME_CONTROLS.find((t) => t.id === tcId)
    return preset
      ? preset.baseMs
      : Math.max(100, Math.round((Number(customBaseS) || 60) * 1000))
  }, [tcId, customBaseS])

  // Auto-check "show eval bar" for TCs at 60s+ (where per-move eval reads are
  // meaningful and there's time to watch), until the user touches the checkbox.
  useEffect(() => {
    if (evalBarTouched.current) return
    setShowEvalBar(evalBarDefaultForBaseMs(baseMsConfig))
  }, [baseMsConfig])

  // Keep the parent's live-view eval bar visibility in sync.
  useEffect(() => {
    onEvalBarChange?.(showEvalBar)
  }, [showEvalBar, onEvalBarChange])

  // Resolve each engine's UCI version (e.g. "Stockfish 18") for display.
  useEffect(() => {
    let cancelled = false
    setSfVersion(null)
    invoke<string>("engine_id", { path: engineA })
      .then((v) => { if (!cancelled) setSfVersion(v) })
      .catch(() => { if (!cancelled) setSfVersion("not found") })
    return () => { cancelled = true }
  }, [engineA])
  useEffect(() => {
    let cancelled = false
    setRkVersion(null)
    invoke<string>("engine_id", { path: engineB })
      .then((v) => { if (!cancelled) setRkVersion(v) })
      .catch(() => { if (!cancelled) setRkVersion("not found") })
    return () => { cancelled = true }
  }, [engineB])

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
    setStartedAt(Date.now())
    setNowTs(Date.now())
    setRunning(true)

    try {
      // Coerce the free-text numeric fields with sensible fallbacks/clamps.
      const nGamesNum = Math.max(2, Math.min(10000, Math.round(Number(nGames) || 100)))
      const concurrencyNum = Math.max(0, Math.round(Number(concurrency) || 0))

      // Resolve the time control (game clock, engine-managed).
      const preset = TIME_CONTROLS.find((t) => t.id === tcId)
      const baseMs = preset
        ? preset.baseMs
        : Math.max(100, Math.round((Number(customBaseS) || 60) * 1000))
      const incMs = preset
        ? preset.incMs
        : Math.max(0, Math.round((Number(customIncS) || 0) * 1000))
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
      // Current-position mode: engine A takes the user's chosen side in the
      // odd games; pairs still flip. flipFirst reverses each pair's order.
      const flipFirst = mode === "current" && engineASide === "black"
      const { specs, evalById } = buildSpecs(
        seeds,
        engineA,
        engineB,
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
      const labelA = engineLabel(engineA)
      const labelB = engineLabel(engineB)
      const specMeta = new Map<number, { whiteLabel: string; blackLabel: string }>()
      for (const s of specs) {
        specMeta.set(s.id, {
          whiteLabel: s.flipped ? labelB : labelA,
          blackLabel: s.flipped ? labelA : labelB,
        })
      }
      // Latest frame per game (for jumping to another in-flight game), the
      // featured game's full frame history (for back/forward nav), and per-game
      // latest eval (for the bar).
      const liveById = new Map<number, LiveFrame>()
      const completed = new Set<number>()
      const latestEval = new Map<number, { cp: number | null; mate: number | null }>()
      let featuredId: number | null = null
      let featuredFrames: LiveFrame[] = []

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
          }
        }
        if (m.game_id === featuredId) {
          featuredFrames.push(frame)
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

      // Live progress channel. The backend sends one BatchProgress per game.
      const channel = new Channel<BatchProgress>()
      channel.onmessage = (p: BatchProgress) => {
        completed.add(p.last.id)
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
            emitFeatured()
          }
        }
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
  }, [engineA, engineB, mode, minEval, maxEval, nGames, tcId, customBaseS, customIncS, concurrency, adjudicateTb, useEvaluator, evaluatorPath, autoStartNext, moveDelayMs, currentFen, engineASide, onLiveUpdate])

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

        {/* Engine configuration */}
        <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">Engines</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Engine A — White in game A (default: Stockfish)
              </span>
              <input
                className="bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground font-mono"
                value={engineA}
                onChange={(e) => setEngineA(e.target.value)}
                disabled={running}
                spellCheck={false}
              />
              <span className={`text-xs font-mono ${sfVersion === "not found" ? "text-amber-400" : "text-green-400"}`}>
                {sfVersion ? `→ ${sfVersion}` : "→ checking…"}
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Engine B — Black in game A (default: Reckless)
              </span>
              <input
                className="bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground font-mono"
                value={engineB}
                onChange={(e) => setEngineB(e.target.value)}
                disabled={running}
                spellCheck={false}
              />
              <span className={`text-xs font-mono ${rkVersion === "not found" ? "text-amber-400" : "text-sky-400"}`}>
                {rkVersion ? `→ ${rkVersion}` : "→ checking…"}
              </span>
            </label>
          </div>
        </section>

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
                  {engineLabel(engineA)} plays the first game as
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
            <Button onClick={run} disabled={running}>
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
              <span className="text-green-400">{engineLabel(engineA)} wins: {tally.engineA}</span>
              <span className="text-muted-foreground">Draws: {tally.draw}</span>
              <span className="text-sky-400">{engineLabel(engineB)} wins: {tally.engineB}</span>
              {tally.errors > 0 && (
                <span className="text-amber-400">Errors: {tally.errors}</span>
              )}
              {tally.aborted > 0 && (
                <span className="text-muted-foreground">Aborted: {tally.aborted}</span>
              )}
            </div>
          </section>
        )}

        {/* Final summary */}
        {report && (
          <SummaryCard
            outcomes={report.outcomes}
            labelA={engineLabel(engineA)}
            labelB={engineLabel(engineB)}
          />
        )}

        {/* Average eval progress across completed games (neutral evaluator) */}
        {report && (
          <AverageEvalGraph
            outcomes={report.outcomes}
            labelA={engineLabel(engineA)}
            labelB={engineLabel(engineB)}
          />
        )}

        {/* Per-game browser: select a game, hop to any position, open in Analyze */}
        {report && (
          <ResultsExplorer
            outcomes={report.outcomes}
            labelA={engineLabel(engineA)}
            labelB={engineLabel(engineB)}
            onOpenGame={onOpenGame}
          />
        )}

        {/* Per-engine performance curve (primary analysis) */}
        {report && curveBins.some((b) => b.a.games > 0 || b.b.games > 0) && (
          <EngineCurve
            bins={curveBins}
            labelA={engineLabel(engineA)}
            labelB={engineLabel(engineB)}
          />
        )}

        {/* Per-engine W/D/L: how each engine fared when up vs down each amount. */}
        {report && sfWdl.length > 0 && (
          <ProbabilityMap
            bins={sfWdl}
            title={`${engineLabel(engineA)} — results by its own starting eval`}
            desc={`How ${engineLabel(engineA)} fared from its own perspective: +x bins = it began up x pawns (conversion), −x bins = down x pawns (defense). The dot is its mean score.`}
            winLabel={`${engineLabel(engineA)} win`}
            lossLabel="loss"
            scoreLabel="avg score"
          />
        )}
        {report && rkWdl.length > 0 && (
          <ProbabilityMap
            bins={rkWdl}
            title={`${engineLabel(engineB)} — results by its own starting eval`}
            desc={`How ${engineLabel(engineB)} fared from its own perspective: +x bins = up x pawns (conversion), −x bins = down x pawns (defense). Compare the same bins against ${engineLabel(engineA)} above.`}
            winLabel={`${engineLabel(engineB)} win`}
            lossLabel="loss"
            scoreLabel="avg score"
          />
        )}

        {/* Probability map (advantaged side, both engines pooled) */}
        {report && probBins.length > 0 && (
          <ProbabilityMap bins={probBins} />
        )}
        {report && probBins.length === 0 && (
          <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 text-sm text-muted-foreground">
            No completed games to chart (all games errored?).
          </section>
        )}
      </div>
    </div>
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
  desc = "Each bar is one ~0.25-pawn starting-eval bin (White-POV). Stacks show how the advantaged (White) side fared; the dot marks the mean White score = how often that advantage converted.",
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
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{desc}</p>

      {/* Bars */}
      <div className="flex items-stretch gap-1 h-56">
        {bins.map((bin) => {
          const total = bin.count || 1
          const wPct = (bin.whiteWins / total) * 100
          const dPct = (bin.draws / total) * 100
          const bPct = (bin.blackWins / total) * 100
          // Dot vertical position: top = 1.0 score, bottom = 0.0 score.
          const dotBottomPct = bin.avgWhiteScore * 100
          return (
            <div
              key={bin.lo}
              className="flex-1 flex flex-col items-center gap-1 min-w-0"
              title={`eval [${bin.lo.toFixed(2)}, ${bin.hi.toFixed(2)})  n=${bin.count}  W ${bin.whiteWins} / D ${bin.draws} / B ${bin.blackWins}  avgWhiteScore=${(bin.avgWhiteScore * 100).toFixed(0)}%`}
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
function ResultsExplorer({
  outcomes,
  labelA,
  labelB,
  onOpenGame,
}: {
  outcomes: GameOutcome[]
  labelA: string
  labelB: string
  onOpenGame?: (pgn: string) => void
}) {
  const games = useMemo(() => outcomes.filter(isOk), [outcomes])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [ply, setPly] = useState(0)

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

  // Snap the cursor to the final position whenever the selected game changes.
  useEffect(() => {
    setPly(fens.length ? fens.length - 1 : 0)
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
            return (
              <button
                key={o.id}
                data-testid={`tournament-game-row-${o.id}`}
                onClick={() => setSelectedId(o.id)}
                className={`w-full text-left px-2.5 py-1.5 flex items-center gap-2 transition-colors ${
                  o.id === selectedId ? "bg-primary/20" : "hover:bg-white/5"
                }`}
              >
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
                    onOpenGame(
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

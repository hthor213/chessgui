"use client"

import { useCallback, useEffect, useRef, useState } from "react"
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
  summarizeErrors,
  uciSquares,
  TIME_CONTROLS,
  type BatchProgress,
  type BatchReport,
  type GameOutcome,
  type GameSpec,
  type LiveGame,
  type MoveEvent,
  type EvalMap,
  type ProbBin,
  type EngineCurveBin,
  type StartMode,
  type TaggedPosition,
} from "@/lib/tournament"

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
  currentFen,
  bottomColor = "white",
  presetNonce = 0,
}: {
  /** Reports whether a batch is currently running (for the header View toggle). */
  onRunningChange?: (running: boolean) => void
  /** Streams the currently-featured live game to the board viewer (null = none). */
  onLiveUpdate?: (live: LiveGame | null) => void
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
      }
    } catch { /* ignore corrupt config */ }
    restored.current = true
  }, [])
  useEffect(() => {
    if (!restored.current) return // don't clobber saved config before restore runs
    const c = { engineA, engineB, mode, minEval, maxEval, nGames, concurrency, tcId, customBaseS, customIncS, adjudicateTb }
    try { localStorage.setItem("chessgui-tournament-config", JSON.stringify(c)) } catch { /* ignore */ }
  }, [engineA, engineB, mode, minEval, maxEval, nGames, concurrency, tcId, customBaseS, customIncS, adjudicateTb])

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
      setTally({ completed: 0, total, engineA: 0, engineB: 0, draw: 0, errors: 0 })

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
      const liveById = new Map<number, LiveGame>()
      const completed = new Set<number>()
      let featuredId: number | null = null

      // Move stream: one event per move per game. We "feature" a single game at
      // a time and only switch once it finishes.
      const moveChannel = new Channel<MoveEvent>()
      moveChannel.onmessage = (m: MoveEvent) => {
        const meta = specMeta.get(m.game_id)
        if (!meta) return
        const g: LiveGame = {
          gameId: m.game_id,
          ply: m.ply,
          fen: m.fen,
          lastMove: uciSquares(m.uci),
          whiteLabel: meta.whiteLabel,
          blackLabel: meta.blackLabel,
          whiteTimeMs: m.wtime_ms,
          blackTimeMs: m.btime_ms,
        }
        liveById.set(m.game_id, g)
        if (featuredId === null || completed.has(featuredId)) featuredId = m.game_id
        if (m.game_id === featuredId) onLiveUpdate?.(g)
      }

      // Live progress channel. The backend sends one BatchProgress per game.
      const channel = new Channel<BatchProgress>()
      channel.onmessage = (p: BatchProgress) => {
        completed.add(p.last.id)
        // If the featured game just finished, jump to another in-flight game.
        if (featuredId !== null && completed.has(featuredId)) {
          const next = [...liveById.keys()].reverse().find((id) => !completed.has(id))
          if (next !== undefined) {
            featuredId = next
            const g = liveById.get(next)
            if (g) onLiveUpdate?.(g)
          }
        }
        setTally((prev) => {
          const base =
            prev ?? { completed: 0, total, engineA: 0, engineB: 0, draw: 0, errors: 0 }
          const r = (p.last.result as { Ok?: { result: string } }).Ok
          let { engineA: aWins, engineB: bWins, draw, errors } = base
          if (!r) {
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
          }
        })
      }

      // Param names MUST match the Rust command: specs, concurrency, onProgress, onMove.
      const result = await invoke<BatchReport>("play_batch", {
        specs: specs as GameSpec[],
        concurrency: concurrencyNum,
        onProgress: channel,
        onMove: moveChannel,
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
  }, [engineA, engineB, mode, minEval, maxEval, nGames, tcId, customBaseS, customIncS, concurrency, adjudicateTb, currentFen, engineASide, onLiveUpdate])

  const cancel = useCallback(async () => {
    try {
      await invoke("cancel_batch")
    } catch (e) {
      setError(String(e))
    }
  }, [])

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
  let games = 0, aWins = 0, bWins = 0, draws = 0, errors = 0
  const terms: Record<string, number> = {}
  for (const o of outcomes) {
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

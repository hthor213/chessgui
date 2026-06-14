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
  eloDelta,
  gameResult,
  uciSquares,
  type BatchProgress,
  type BatchReport,
  type GameOutcome,
  type GameSpec,
  type LiveGame,
  type MoveEvent,
  type EvalMap,
  type ProbBin,
  type StartMode,
  type TaggedPosition,
} from "@/lib/tournament"

const STOCKFISH_DEFAULT = "/opt/homebrew/bin/stockfish"
const RECKLESS_DEFAULT =
  "/Users/hjalti/Documents/GitHub/chessgui/engines/reckless"

const MAX_PLIES = 400

type RunningTally = {
  completed: number
  total: number
  engineA: number
  engineB: number
  draw: number
  errors: number
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
}: {
  /** Reports whether a batch is currently running (for the header View toggle). */
  onRunningChange?: (running: boolean) => void
  /** Streams the currently-featured live game to the board viewer (null = none). */
  onLiveUpdate?: (live: LiveGame | null) => void
} = {}) {
  const [engineA, setEngineA] = useState(STOCKFISH_DEFAULT)
  const [engineB, setEngineB] = useState(RECKLESS_DEFAULT)
  const [mode, setMode] = useState<StartMode>("normal")
  // Numeric fields are held as raw strings so they stay freely editable
  // (clearing/retyping); they are coerced to numbers with fallbacks in run().
  const [minEval, setMinEval] = useState("-2")
  const [maxEval, setMaxEval] = useState("2")
  const [nGames, setNGames] = useState("100")
  const [movetimeMs, setMovetimeMs] = useState("100")
  const [concurrency, setConcurrency] = useState("0")

  const [running, setRunning] = useState(false)
  const [tally, setTally] = useState<RunningTally | null>(null)
  const [report, setReport] = useState<BatchReport | null>(null)
  const [probBins, setProbBins] = useState<ProbBin[]>([])
  const [error, setError] = useState<string | null>(null)

  // The id -> eval side-table for the current run, used to bucket results.
  const evalByIdRef = useRef<EvalMap>(new Map())

  // Keep parent informed of run state; clear the live board when a run ends.
  useEffect(() => {
    onRunningChange?.(running)
    if (!running) onLiveUpdate?.(null)
  }, [running, onRunningChange, onLiveUpdate])

  const run = useCallback(async () => {
    setError(null)
    setReport(null)
    setProbBins([])
    setRunning(true)

    try {
      // Coerce the free-text numeric fields with sensible fallbacks/clamps.
      const nGamesNum = Math.max(2, Math.min(500, Math.round(Number(nGames) || 100)))
      const movetimeNum = Math.max(1, Math.round(Number(movetimeMs) || 100))
      const concurrencyNum = Math.max(0, Math.round(Number(concurrency) || 0))
      const minEvalNum = Number.isFinite(Number(minEval)) ? Number(minEval) : -2
      const maxEvalNum = Number.isFinite(Number(maxEval)) ? Number(maxEval) : 2
      const lo = Math.min(minEvalNum, maxEvalNum)
      const hi = Math.max(minEvalNum, maxEvalNum)

      const positions = await loadPositions()
      const nSeeds = seedsForGames(nGamesNum)
      const seeds = buildSeeds(mode, nSeeds, positions, lo, hi)
      const { specs, evalById } = buildSpecs(
        seeds,
        engineA,
        engineB,
        movetimeNum,
        MAX_PLIES,
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
      setProbBins(
        buildProbabilityMap(
          result.outcomes,
          evalByIdRef.current,
          lo,
          hi,
        ),
      )
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }, [engineA, engineB, mode, minEval, maxEval, nGames, movetimeMs, concurrency])

  const cancel = useCallback(async () => {
    try {
      await invoke("cancel_batch")
    } catch (e) {
      setError(String(e))
    }
  }, [])

  const pct = tally && tally.total > 0 ? (tally.completed / tally.total) * 100 : 0

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
              ] as [StartMode, string][]
            ).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
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

          {mode === "eval" && (
            <div className="flex flex-wrap gap-4">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Min eval (pawns)</span>
                <input
                  type="number"
                  step="0.25"
                  className="w-28 bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
                  value={minEval}
                  onChange={(e) => setMinEval(e.target.value)}
                  disabled={running}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Max eval (pawns)</span>
                <input
                  type="number"
                  step="0.25"
                  className="w-28 bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
                  value={maxEval}
                  onChange={(e) => setMaxEval(e.target.value)}
                  disabled={running}
                />
              </label>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Games (max 500, 2 per opening)
              </span>
              <input
                type="number"
                min={2}
                max={500}
                className="bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
                value={nGames}
                onChange={(e) => setNGames(e.target.value)}
                disabled={running}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Movetime per move (ms)</span>
              <input
                type="number"
                min={1}
                className="bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
                value={movetimeMs}
                onChange={(e) => setMovetimeMs(e.target.value)}
                disabled={running}
              />
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

        {/* Probability map */}
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
  for (const o of outcomes) {
    games += 1
    const r = gameResult(o)
    if (!r) { errors += 1; continue }
    if (r.result === "1/2-1/2") { draws += 1; continue }
    const aIsWhite = !o.flipped
    if ((r.result === "1-0") === aIsWhite) aWins += 1
    else bWins += 1
  }
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
    </section>
  )
}

function ProbabilityMap({ bins }: { bins: ProbBin[] }) {
  return (
    <section className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">
          Conversion probability map
        </h2>
        {/* Legend */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-green-500" />
            White win
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-gray-500" />
            Draw
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-red-500" />
            Black win
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full bg-white" />
            avg White score
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Each bar is one ~0.25-pawn starting-eval bin (White-POV). Stacks show
        how the advantaged (White) side fared; the dot marks the mean White
        score = how often that advantage converted.
      </p>

      {/* Bars */}
      <div className="flex items-end gap-1 h-56">
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

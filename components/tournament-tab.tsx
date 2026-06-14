"use client"

import { useCallback, useRef, useState } from "react"
import { invoke, Channel } from "@tauri-apps/api/core"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  buildSeeds,
  buildSpecs,
  seedsForGames,
  buildProbabilityMap,
  type BatchProgress,
  type BatchReport,
  type BatchSummary,
  type GameSpec,
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
  white: number
  black: number
  draw: number
  errors: number
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

export function TournamentTab() {
  const [engineA, setEngineA] = useState(STOCKFISH_DEFAULT)
  const [engineB, setEngineB] = useState(RECKLESS_DEFAULT)
  const [mode, setMode] = useState<StartMode>("normal")
  const [minEval, setMinEval] = useState(-2)
  const [maxEval, setMaxEval] = useState(2)
  const [nGames, setNGames] = useState(100)
  const [movetimeMs, setMovetimeMs] = useState(100)
  const [concurrency, setConcurrency] = useState(0)

  const [running, setRunning] = useState(false)
  const [tally, setTally] = useState<RunningTally | null>(null)
  const [report, setReport] = useState<BatchReport | null>(null)
  const [probBins, setProbBins] = useState<ProbBin[]>([])
  const [error, setError] = useState<string | null>(null)

  // The id -> eval side-table for the current run, used to bucket results.
  const evalByIdRef = useRef<EvalMap>(new Map())

  const run = useCallback(async () => {
    setError(null)
    setReport(null)
    setProbBins([])
    setRunning(true)

    try {
      const positions = await loadPositions()
      const nSeeds = seedsForGames(nGames)
      const seeds = buildSeeds(mode, nSeeds, positions, minEval, maxEval)
      const { specs, evalById } = buildSpecs(
        seeds,
        engineA,
        engineB,
        movetimeMs,
        MAX_PLIES,
      )
      evalByIdRef.current = evalById

      const total = specs.length
      setTally({ completed: 0, total, white: 0, black: 0, draw: 0, errors: 0 })

      // Live progress channel. The backend sends one BatchProgress per game.
      const channel = new Channel<BatchProgress>()
      channel.onmessage = (p: BatchProgress) => {
        setTally((prev) => {
          const base =
            prev ?? { completed: 0, total, white: 0, black: 0, draw: 0, errors: 0 }
          const r = (p.last.result as { Ok?: { result: string } }).Ok
          let { white, black, draw, errors } = base
          if (!r) {
            errors += 1
          } else if (r.result === "1-0") {
            white += 1
          } else if (r.result === "0-1") {
            black += 1
          } else {
            draw += 1
          }
          return {
            completed: p.completed,
            total: p.total,
            white,
            black,
            draw,
            errors,
          }
        })
      }

      // Param names MUST match the Rust command: specs, concurrency, onProgress.
      const result = await invoke<BatchReport>("play_batch", {
        specs: specs as GameSpec[],
        concurrency,
        onProgress: channel,
      })

      setReport(result)
      setProbBins(
        buildProbabilityMap(
          result.outcomes,
          evalByIdRef.current,
          minEval,
          maxEval,
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
                  onChange={(e) => setMinEval(Number(e.target.value))}
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
                  onChange={(e) => setMaxEval(Number(e.target.value))}
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
                onChange={(e) =>
                  setNGames(Math.max(2, Math.min(500, Number(e.target.value) || 0)))
                }
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
                onChange={(e) => setMovetimeMs(Math.max(1, Number(e.target.value) || 0))}
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
                onChange={(e) => setConcurrency(Math.max(0, Number(e.target.value) || 0))}
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
              <span className="text-green-400">White wins: {tally.white}</span>
              <span className="text-muted-foreground">Draws: {tally.draw}</span>
              <span className="text-red-400">Black wins: {tally.black}</span>
              {tally.errors > 0 && (
                <span className="text-amber-400">Errors: {tally.errors}</span>
              )}
            </div>
          </section>
        )}

        {/* Final summary */}
        {report && <SummaryCard summary={report.summary} />}

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

function SummaryCard({ summary }: { summary: BatchSummary }) {
  const items: [string, number, string][] = [
    ["Games", summary.games, "text-foreground"],
    ["White wins", summary.white_wins, "text-green-400"],
    ["Black wins", summary.black_wins, "text-red-400"],
    ["Draws", summary.draws, "text-muted-foreground"],
    ["Errors", summary.errors, "text-amber-400"],
  ]
  return (
    <section className="bg-secondary/40 border border-white/10 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-foreground mb-3">Summary</h2>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {items.map(([label, value, color]) => (
          <div key={label} className="flex flex-col">
            <span className={`text-2xl font-bold font-mono ${color}`}>{value}</span>
            <span className="text-xs text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>
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

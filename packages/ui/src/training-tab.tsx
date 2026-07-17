"use client"

// Training tab — the curriculum engine (spec 215, Tier 0).
//
// Renders the bundled generic "Road to 1900" program plus a LOCAL overlay
// (personal milestone name/date + rival label) loaded from localStorage. Two
// sub-views, both kept mounted (visibility toggled) so the whole surface is
// drivable in one server-render:
//   • Today   — the current chapter's blocks for today's weekday, each a launch
//               action (into Learn features that exist) + a per-date check-off.
//   • Program — chapter timeline (current highlighted), objectives, exit criteria
//               as gauges, and manual metrics entry driving them.
// A milestone card carries the countdown + honest gap-to-target.
//
// Persistence is localStorage (client-only, guarded), mirroring calibration-tab.
// Migration path: a native training_metrics file can replace the metrics key
// later; the shapes are already dated append-only points.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@chessgui/ui/ui/button"
import { Input } from "@chessgui/ui/ui/input"
import { getProviders } from "@/lib/platform"
import {
  ROAD_TO_1900,
  METRIC_META,
  METRIC_KEYS,
  DEFAULT_METRICS,
  STORAGE_KEYS,
  MILESTONE_MAIA_TARGET,
  currentWeek,
  chapterForWeek,
  blocksForDay,
  latestMetric,
  appendMetric,
  gaugeFor,
  formatCriterion,
  daysRemaining,
  gapToTarget,
  type Chapter,
  type DayBlock,
  type ExitCriterion,
  type Gauge,
  type MetricKey,
  type MetricPoint,
  type Program,
  type TrainingOverlay,
} from "@/lib/training-program"
import { buildBeatPlan, beatTargetFor, traineeFromMetrics } from "@/lib/beat-program"
import { gatePersonaLevel, loadLocalRivalPersonas, loadPlayerProfiles } from "@/lib/roster"
import {
  appendLogLine,
  egConversionPoint,
  MEASURE_USER_KEY,
  measureRunMessage,
  mergeMetricPoints,
  parseMeasurementJson,
  sparScorePoint,
  stageForLine,
} from "@/lib/training-measure"
import { projectMetric, winsPerTen, type Projection } from "@/lib/training-projection"
import {
  ANOMALY_LABELS,
  loadSparResults,
  persistSparResults,
  setCountsToward,
  sparScore,
  SPAR_SCORE_WINDOW_DAYS,
  type SparResultEntry,
} from "@/lib/spar-results"
import {
  EG_CONVERSION_WINDOW_DAYS,
  egConversion,
  loadPlayoutResults,
  persistPlayoutResults,
  pickTrainingPlayout,
  setPlayoutCountsToward,
  VERDICT_LABELS,
  type PlayoutRequest,
  type PlayoutResultEntry,
} from "@/lib/playout"
import { PlayoutScreen } from "@chessgui/ui/playout-screen"
import { bandForRating, DEFAULT_DECK_SIZE, type DeckRequest } from "@/lib/puzzles"
import { PuzzlesTab } from "@chessgui/ui/puzzles-tab"

/** Which Learn feature a block launches into, when one exists today. */
export type LearnLaunch = "calibrate" | "spar"

interface TrainingTabProps {
  /** Jump to a Learn sibling sub-tab (calibration / spar) — the launch action
   *  for the exercise types that already have a feature. */
  onLaunch: (sub: LearnLaunch) => void
  /** Seed the visible sub-view (testability seam; defaults to Today). */
  initialView?: "today" | "program"
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/** Local calendar date as YYYY-MM-DD (the check-off log key). */
function localISODate(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** Local year-month as YYYY-MM (the metrics measurement label). */
function localMonth(d: Date = new Date()): string {
  return localISODate(d).slice(0, 7)
}

type LogByDate = Record<string, Record<string, boolean>>

export function TrainingTab({ onLaunch, initialView = "today" }: TrainingTabProps) {
  const [view, setView] = useState<"today" | "program">(initialView)
  // Beat-X programs (spec 225): derived LIVE from the local profile artifacts
  // (data/rivals via the rival_profiles command) — one per pipeline-built
  // profile, next to the bundled generic program. Derived, not stored, so
  // the picker always matches what exists on disk; [] everywhere profiles
  // can't exist (browser shells), leaving the bundled program alone.
  const [beatPrograms, setBeatPrograms] = useState<Program[]>([])
  const [activeProgramId, setActiveProgramId] = useState<string>(ROAD_TO_1900.id!)
  // All programs share the start date / check-off log / metrics store —
  // switching programs re-frames the same calendar, it doesn't reset it.
  const program = useMemo(
    () => beatPrograms.find((p) => p.id === activeProgramId) ?? ROAD_TO_1900,
    [beatPrograms, activeProgramId],
  )

  // Persisted state. Metrics seed to the baseline so gauges render before the
  // client effect runs (and under server-render). start/overlay hydrate on mount.
  const [startISO, setStartISO] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<TrainingOverlay | null>(null)
  const [log, setLog] = useState<LogByDate>({})
  const [metrics, setMetrics] = useState<MetricPoint[]>(DEFAULT_METRICS)
  // Locally recorded spar games (written by the spar screen via
  // hooks/use-spar-results) — read here for the spar-score refresh and the
  // per-game counts-toward-training reclassification (spec 215 Tier 1).
  const [sparResults, setSparResults] = useState<SparResultEntry[]>([])
  // Locally recorded playout verdicts (written by the playout screen via
  // hooks/use-playout-recorder) — read here for the eg_conversion refresh and
  // the per-game counts-toward-training reclassification (spec 215 Tier 1).
  const [playoutResults, setPlayoutResults] = useState<PlayoutResultEntry[]>([])
  const [now] = useState(() => Date.now())
  // Monthly measurement run (spec 215 Tier 2 spawn). Held HERE, not in the
  // panel, so a launched playout/rake deck (which swaps the tab's content)
  // can't drop an in-flight run's log and handlers.
  const [canSpawnMeasure, setCanSpawnMeasure] = useState(false)
  const [measureUser, setMeasureUser] = useState("")
  const [measureRunning, setMeasureRunning] = useState(false)
  const [measureStage, setMeasureStage] = useState<string | null>(null)
  const [measureLog, setMeasureLog] = useState<string[]>([])

  // Hydrate from storage once, on the client.
  useEffect(() => {
    const storage = getProviders().storage
    let loadedMetrics: MetricPoint[] = DEFAULT_METRICS
    try {
      const s = storage.get(STORAGE_KEYS.start)
      if (s) setStartISO(s)
      const ov = storage.get(STORAGE_KEYS.overlay)
      if (ov) setOverlay(JSON.parse(ov) as TrainingOverlay)
      const lg = storage.get(STORAGE_KEYS.log)
      if (lg) setLog(JSON.parse(lg) as LogByDate)
      const mx = storage.get(STORAGE_KEYS.metrics)
      if (mx) {
        const parsed = JSON.parse(mx) as MetricPoint[]
        if (Array.isArray(parsed) && parsed.length > 0) {
          loadedMetrics = parsed
          setMetrics(parsed)
        }
      }
    } catch {
      /* malformed storage — fall back to defaults already in state */
    }
    setSparResults(loadSparResults())
    setPlayoutResults(loadPlayoutResults())
    setMeasureUser(storage.get(MEASURE_USER_KEY) ?? "")
    // Spawn capability, read on the client so the static render stays stable
    // (the browser/web shells keep the terminal-run + import path instead).
    setCanSpawnMeasure(getProviders().engine.hasNativeEngine)
    // Beat-X programs (spec 225): one per local pipeline profile, generated
    // from the same artifacts the roster gates on. hasPersona follows the
    // artifact-existence rule (a config actually loaded), and its level is
    // the same honesty-gated band the spar roster uses.
    const savedProgram = storage.get(STORAGE_KEYS.activeProgram)
    // Rating-gap honesty (spec 225): the trainee's last MEASURED maia_rapid
    // frames each program's goal — "beat" never quietly promises parity.
    const trainee = traineeFromMetrics(loadedMetrics)
    Promise.all([loadPlayerProfiles(), loadLocalRivalPersonas()]).then(([profiles, rivals]) => {
      const programs = profiles.map((p) => {
        const rp = rivals.find((r) => r.config.slug === p.profile.slug)
        return buildBeatPlan(
          beatTargetFor(p, {
            hasPersona: !!rp,
            personaLevel: rp ? gatePersonaLevel(rp.config).level : undefined,
            book: rp?.book ?? null,
            trainee,
          }),
        ).program
      })
      setBeatPrograms(programs)
      if (savedProgram && programs.some((p) => p.id === savedProgram)) {
        setActiveProgramId(savedProgram)
      }
    })
  }, [])

  const write = useCallback((key: string, value: unknown) => {
    // Storage unavailable — state still lives in memory.
    getProviders().storage.set(key, JSON.stringify(value))
  }, [])

  const startProgram = useCallback(() => {
    const iso = localISODate()
    setStartISO(iso)
    getProviders().storage.set(STORAGE_KEYS.start, iso)
  }, [])

  const saveOverlay = useCallback(
    (ov: TrainingOverlay) => {
      setOverlay(ov)
      write(STORAGE_KEYS.overlay, ov)
    },
    [write],
  )

  const todayISO = localISODate(new Date(now))
  const jsDay = new Date(now).getDay()

  const week = startISO ? currentWeek(startISO, now) : null
  const chapter: Chapter = useMemo(
    () => (week ? chapterForWeek(program, week) : program.chapters[0]),
    [program, week],
  )
  const todayBlocks = useMemo(() => blocksForDay(chapter, jsDay), [chapter, jsDay])

  const toggleCheck = useCallback(
    (blockId: string) => {
      setLog((prev) => {
        const forDate = { ...(prev[todayISO] ?? {}) }
        forDate[blockId] = !forDate[blockId]
        const next = { ...prev, [todayISO]: forDate }
        write(STORAGE_KEYS.log, next)
        return next
      })
    },
    [todayISO, write],
  )

  const addMetric = useCallback(
    (point: MetricPoint) => {
      setMetrics((prev) => {
        const next = appendMetric(prev, point)
        write(STORAGE_KEYS.metrics, next)
        return next
      })
    },
    [write],
  )

  // Merge points keyed by (at, metric) — refreshes and file imports are
  // idempotent, unlike the manual appendMetric entry above.
  const [measureMsg, setMeasureMsg] = useState<string | null>(null)
  const mergePoints = useCallback(
    (points: MetricPoint[]) => {
      const res = mergeMetricPoints(metrics, points)
      setMetrics(res.merged)
      write(STORAGE_KEYS.metrics, res.merged)
      return res
    },
    [metrics, write],
  )

  // In-app refresh: recompute this month's spar score from the stored games.
  const refreshSparScore = useCallback(() => {
    const results = loadSparResults() // re-read: the spar screen appends independently
    setSparResults(results)
    const point = sparScorePoint(results)
    if (!point) {
      setMeasureMsg(
        `No counting spar games in the last ${SPAR_SCORE_WINDOW_DAYS} days — play a serious game first.`,
      )
      return
    }
    mergePoints([point])
    setMeasureMsg(`Spar score refreshed: ${METRIC_META.spar_score.format(point.value)} (${point.note}).`)
  }, [mergePoints])

  // In-app refresh: recompute this month's endgame conversion from the stored
  // playout verdicts (spec 215: playouts now carry declared intent, so the
  // in-app rate is honest to feed the panel).
  const refreshEgConversion = useCallback(() => {
    const results = loadPlayoutResults() // re-read: the playout screen appends independently
    setPlayoutResults(results)
    const point = egConversionPoint(results)
    if (!point) {
      setMeasureMsg(
        `No counting win-claim playouts in the last ${EG_CONVERSION_WINDOW_DAYS} days — play one out first.`,
      )
      return
    }
    mergePoints([point])
    setMeasureMsg(
      `Endgame conversion refreshed: ${METRIC_META.eg_conversion.format(point.value)} (${point.note}).`,
    )
  }, [mergePoints])

  // Script-produced measurement file import (scripts/measure_monthly.py →
  // data/rivals/training_metrics.json) — the Tier-2 monthly path.
  const importMeasurementText = useCallback(
    (text: string) => {
      try {
        const points = parseMeasurementJson(text)
        const res = mergePoints(points)
        setMeasureMsg(
          `Imported ${points.length} point${points.length === 1 ? "" : "s"}: ${res.added} new, ${res.replaced} updated, ${res.unchanged} unchanged.`,
        )
      } catch (e) {
        setMeasureMsg(`Import failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [mergePoints],
  )

  // Spawn the monthly pipeline in place (desktop dev checkout only), streaming
  // its output into the run log. A successful run's metrics file goes through
  // the SAME import path as the manual button — one merge rule, one message.
  const runMeasurement = useCallback(
    (opts: { skipFetch: boolean; skipMaia: boolean }) => {
      const user = measureUser.trim()
      if (!user || measureRunning) return
      setMeasureRunning(true)
      setMeasureStage("Starting pipeline…")
      setMeasureLog([])
      setMeasureMsg(null)
      getProviders().storage.set(MEASURE_USER_KEY, user)
      getProviders()
        .engine.measureMonthlyRun({ user, skipFetch: opts.skipFetch, skipMaia: opts.skipMaia }, (l) => {
          setMeasureLog((prev) => appendLogLine(prev, l.line))
          const stage = stageForLine(l.line)
          if (stage) setMeasureStage(stage)
        })
        .then((report) => {
          const msg = measureRunMessage(report)
          if (msg) setMeasureMsg(msg)
          else importMeasurementText(report.metrics_json ?? "")
        })
        .catch((e) => {
          setMeasureMsg(`Measurement run failed: ${e instanceof Error ? e.message : String(e)}`)
        })
        .finally(() => {
          setMeasureRunning(false)
          setMeasureStage(null)
        })
    },
    [measureUser, measureRunning, importMeasurementText],
  )

  // Cancel kills the pipeline's whole process group (orchestrator + the
  // running stage child); the run promise then resolves cancelled=true.
  const cancelMeasurement = useCallback(() => {
    getProviders()
      .engine.measureMonthlyCancel()
      .catch((e) => setMeasureMsg(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`))
  }, [])

  // Reclassify one spar game's counts-toward-training intent (flag, never
  // silently drop — the user decides, and probe can never be flipped on).
  const reclassifySpar = useCallback((id: string, counts: boolean) => {
    setSparResults((prev) => {
      const next = setCountsToward(prev, id, counts)
      persistSparResults(next)
      return next
    })
  }, [])

  // Same contract for playout verdicts (probe can never be flipped on).
  const reclassifyPlayout = useCallback((id: string, counts: boolean) => {
    setPlayoutResults((prev) => {
      const next = setPlayoutCountsToward(prev, id, counts)
      persistPlayoutResults(next)
      return next
    })
  }, [])

  const latestMaia = latestMetric(metrics, "maia_rapid")
  const rivalLabel = overlay?.rivalLabel?.trim() || "your rival"
  const checkedToday = log[todayISO] ?? {}

  // endgame_playout launch (spec 215 Tier 1, unblocked by spec 211
  // play-it-out): a curated conversion position handed to the playout screen.
  // While set, the playout replaces the tab's content; everything else stays
  // mounted in state, so exiting lands back on Today with check-offs intact.
  const [playout, setPlayout] = useState<PlayoutRequest | null>(null)
  const launchPlayout = useCallback(() => setPlayout(pickTrainingPlayout()), [])

  // rake_deck launch (spec 215 Tier 1, unblocked by the spec 211 solver): an
  // Avoidance deck drawn from the user's band — the latest Maia-rapid
  // measurement mapped to the generator's 100-Elo bands (null = all bands
  // until a measurement exists). Same replace-the-tab pattern as playout.
  const [rakeDeck, setRakeDeck] = useState<DeckRequest | null>(null)
  const launchRakeDeck = useCallback(
    () =>
      setRakeDeck({
        band: bandForRating(latestMetric(metrics, "maia_rapid")?.value ?? null),
        count: DEFAULT_DECK_SIZE,
      }),
    [metrics],
  )

  if (playout) {
    return (
      <div className="h-full flex flex-col text-foreground" data-testid="training-tab">
        <PlayoutScreen
          request={playout}
          onExit={() => {
            setPlayout(null)
            // Pick up whatever the playout recorder just stored.
            setPlayoutResults(loadPlayoutResults())
          }}
        />
      </div>
    )
  }

  if (rakeDeck) {
    return (
      <div className="h-full flex flex-col text-foreground" data-testid="training-tab">
        <PuzzlesTab initialDeck={rakeDeck} onExit={() => setRakeDeck(null)} />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col text-foreground" data-testid="training-tab">
      {/* Sub-nav */}
      <div className="px-6 pt-3 flex items-center gap-1 border-b border-white/10">
        <SubNavButton id="training-sub-today" active={view === "today"} onClick={() => setView("today")}>
          Today
        </SubNavButton>
        <SubNavButton id="training-sub-program" active={view === "program"} onClick={() => setView("program")}>
          Program
        </SubNavButton>
        {beatPrograms.length > 0 && (
          // Program picker (spec 225): the bundled program plus one Beat-X
          // program per local profile. Names come from LOCAL artifacts at
          // runtime — committed code stays generic.
          <select
            value={activeProgramId}
            onChange={(e) => {
              setActiveProgramId(e.target.value)
              getProviders().storage.set(STORAGE_KEYS.activeProgram, e.target.value)
            }}
            data-testid="training-program-picker"
            className="ml-3 self-center bg-background border border-input rounded-md px-2 py-1 text-xs text-foreground"
          >
            <option value={ROAD_TO_1900.id}>{ROAD_TO_1900.name}</option>
            {beatPrograms.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <span className="ml-auto text-xs text-muted-foreground self-center">
          {program.name}
          {week != null && (
            <>
              {" · "}
              <span className="text-foreground">Week {week}</span> · {chapter.title}
            </>
          )}
        </span>
      </div>

      {/* Today */}
      <div
        data-testid="training-today"
        className="flex-1 min-h-0 overflow-auto"
        style={view === "today" ? undefined : { display: "none" }}
      >
        <div className="max-w-3xl mx-auto p-6 space-y-5">
          <MilestoneCard
            overlay={overlay}
            latestMaia={latestMaia}
            now={now}
            onSaveOverlay={saveOverlay}
          />

          <TrajectoryCard metrics={metrics} overlay={overlay} rivalLabel={rivalLabel} />

          {startISO == null ? (
            <StartCard onStart={startProgram} rivalLabel={rivalLabel} programName={program.name} />
          ) : (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <h2 className="text-lg font-bold">
                  {DAY_NAMES[jsDay]}
                  <span className="text-muted-foreground font-normal text-sm"> · {chapter.title}</span>
                </h2>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {countChecked(todayBlocks, checkedToday)}/{todayBlocks.length} done
                </span>
              </div>
              {todayBlocks.map((b) => (
                <TodayBlock
                  key={b.id}
                  block={b}
                  checked={!!checkedToday[b.id]}
                  onToggle={() => toggleCheck(b.id)}
                  onLaunch={onLaunch}
                  onPlayout={launchPlayout}
                  onRakeDeck={launchRakeDeck}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Program */}
      <div
        data-testid="training-program"
        className="flex-1 min-h-0 overflow-auto"
        style={view === "program" ? undefined : { display: "none" }}
      >
        <div className="max-w-4xl mx-auto p-6 space-y-6">
          <div>
            <h1 className="text-2xl font-bold">{program.name}</h1>
            <p className="text-muted-foreground mt-1 text-sm">{program.goal}</p>
          </div>

          <div className="space-y-4">
            {program.chapters.map((ch) => (
              <ChapterCard
                key={ch.id}
                chapter={ch}
                current={week != null && ch.id === chapter.id}
                metrics={metrics}
              />
            ))}
          </div>

          <MetricsPanel
            metrics={metrics}
            onAdd={addMetric}
            onRefreshSpar={refreshSparScore}
            onRefreshEg={refreshEgConversion}
            onImportText={importMeasurementText}
            measureMsg={measureMsg}
            run={{
              canSpawn: canSpawnMeasure,
              user: measureUser,
              onUserChange: setMeasureUser,
              running: measureRunning,
              stage: measureStage,
              log: measureLog,
              onRun: runMeasurement,
              onCancel: cancelMeasurement,
            }}
          />

          <SparGamesCard results={sparResults} onReclassify={reclassifySpar} now={now} />

          <PlayoutGamesCard results={playoutResults} onReclassify={reclassifyPlayout} now={now} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

function countChecked(blocks: DayBlock[], checked: Record<string, boolean>): number {
  return blocks.reduce((n, b) => n + (checked[b.id] ? 1 : 0), 0)
}

/** One exercise block: a launch action where the feature exists, plus a check-off
 *  that persists per date. Non-launchable types are check-off-only with their
 *  one-line instruction. */
function TodayBlock({
  block,
  checked,
  onToggle,
  onLaunch,
  onPlayout,
  onRakeDeck,
}: {
  block: DayBlock
  checked: boolean
  onToggle: () => void
  onLaunch: (sub: LearnLaunch) => void
  /** endgame_playout blocks launch the Play-it-out screen (spec 215 Tier 1). */
  onPlayout: () => void
  /** rake_deck blocks launch an Avoidance deck session (spec 211 solver). */
  onRakeDeck: () => void
}) {
  const launch =
    block.type === "calibration_session"
      ? { action: () => onLaunch("calibrate"), label: "Open calibration" }
      : block.type === "spar_rival"
        ? { action: () => onLaunch("spar"), label: "Open Spar" }
        : block.type === "endgame_playout"
          ? { action: onPlayout, label: "Play it out" }
          : block.type === "rake_deck"
            ? { action: onRakeDeck, label: "Start rake deck" }
            : null
  return (
    <div
      data-testid={`training-block-${block.id}`}
      className={`rounded-lg border p-4 transition-colors ${
        checked ? "border-emerald-500/30 bg-emerald-500/[0.06]" : "border-white/10 bg-white/[0.03]"
      }`}
    >
      <div className="flex items-start gap-3">
        <button
          data-testid={`training-checkoff-${block.id}`}
          onClick={onToggle}
          aria-pressed={checked}
          title={checked ? "Mark not done" : "Mark done"}
          className={`mt-0.5 h-5 w-5 shrink-0 rounded border flex items-center justify-center text-xs ${
            checked
              ? "border-emerald-500 bg-emerald-500 text-black"
              : "border-white/25 text-transparent hover:border-white/50"
          }`}
        >
          ✓
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={`font-medium ${checked ? "line-through text-muted-foreground" : ""}`}>
              {block.title}
            </span>
            {block.minutes != null && (
              <span className="text-xs text-muted-foreground tabular-nums">{block.minutes}m</span>
            )}
            {!launch && block.type !== "rest" && (
              <span className="text-[11px] text-muted-foreground/70 rounded bg-white/5 px-1.5 py-0.5">
                check-off
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">{block.detail}</p>
        </div>
        {launch && (
          <Button
            size="sm"
            variant="outline"
            data-testid={`training-launch-${block.id}`}
            onClick={launch.action}
            className="shrink-0"
          >
            {launch.label}
          </Button>
        )}
      </div>
    </div>
  )
}

function StartCard({
  onStart,
  rivalLabel,
  programName,
}: {
  onStart: () => void
  rivalLabel: string
  programName: string
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-center space-y-3">
      <h2 className="text-lg font-bold">Start the program</h2>
      <p className="text-sm text-muted-foreground">
        Set today as day one. The weekly template then shows you what to train against {rivalLabel}, by
        weekday, with the features that exist wired to launch.
      </p>
      <Button onClick={onStart} data-testid="training-start" size="lg">
        Start {programName}
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Milestone card
// ---------------------------------------------------------------------------

function MilestoneCard({
  overlay,
  latestMaia,
  now,
  onSaveOverlay,
}: {
  overlay: TrainingOverlay | null
  latestMaia: MetricPoint | null
  now: number
  onSaveOverlay: (ov: TrainingOverlay) => void
}) {
  const [editing, setEditing] = useState(false)
  const days = daysRemaining(overlay?.milestoneDate ?? null, now)
  const maiaVal = latestMaia?.value ?? null
  const gap = gapToTarget(maiaVal)

  return (
    <div
      data-testid="training-milestone"
      className="rounded-lg border border-amber-500/20 bg-amber-500/[0.05] p-4"
    >
      {editing || !overlay ? (
        <OverlayForm
          overlay={overlay}
          onCancel={overlay ? () => setEditing(false) : undefined}
          onSave={(ov) => {
            onSaveOverlay(ov)
            setEditing(false)
          }}
        />
      ) : (
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-amber-300/80">Milestone</div>
              <div className="text-lg font-bold">{overlay.milestoneName}</div>
            </div>
            <button
              onClick={() => setEditing(true)}
              className="text-xs text-muted-foreground hover:text-foreground"
              data-testid="training-milestone-edit"
            >
              Edit
            </button>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <span className="tabular-nums">
              {days == null ? (
                <span className="text-muted-foreground">no date set</span>
              ) : days >= 0 ? (
                <>
                  <span className="text-2xl font-bold text-amber-200">{days}</span>{" "}
                  <span className="text-muted-foreground">days remaining</span>
                </>
              ) : (
                <span className="text-muted-foreground">{-days} days past</span>
              )}
            </span>
            <span className="text-muted-foreground">
              Maia rapid{" "}
              {maiaVal == null ? (
                <span className="italic">not yet measured</span>
              ) : (
                <span className="text-foreground tabular-nums">{METRIC_META.maia_rapid.format(maiaVal)}</span>
              )}
            </span>
          </div>
          <p className="text-sm text-muted-foreground" data-testid="training-milestone-status">
            {milestoneStatus(days, maiaVal, gap, overlay.rivalLabel)}
          </p>
        </div>
      )}
    </div>
  )
}

/** Honest one-liner — the MEASURED gap; the projection lives in the
 *  trajectory card below and is labeled as a projection there. */
function milestoneStatus(
  days: number | null,
  maiaVal: number | null,
  gap: number | null,
  rivalLabel: string,
): string {
  const rival = rivalLabel.trim() || "your rival"
  if (maiaVal == null) {
    return `Enter a Maia-rapid measurement to see your gap to the ${MILESTONE_MAIA_TARGET} target for ${rival}.`
  }
  if (gap != null && gap <= 0) {
    return `You're at or past the ${MILESTONE_MAIA_TARGET} target — keep the level up through the match with ${rival}.`
  }
  const gapStr = gap != null ? `${gap} points below` : "short of"
  const when = days == null ? "" : days >= 0 ? ` with ${days} days to go` : " — the date has passed"
  return `${gapStr} the ${MILESTONE_MAIA_TARGET} target${when}. Measured — the projection is below.`
}

// ---------------------------------------------------------------------------
// Trajectory card — measured points + labeled projection (spec 215, Tier 2)
// ---------------------------------------------------------------------------

const CHART_W = 560
const CHART_H = 190
const CHART_PAD = { top: 18, right: 76, bottom: 24, left: 44 }
/** Series hue (emerald-600) — validated ≥3:1 against the dark surface. */
const CHART_LINE = "#059669"
const CHART_INK_MUTED = "rgba(255,255,255,0.55)"
const CHART_GRID = "rgba(255,255,255,0.08)"

function TrajectoryCard({
  metrics,
  overlay,
  rivalLabel,
}: {
  metrics: MetricPoint[]
  overlay: TrainingOverlay | null
  rivalLabel: string
}) {
  const projection = useMemo(
    () => projectMetric(metrics, "maia_rapid", overlay?.milestoneDate ?? null),
    [metrics, overlay?.milestoneDate],
  )
  return (
    <div
      data-testid="training-trajectory"
      className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-2"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="font-bold text-sm">Maia rapid — trajectory</h2>
        <span className="text-[11px] text-muted-foreground">
          measured monthly · dashed = projection
        </span>
      </div>
      <TrajectoryChart projection={projection} />
      <p className="text-xs text-muted-foreground" data-testid="training-projection-status">
        {projectionStatus(projection, rivalLabel)}
      </p>
    </div>
  )
}

/** Plain-language projection line — always labeled a projection, with its
 *  model stated (linear fit + Elo expected-score curve), never a promise. */
function projectionStatus(p: Projection, rivalLabel: string): string {
  const rival = rivalLabel.trim() || "your rival"
  if (p.measured.length < 2) {
    return "Projection needs at least two dated measurements — add this month's number and the next one draws the line."
  }
  if (p.targetT === null) {
    return "Set a milestone date above to project toward it."
  }
  if (p.trend === null || p.projected === null) {
    return "The measurements share one date — nothing to project yet."
  }
  const projected = Math.round(p.projected)
  const dateStr = new Date(p.targetT).toISOString().slice(0, 10)
  const pace =
    p.trend.slopePerDay <= 0
      ? "Current pace is flat or declining — the linear fit projects "
      : `Linear fit through ${p.trend.n} measurements projects `
  const wins = winsPerTen(p.projected, MILESTONE_MAIA_TARGET)
  return (
    `${pace}~${projected} by ${dateStr}. At that level vs ${rival} at ${MILESTONE_MAIA_TARGET}: ` +
    `${wins}/10 expected (Elo curve). A projection, not a promise.`
  )
}

function TrajectoryChart({ projection }: { projection: Projection }) {
  const { measured, targetT, projected } = projection
  if (measured.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic" data-testid="training-trajectory-empty">
        No dated Maia-rapid measurements yet.
      </p>
    )
  }

  // Domain: measured extent, stretched to the milestone when one is set.
  const t0 = measured[0].t
  const t1 = Math.max(measured[measured.length - 1].t, targetT ?? -Infinity)
  const tSpan = Math.max(t1 - t0, 1)
  const values = [
    ...measured.map((p) => p.v),
    MILESTONE_MAIA_TARGET,
    ...(projected !== null ? [projected] : []),
  ]
  const vMin = Math.min(...values)
  const vMax = Math.max(...values)
  const vPad = Math.max((vMax - vMin) * 0.12, 20)
  const y0 = vMin - vPad
  const y1 = vMax + vPad

  const iw = CHART_W - CHART_PAD.left - CHART_PAD.right
  const ih = CHART_H - CHART_PAD.top - CHART_PAD.bottom
  const x = (t: number) => CHART_PAD.left + ((t - t0) / tSpan) * iw
  const y = (v: number) => CHART_PAD.top + (1 - (v - y0) / (y1 - y0)) * ih

  const last = measured[measured.length - 1]
  const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7)
  const targetY = y(MILESTONE_MAIA_TARGET)
  const gridVals = [y0 + (y1 - y0) * 0.25, y0 + (y1 - y0) * 0.5, y0 + (y1 - y0) * 0.75]

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      className="w-full h-auto"
      role="img"
      aria-label="Maia rapid measurements over time with a dashed linear projection to the milestone date"
      data-testid="training-trajectory-chart"
    >
      {/* Recessive grid */}
      {gridVals.map((v, i) => (
        <line key={i} x1={CHART_PAD.left} x2={CHART_W - CHART_PAD.right} y1={y(v)} y2={y(v)} stroke={CHART_GRID} strokeWidth={1} />
      ))}

      {/* Target hairline — a reference, not a series */}
      <line
        x1={CHART_PAD.left}
        x2={CHART_W - CHART_PAD.right}
        y1={targetY}
        y2={targetY}
        stroke={CHART_INK_MUTED}
        strokeWidth={1}
        strokeDasharray="2 3"
      />
      <text x={CHART_W - CHART_PAD.right + 6} y={targetY + 3} fontSize={10} fill={CHART_INK_MUTED}>
        target {MILESTONE_MAIA_TARGET}
      </text>

      {/* Measured series */}
      {measured.length > 1 && (
        <polyline
          points={measured.map((p) => `${x(p.t)},${y(p.v)}`).join(" ")}
          fill="none"
          stroke={CHART_LINE}
          strokeWidth={2}
        />
      )}
      {measured.map((p) => (
        <circle key={p.t} cx={x(p.t)} cy={y(p.v)} r={4} fill={CHART_LINE}>
          <title>{`${monthOf(p.t)} · ${Math.round(p.v)}`}</title>
        </circle>
      ))}
      {/* Direct label on the latest measured value (ink, not series color) */}
      <text x={x(last.t)} y={y(last.v) - 8} fontSize={10} fill="rgba(255,255,255,0.85)" textAnchor="middle">
        {Math.round(last.v)}
      </text>

      {/* Projection — same entity, dashed, explicitly labeled */}
      {targetT !== null && projected !== null && targetT > last.t && (
        <>
          <line
            x1={x(last.t)}
            y1={y(last.v)}
            x2={x(targetT)}
            y2={y(projected)}
            stroke={CHART_LINE}
            strokeWidth={2}
            strokeDasharray="5 4"
            opacity={0.75}
          />
          <circle cx={x(targetT)} cy={y(projected)} r={4} fill="none" stroke={CHART_LINE} strokeWidth={2}>
            <title>{`projected · ${Math.round(projected)}`}</title>
          </circle>
          <text
            x={(x(last.t) + x(targetT)) / 2}
            y={(y(last.v) + y(projected)) / 2 - 7}
            fontSize={10}
            fill={CHART_INK_MUTED}
            textAnchor="middle"
          >
            projection
          </text>
        </>
      )}

      {/* X extent labels */}
      <text x={CHART_PAD.left} y={CHART_H - 8} fontSize={10} fill={CHART_INK_MUTED}>
        {monthOf(t0)}
      </text>
      <text x={CHART_W - CHART_PAD.right} y={CHART_H - 8} fontSize={10} fill={CHART_INK_MUTED} textAnchor="end">
        {targetT !== null && targetT >= last.t ? new Date(targetT).toISOString().slice(0, 10) : monthOf(last.t)}
      </text>
      {/* Y extent labels */}
      <text x={CHART_PAD.left - 6} y={y(y1) + 10} fontSize={10} fill={CHART_INK_MUTED} textAnchor="end">
        {Math.round(y1)}
      </text>
      <text x={CHART_PAD.left - 6} y={y(y0)} fontSize={10} fill={CHART_INK_MUTED} textAnchor="end">
        {Math.round(y0)}
      </text>
    </svg>
  )
}

function OverlayForm({
  overlay,
  onSave,
  onCancel,
}: {
  overlay: TrainingOverlay | null
  onSave: (ov: TrainingOverlay) => void
  onCancel?: () => void
}) {
  const [name, setName] = useState(overlay?.milestoneName ?? "")
  const [date, setDate] = useState(overlay?.milestoneDate ?? "")
  const [rival, setRival] = useState(overlay?.rivalLabel ?? "")
  const [notes, setNotes] = useState(overlay?.notes ?? "")
  const canSave = name.trim() !== "" && date.trim() !== ""
  return (
    <div className="space-y-3" data-testid="training-milestone-form">
      <div className="text-sm font-semibold">
        {overlay ? "Edit milestone" : "Set up your milestone"}
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Milestone name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. the rival match"
            data-testid="training-milestone-name"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Date</span>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            data-testid="training-milestone-date"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Rival label</span>
          <Input
            value={rival}
            onChange={(e) => setRival(e.target.value)}
            placeholder="e.g. your rival"
            data-testid="training-milestone-rival"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Notes (optional)</span>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!canSave}
          data-testid="training-milestone-save"
          onClick={() =>
            onSave({
              milestoneName: name.trim(),
              milestoneDate: date.trim(),
              rivalLabel: rival.trim(),
              notes: notes.trim() || undefined,
            })
          }
        >
          Save milestone
        </Button>
        {onCancel && (
          <Button size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Program view — chapters + gauges
// ---------------------------------------------------------------------------

function ChapterCard({
  chapter,
  current,
  metrics,
}: {
  chapter: Chapter
  current: boolean
  metrics: MetricPoint[]
}) {
  return (
    <div
      data-testid={`training-chapter-${chapter.id}`}
      className={`rounded-lg border p-4 ${
        current ? "border-emerald-500/40 bg-emerald-500/[0.05]" : "border-white/10 bg-white/[0.03]"
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-bold">
          {chapter.title}
          {current && (
            <span className="ml-2 text-[11px] uppercase tracking-wide text-emerald-300 align-middle">
              current
            </span>
          )}
        </h3>
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">
          Weeks {chapter.weekStart}–{chapter.weekEnd}
        </span>
      </div>

      <ul className="mt-2 space-y-1 text-sm text-muted-foreground list-disc list-inside">
        {chapter.objectives.map((o, i) => (
          <li key={i}>{o}</li>
        ))}
      </ul>

      <div className="mt-3 space-y-2">
        <div className="text-xs font-semibold text-muted-foreground">Exit criteria (measured)</div>
        {chapter.exitCriteria.map((c, i) => (
          <CriterionGauge key={i} criterion={c} metrics={metrics} />
        ))}
      </div>
    </div>
  )
}

function CriterionGauge({ criterion, metrics }: { criterion: ExitCriterion; metrics: MetricPoint[] }) {
  const latest = latestMetric(metrics, criterion.metric)
  const gauge: Gauge = gaugeFor(criterion, latest?.value ?? null)
  const barColor =
    gauge.state === "met" ? "bg-emerald-500" : gauge.state === "unmet" ? "bg-amber-500" : "bg-white/20"
  return (
    <div className="flex items-center gap-3" data-testid={`training-gauge-${criterion.metric}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between text-xs">
          <span className="truncate">{formatCriterion(criterion)}</span>
          <span
            className={`tabular-nums shrink-0 ml-2 ${
              gauge.state === "met"
                ? "text-emerald-300"
                : gauge.state === "unmet"
                  ? "text-amber-300"
                  : "text-muted-foreground italic"
            }`}
          >
            {gauge.value == null
              ? "not yet measured"
              : `now ${METRIC_META[criterion.metric].format(gauge.value)}`}
          </span>
        </div>
        <div className="mt-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div className={`h-full ${barColor}`} style={{ width: `${Math.round(gauge.progress * 100)}%` }} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Metrics panel — history + manual entry
// ---------------------------------------------------------------------------

/** State + actions for the in-place monthly pipeline run (spec 215 Tier 2
 *  spawn) — owned by TrainingTab so it survives playout/deck launches. */
interface MeasureRun {
  /** Whether this shell can spawn the pipeline (desktop native host). */
  canSpawn: boolean
  user: string
  onUserChange: (user: string) => void
  running: boolean
  /** Current pipeline stage label while running. */
  stage: string | null
  /** Streamed output tail (capped). */
  log: string[]
  onRun: (opts: { skipFetch: boolean; skipMaia: boolean }) => void
  onCancel: () => void
}

function MetricsPanel({
  metrics,
  onAdd,
  onRefreshSpar,
  onRefreshEg,
  onImportText,
  measureMsg,
  run,
}: {
  metrics: MetricPoint[]
  onAdd: (p: MetricPoint) => void
  /** Recompute this month's spar score from the stored spar games (in-app). */
  onRefreshSpar: () => void
  /** Recompute this month's endgame conversion from the stored playout
   *  verdicts (in-app). */
  onRefreshEg: () => void
  /** Import a measurement file's text (scripts/measure_monthly.py output). */
  onImportText: (text: string) => void
  measureMsg: string | null
  run: MeasureRun
}) {
  const [metric, setMetric] = useState<MetricKey>("maia_rapid")
  const [value, setValue] = useState("")
  const [at, setAt] = useState(localMonth())
  const parsed = parseFloat(value)
  const canAdd = value.trim() !== "" && !Number.isNaN(parsed) && at.trim() !== ""

  const add = () => {
    if (!canAdd) return
    onAdd({ at: at.trim(), metric, value: parsed })
    setValue("")
  }

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = "" // allow re-picking the same file
    if (!file) return
    file
      .text()
      .then(onImportText)
      .catch(() => onImportText("")) // unreadable file → parse error surfaces the message
  }

  return (
    <div data-testid="training-metrics" className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-4">
      <div>
        <h2 className="font-bold">Measurements</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          The monthly needle. Enter real numbers — exit criteria read the latest of each. No inflation.
        </p>
      </div>

      {/* Refresh paths (spec 215 Tier 2): spar score straight from the stored
          games; the pipeline metrics via the monthly script's output file. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={onRefreshSpar} data-testid="training-refresh-spar">
          Refresh spar score
        </Button>
        <Button size="sm" variant="outline" onClick={onRefreshEg} data-testid="training-refresh-eg">
          Refresh endgame conversion
        </Button>
        <label className="inline-flex">
          <input
            type="file"
            accept=".json,application/json"
            onChange={onFilePicked}
            className="hidden"
            data-testid="training-import-file"
          />
          <span className="cursor-pointer inline-flex items-center px-3 h-8 rounded-md border border-input bg-transparent text-sm hover:bg-white/5">
            Import measurements…
          </span>
        </label>
        <span className="text-[11px] text-muted-foreground">
          from <code className="font-mono">scripts/measure_monthly.py</code>
        </span>
      </div>
      {measureMsg && (
        <p className="text-xs text-muted-foreground" data-testid="training-measure-msg">
          {measureMsg}
        </p>
      )}

      <MonthlyRunSection run={run} />

      {/* Latest per metric */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {METRIC_KEYS.map((k) => {
          const l = latestMetric(metrics, k)
          return (
            <div key={k} className="rounded-md border border-white/10 p-2" data-testid={`training-latest-${k}`}>
              <div className="text-[11px] text-muted-foreground leading-tight">{METRIC_META[k].label}</div>
              <div className="text-lg font-bold tabular-nums mt-0.5">
                {l == null ? <span className="text-muted-foreground text-sm italic">—</span> : METRIC_META[k].format(l.value)}
              </div>
              {l?.note && <div className="text-[10px] text-muted-foreground">{l.note}</div>}
              {l && !l.note && <div className="text-[10px] text-muted-foreground tabular-nums">{l.at}</div>}
            </div>
          )
        })}
      </div>

      {/* Manual entry */}
      <div className="flex flex-wrap items-end gap-2 border-t border-white/10 pt-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Metric</span>
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as MetricKey)}
            data-testid="training-metric-select"
            className="block bg-background border border-input rounded-md px-2 py-1.5 text-sm text-foreground"
          >
            {METRIC_KEYS.map((k) => (
              <option key={k} value={k}>
                {METRIC_META[k].label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Value</span>
          <Input
            type="number"
            step="any"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. 1350"
            data-testid="training-metric-value"
            className="w-28 tabular-nums"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Month</span>
          <Input
            type="month"
            value={at}
            onChange={(e) => setAt(e.target.value)}
            data-testid="training-metric-month"
            className="w-36"
          />
        </label>
        <Button size="sm" disabled={!canAdd} onClick={add} data-testid="training-metric-add">
          Add measurement
        </Button>
      </div>

      {/* History (most recent first) */}
      {metrics.length > 0 && (
        <div className="border-t border-white/10 pt-3">
          <div className="text-xs font-semibold text-muted-foreground mb-1.5">History</div>
          <table className="w-full text-sm">
            <tbody data-testid="training-metric-history">
              {metrics
                .slice()
                .reverse()
                .map((p, i) => (
                  <tr key={i} className="border-b border-white/5 last:border-0">
                    <td className="py-1 tabular-nums text-muted-foreground w-20">{p.at}</td>
                    <td className="py-1">{METRIC_META[p.metric].label}</td>
                    <td className="py-1 text-right tabular-nums">{METRIC_META[p.metric].format(p.value)}</td>
                    <td className="py-1 text-right text-xs text-muted-foreground">{p.note ?? ""}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Monthly pipeline run — spawn + live log (spec 215, Tier 2)
// ---------------------------------------------------------------------------

/** Run scripts/measure_monthly.py in place with streamed output. Honest about
 *  cost (the lc0 stage is minutes) and about capability: shells without a
 *  native process host keep the terminal-run + import path instead. */
function MonthlyRunSection({ run }: { run: MeasureRun }) {
  const [skipFetch, setSkipFetch] = useState(false)
  const [skipMaia, setSkipMaia] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  // Follow the stream: pin the log view to its newest line as it grows.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [run.log])

  const canRun = run.canSpawn && run.user.trim() !== "" && !run.running

  return (
    <div className="border-t border-white/10 pt-3 space-y-2" data-testid="training-measure-run">
      <div>
        <div className="text-xs font-semibold text-muted-foreground">Monthly measurement</div>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Runs the full pipeline in place — fetch, profile, then the Maia rating estimate. The lc0
          stage takes minutes; output streams below. Results land via the same import as the file
          button.
        </p>
      </div>

      {!run.canSpawn && (
        <p className="text-[11px] text-muted-foreground" data-testid="training-measure-nospawn">
          Running in place needs the desktop app — run{" "}
          <code className="font-mono">scripts/measure_monthly.py</code> in a terminal and use Import
          measurements… above.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>chess.com username</span>
          <Input
            value={run.user}
            onChange={(e) => run.onUserChange(e.target.value)}
            placeholder="your account"
            disabled={run.running}
            data-testid="training-measure-user"
            className="w-44"
          />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground pb-2 cursor-pointer">
          <input
            type="checkbox"
            checked={skipFetch}
            disabled={run.running}
            onChange={(e) => setSkipFetch(e.target.checked)}
            data-testid="training-measure-skip-fetch"
          />
          reuse fetched games
        </label>
        <label
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground pb-2 cursor-pointer"
          title="Profile-only metrics (endgame conversion, flag net) — skips the multi-minute lc0 rating stage."
        >
          <input
            type="checkbox"
            checked={skipMaia}
            disabled={run.running}
            onChange={(e) => setSkipMaia(e.target.checked)}
            data-testid="training-measure-skip-maia"
          />
          skip Maia estimate
        </label>
        {run.running ? (
          <Button size="sm" variant="outline" onClick={run.onCancel} data-testid="training-measure-cancel">
            Cancel run
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={!canRun}
            onClick={() => run.onRun({ skipFetch, skipMaia })}
            data-testid="training-measure-start"
          >
            Run measurement
          </Button>
        )}
      </div>

      {run.running && run.stage && (
        <p className="text-xs" data-testid="training-measure-stage">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse mr-1.5 align-middle" />
          {run.stage}
        </p>
      )}
      {(run.running || run.log.length > 0) && (
        <pre
          ref={logRef}
          data-testid="training-measure-log"
          className="max-h-40 overflow-auto rounded bg-black/40 p-2 text-[10px] leading-4 font-mono text-muted-foreground whitespace-pre-wrap"
        >
          {run.log.join("\n")}
        </pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Spar games — the recorded results feeding spar_score (spec 215, Tier 1)
// ---------------------------------------------------------------------------

const SPAR_GAMES_SHOWN = 15

function SparGamesCard({
  results,
  onReclassify,
  now,
}: {
  results: SparResultEntry[]
  onReclassify: (id: string, counts: boolean) => void
  now: number
}) {
  const score = sparScore(results, now)
  const recent = results.slice(-SPAR_GAMES_SHOWN).reverse()
  return (
    <div data-testid="training-spar-games" className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-3">
      <div>
        <h2 className="font-bold">Spar games</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Recorded automatically at game end. Serious games count by default; probe never counts.
          Flagged games STAY in the score until you untick them — flagged, never silently dropped.
        </p>
      </div>

      <div className="text-sm" data-testid="training-spar-score">
        {score.score === null ? (
          <span className="text-muted-foreground italic">
            No counting games in the last {SPAR_SCORE_WINDOW_DAYS} days.
          </span>
        ) : (
          <>
            <span className="font-bold tabular-nums">{Math.round(score.score * 100)}%</span>{" "}
            <span className="text-muted-foreground">
              over {score.games} counting game{score.games === 1 ? "" : "s"}
              {score.flagged > 0 ? ` (${score.flagged} flagged, included)` : ""} · last{" "}
              {SPAR_SCORE_WINDOW_DAYS} days
            </span>
          </>
        )}
      </div>

      {recent.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No games recorded yet — finish a Play-vs-Bot game and it lands here.
        </p>
      ) : (
        <table className="w-full text-sm">
          <tbody data-testid="training-spar-list">
            {recent.map((g) => (
              <tr key={g.id} className="border-b border-white/5 last:border-0" data-testid={`training-spar-game-${g.id}`}>
                <td className="py-1 tabular-nums text-muted-foreground w-24">{g.at.slice(0, 10)}</td>
                <td className="py-1 truncate max-w-32">{g.opponent}</td>
                <td className="py-1 tabular-nums text-muted-foreground">{g.level}</td>
                <td className="py-1">
                  <span
                    className={
                      g.result === "win"
                        ? "text-emerald-300"
                        : g.result === "loss"
                          ? "text-red-300"
                          : "text-muted-foreground"
                    }
                  >
                    {g.result}
                  </span>
                  {g.mode === "probe" && (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wide text-violet-300">probe</span>
                  )}
                </td>
                <td className="py-1 text-xs text-amber-300/90">
                  {g.anomalyFlags.map((f) => ANOMALY_LABELS[f]).join(", ")}
                </td>
                <td className="py-1 text-right">
                  <label
                    className={`inline-flex items-center gap-1.5 text-xs ${
                      g.mode === "probe" ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
                    }`}
                    title={
                      g.mode === "probe"
                        ? "Probe games never count toward training."
                        : "Counts toward the spar score."
                    }
                  >
                    <input
                      type="checkbox"
                      checked={g.countsTowardTraining}
                      disabled={g.mode === "probe"}
                      onChange={(e) => onReclassify(g.id, e.target.checked)}
                      data-testid={`training-spar-counts-${g.id}`}
                    />
                    counts
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Playout verdicts — the recorded playouts feeding eg_conversion (spec 215)
// ---------------------------------------------------------------------------

const PLAYOUTS_SHOWN = 15

function PlayoutGamesCard({
  results,
  onReclassify,
  now,
}: {
  results: PlayoutResultEntry[]
  onReclassify: (id: string, counts: boolean) => void
  now: number
}) {
  const conv = egConversion(results, now)
  const recent = results.slice(-PLAYOUTS_SHOWN).reverse()
  return (
    <div data-testid="training-playout-games" className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-3">
      <div>
        <h2 className="font-bold">Playout verdicts</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Recorded automatically at game end. Serious playouts count by default; probe never counts.
          Only win-claim playouts feed the conversion rate (holding a level position is a different
          skill). Flagged games STAY in the rate until you untick them — flagged, never silently
          dropped.
        </p>
      </div>

      <div className="text-sm" data-testid="training-eg-conversion">
        {conv.rate === null ? (
          <span className="text-muted-foreground italic">
            No counting win-claim playouts in the last {EG_CONVERSION_WINDOW_DAYS} days.
          </span>
        ) : (
          <>
            <span className="font-bold tabular-nums">{Math.round(conv.rate * 100)}%</span>{" "}
            <span className="text-muted-foreground">
              converted over {conv.games} counting playout{conv.games === 1 ? "" : "s"} ({conv.converted}{" "}
              converted, {conv.held} held, {conv.dropped} dropped
              {conv.flagged > 0 ? `; ${conv.flagged} flagged, included` : ""}) · last{" "}
              {EG_CONVERSION_WINDOW_DAYS} days
            </span>
          </>
        )}
      </div>

      {recent.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No playouts recorded yet — finish a Play-it-out game and it lands here.
        </p>
      ) : (
        <table className="w-full text-sm">
          <tbody data-testid="training-playout-list">
            {recent.map((g) => (
              <tr key={g.id} className="border-b border-white/5 last:border-0" data-testid={`training-playout-game-${g.id}`}>
                <td className="py-1 tabular-nums text-muted-foreground w-24">{g.at.slice(0, 10)}</td>
                <td className="py-1 tabular-nums text-muted-foreground">
                  {g.evalPawns > 0 ? `+${g.evalPawns}` : g.evalPawns} vs {g.level}
                </td>
                <td className="py-1">
                  <span
                    className={
                      g.verdict === "converted"
                        ? "text-emerald-300"
                        : g.verdict === "dropped"
                          ? "text-red-300"
                          : "text-amber-300"
                    }
                  >
                    {VERDICT_LABELS[g.verdict]}
                  </span>
                  {g.mode === "probe" && (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wide text-violet-300">probe</span>
                  )}
                  {g.claim === "draw" && (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground" title="Hold-claim playouts never feed the conversion rate.">
                      hold claim
                    </span>
                  )}
                </td>
                <td className="py-1 text-xs text-amber-300/90">
                  {g.anomalyFlags.map((f) => ANOMALY_LABELS[f]).join(", ")}
                </td>
                <td className="py-1 text-right">
                  <label
                    className={`inline-flex items-center gap-1.5 text-xs ${
                      g.mode === "probe" ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
                    }`}
                    title={
                      g.mode === "probe"
                        ? "Probe playouts never count toward training."
                        : "Counts toward the endgame conversion rate."
                    }
                  >
                    <input
                      type="checkbox"
                      checked={g.countsTowardTraining}
                      disabled={g.mode === "probe"}
                      onChange={(e) => onReclassify(g.id, e.target.checked)}
                      data-testid={`training-playout-counts-${g.id}`}
                    />
                    counts
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function SubNavButton({
  id,
  active,
  onClick,
  children,
}: {
  id: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      data-testid={id}
      onClick={onClick}
      className={`px-3 py-1.5 text-sm rounded-t-md transition-colors ${
        active
          ? "text-foreground font-medium border-b-2 border-emerald-500"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  )
}

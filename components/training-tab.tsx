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

import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
  type TrainingOverlay,
} from "@/lib/training-program"

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
  const program = ROAD_TO_1900

  // Persisted state. Metrics seed to the baseline so gauges render before the
  // client effect runs (and under server-render). start/overlay hydrate on mount.
  const [startISO, setStartISO] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<TrainingOverlay | null>(null)
  const [log, setLog] = useState<LogByDate>({})
  const [metrics, setMetrics] = useState<MetricPoint[]>(DEFAULT_METRICS)
  const [now] = useState(() => Date.now())

  // Hydrate from localStorage once, on the client.
  useEffect(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEYS.start)
      if (s) setStartISO(s)
      const ov = localStorage.getItem(STORAGE_KEYS.overlay)
      if (ov) setOverlay(JSON.parse(ov) as TrainingOverlay)
      const lg = localStorage.getItem(STORAGE_KEYS.log)
      if (lg) setLog(JSON.parse(lg) as LogByDate)
      const mx = localStorage.getItem(STORAGE_KEYS.metrics)
      if (mx) {
        const parsed = JSON.parse(mx) as MetricPoint[]
        if (Array.isArray(parsed) && parsed.length > 0) setMetrics(parsed)
      }
    } catch {
      /* malformed storage — fall back to defaults already in state */
    }
  }, [])

  const write = useCallback((key: string, value: unknown) => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* storage unavailable — state still lives in memory */
    }
  }, [])

  const startProgram = useCallback(() => {
    const iso = localISODate()
    setStartISO(iso)
    try {
      localStorage.setItem(STORAGE_KEYS.start, iso)
    } catch {
      /* ignore */
    }
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

  const latestMaia = latestMetric(metrics, "maia_rapid")
  const rivalLabel = overlay?.rivalLabel?.trim() || "your rival"
  const checkedToday = log[todayISO] ?? {}

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

          {startISO == null ? (
            <StartCard onStart={startProgram} rivalLabel={rivalLabel} />
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

          <MetricsPanel metrics={metrics} onAdd={addMetric} />
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
}: {
  block: DayBlock
  checked: boolean
  onToggle: () => void
  onLaunch: (sub: LearnLaunch) => void
}) {
  const launch =
    block.type === "calibration_session"
      ? { sub: "calibrate" as LearnLaunch, label: "Open calibration" }
      : block.type === "spar_rival"
        ? { sub: "spar" as LearnLaunch, label: "Open Spar" }
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
            onClick={() => onLaunch(launch.sub)}
            className="shrink-0"
          >
            {launch.label}
          </Button>
        )}
      </div>
    </div>
  )
}

function StartCard({ onStart, rivalLabel }: { onStart: () => void; rivalLabel: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-center space-y-3">
      <h2 className="text-lg font-bold">Start the program</h2>
      <p className="text-sm text-muted-foreground">
        Set today as day one. The weekly template then shows you what to train against {rivalLabel}, by
        weekday, with the features that exist wired to launch.
      </p>
      <Button onClick={onStart} data-testid="training-start" size="lg">
        Start Road to 1900
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

/** Honest one-liner — no projection math in Tier 0, just the measured gap. */
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
  return `${gapStr} the ${MILESTONE_MAIA_TARGET} target${when}. Real numbers, no projection yet.`
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

function MetricsPanel({
  metrics,
  onAdd,
}: {
  metrics: MetricPoint[]
  onAdd: (p: MetricPoint) => void
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

  return (
    <div data-testid="training-metrics" className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-4">
      <div>
        <h2 className="font-bold">Measurements</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          The monthly needle. Enter real numbers — exit criteria read the latest of each. No inflation.
        </p>
      </div>

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

// Training program model + the bundled "Road to 1900" curriculum (spec 215, Tier 0).
//
// The program is DATA: chapters (phases with objectives and MEASURED exit
// criteria), a day-indexed weekly template of exercise blocks, and the metrics
// those criteria read. The curriculum shipped here is GENERIC and rival-agnostic
// ("your rival", never a name) — personal details (a real milestone name/date,
// a rival label) arrive at runtime from a LOCAL overlay in localStorage and are
// never bundled or committed (see TrainingOverlay).
//
// Everything here is pure and SSR-safe: no localStorage, no window. The Training
// tab component owns persistence (localStorage, like calibration-tab) and calls
// these helpers. Persistence migration path: a native training_metrics file
// (Tauri command) can replace the localStorage keys later without touching this
// model — the shapes are already dated, append-only points.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Exercise block types. Only some launch a real feature today (Tier 0):
 *  calibration_session → Learn/calibration, spar_rival → Learn/Spar. The rest
 *  are check-off-only with a one-line instruction until their feature exists
 *  (endgame play-it-out, rake decks: Tier 1). */
export type ExerciseType =
  | "calibration_session"
  | "spar_rival"
  | "long_game_review"
  | "rest"
  | "other"

/** The measured needles a chapter's exit criteria read. Baseline values are
 *  seeded for the three we already measure (maia_rapid, eg_conversion,
 *  flag_net); the other two stay "not yet measured" until entered. */
export type MetricKey =
  | "maia_rapid"
  | "eg_conversion"
  | "flag_net"
  | "calib_mae_level"
  | "spar_score"

export type Comparator = ">=" | "<=" | ">" | "<"

/** A MEASURED exit criterion — never a vibe. A chapter that misses its criteria
 *  says so (the gauge stays unmet) rather than silently advancing. */
export interface ExitCriterion {
  metric: MetricKey
  cmp: Comparator
  target: number
}

/** One block in a day's template. `id` is stable per (chapter, day, slot) so
 *  check-offs key off it. `launch` names the in-app feature to jump to, when one
 *  exists; otherwise the block is check-off-only and `detail` is the instruction. */
export interface DayBlock {
  id: string
  /** JS Date.getDay(): 0 = Sunday … 6 = Saturday. */
  day: number
  type: ExerciseType
  title: string
  detail: string
  minutes?: number
}

export interface Chapter {
  id: string
  title: string
  /** Relative window, 1-based weeks from the program start date. */
  weekStart: number
  weekEnd: number
  objectives: string[]
  /** Day-indexed weekly template; each block carries its own `day`. */
  week: DayBlock[]
  exitCriteria: ExitCriterion[]
}

export interface Program {
  name: string
  goal: string
  chapters: Chapter[]
}

/** Local, per-user personalization loaded from localStorage at runtime. Never
 *  bundled. When present the milestone card and labels personalize; when absent
 *  the program uses generic "your rival" wording. */
export interface TrainingOverlay {
  milestoneName: string
  /** ISO date (YYYY-MM-DD) of the milestone. */
  milestoneDate: string
  rivalLabel: string
  notes?: string
}

/** A dated, append-only metric measurement. `at` is a YYYY-MM label (monthly
 *  cadence); `note` tags provenance (e.g. "baseline (measured)"). */
export interface MetricPoint {
  at: string
  metric: MetricKey
  value: number
  note?: string
}

// ---------------------------------------------------------------------------
// Metric metadata
// ---------------------------------------------------------------------------

export interface MetricMeta {
  key: MetricKey
  label: string
  /** True when a higher value is better (maia, conversion, spar, flag-toward-0);
   *  false when lower is better (calibration error). */
  higherIsBetter: boolean
  format: (v: number) => string
}

export const METRIC_META: Record<MetricKey, MetricMeta> = {
  maia_rapid: {
    key: "maia_rapid",
    label: "Maia rapid",
    higherIsBetter: true,
    format: (v) => Math.round(v).toString(),
  },
  eg_conversion: {
    key: "eg_conversion",
    label: "Endgame conversion",
    higherIsBetter: true,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  flag_net: {
    key: "flag_net",
    label: "Flag net",
    higherIsBetter: true,
    format: (v) => (v > 0 ? `+${v}` : `${v}`),
  },
  calib_mae_level: {
    key: "calib_mae_level",
    label: "Calibration MAE (level band)",
    higherIsBetter: false,
    format: (v) => v.toFixed(2),
  },
  spar_score: {
    key: "spar_score",
    label: "Spar score vs rival",
    higherIsBetter: true,
    format: (v) => `${Math.round(v * 100)}%`,
  },
}

export const METRIC_KEYS = Object.keys(METRIC_META) as MetricKey[]

/** Human-readable criterion, e.g. "Maia rapid ≥ 1350". */
export function formatCriterion(c: ExitCriterion): string {
  const sym = c.cmp === ">=" ? "≥" : c.cmp === "<=" ? "≤" : c.cmp
  return `${METRIC_META[c.metric].label} ${sym} ${METRIC_META[c.metric].format(c.target)}`
}

/** Does `value` satisfy the criterion? */
export function evaluateCriterion(c: ExitCriterion, value: number): boolean {
  switch (c.cmp) {
    case ">=":
      return value >= c.target
    case "<=":
      return value <= c.target
    case ">":
      return value > c.target
    case "<":
      return value < c.target
  }
}

// ---------------------------------------------------------------------------
// Gauge state (Program view)
// ---------------------------------------------------------------------------

export type GaugeState = "met" | "unmet" | "unmeasured"

export interface Gauge {
  state: GaugeState
  /** Latest measured value, or null when never measured. */
  value: number | null
  target: number
  /** 0..1 fill for a progress bar; 0 when unmeasured, 1 when met. */
  progress: number
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** Gauge state for one criterion given its latest measured value (or null).
 *  Progress is a rough visual fill toward the target — full when met. */
export function gaugeFor(c: ExitCriterion, latest: number | null): Gauge {
  if (latest === null) return { state: "unmeasured", value: null, target: c.target, progress: 0 }
  const met = evaluateCriterion(c, latest)
  let progress: number
  if (met) {
    progress = 1
  } else if (METRIC_META[c.metric].higherIsBetter) {
    progress = c.target === 0 ? 0 : clamp01(latest / c.target)
  } else {
    // Lower is better: closer (smaller) to target reads as fuller.
    progress = latest === 0 ? 1 : clamp01(c.target / latest)
  }
  return { state: met ? "met" : "unmet", value: latest, target: c.target, progress }
}

// ---------------------------------------------------------------------------
// Metrics history
// ---------------------------------------------------------------------------

/** The most recent point for a metric (by array order — points are appended in
 *  time order), or null when the metric was never measured. */
export function latestMetric(points: MetricPoint[], metric: MetricKey): MetricPoint | null {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].metric === metric) return points[i]
  }
  return null
}

/** Append a dated point; returns a new array (the store is append-only). */
export function appendMetric(points: MetricPoint[], point: MetricPoint): MetricPoint[] {
  return [...points, point]
}

/** Baseline row (2026-07), used only when the metrics store is empty. The three
 *  we measure today; the other two stay unmeasured until entered. */
export const DEFAULT_METRICS: MetricPoint[] = [
  { at: "2026-07", metric: "maia_rapid", value: 1200, note: "baseline (measured)" },
  { at: "2026-07", metric: "eg_conversion", value: 0.42, note: "baseline (measured)" },
  { at: "2026-07", metric: "flag_net", value: -85, note: "baseline (measured)" },
]

// ---------------------------------------------------------------------------
// Program timeline
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

/** 1-based week index into the program from its start date. Week 1 is the start
 *  week; clamps at a floor of 1 (a not-yet-started future date still reads 1). */
export function currentWeek(startISO: string, now: number = Date.now()): number {
  const start = Date.parse(startISO)
  if (Number.isNaN(start)) return 1
  const weeks = Math.floor((now - start) / (7 * DAY_MS))
  return Math.max(1, weeks + 1)
}

/** The chapter whose window contains `week`; before the first chapter → first,
 *  after the last → last (the program doesn't fall off the end mid-milestone). */
export function chapterForWeek(program: Program, week: number): Chapter {
  const chapters = program.chapters
  for (const ch of chapters) {
    if (week >= ch.weekStart && week <= ch.weekEnd) return ch
  }
  if (week < chapters[0].weekStart) return chapters[0]
  return chapters[chapters.length - 1]
}

/** The blocks scheduled for a given JS weekday (0 = Sunday), in template order. */
export function blocksForDay(chapter: Chapter, jsDay: number): DayBlock[] {
  return chapter.week.filter((b) => b.day === jsDay)
}

/** Whole days from now until the milestone (negative once past). Null when no
 *  milestone date is set (no overlay). */
export function daysRemaining(milestoneISO: string | null, now: number = Date.now()): number | null {
  if (!milestoneISO) return null
  const target = Date.parse(milestoneISO)
  if (Number.isNaN(target)) return null
  return Math.ceil((target - now) / DAY_MS)
}

/** Gap from the latest Maia-rapid estimate to the milestone target (positive =
 *  still below target). Null when Maia rapid was never measured. */
export function gapToTarget(latestMaia: number | null, target: number = MILESTONE_MAIA_TARGET): number | null {
  if (latestMaia === null) return null
  return target - latestMaia
}

/** Milestone Maia-rapid target — the number the milestone card measures against. */
export const MILESTONE_MAIA_TARGET = 1500

// ---------------------------------------------------------------------------
// localStorage keys (owned by the component; exported for tests + reuse)
// ---------------------------------------------------------------------------

export const STORAGE_KEYS = {
  /** ISO date the user started the program; absent = not started. */
  start: "chessgui:training-start",
  /** TrainingOverlay JSON (local personalization). */
  overlay: "chessgui:training-overlay",
  /** { [YYYY-MM-DD]: { [blockId]: true } } — per-date check-offs. */
  log: "chessgui:training-log",
  /** MetricPoint[] — append-only dated measurements. */
  metrics: "chessgui:training-metrics",
} as const

// ---------------------------------------------------------------------------
// The bundled program — "Road to 1900" (generic, rival-agnostic)
// ---------------------------------------------------------------------------
//
// Chapters 1–3 generalize a three-phase plan (rakes + clock → conversion →
// rival taper) into rival-agnostic language. Windows are relative weeks; the
// absolute calendar comes from the program start date the user sets. Weekly
// templates are day-indexed (0 = Sun … 6 = Sat).

function block(
  id: string,
  day: number,
  type: ExerciseType,
  title: string,
  detail: string,
  minutes?: number,
): DayBlock {
  return { id, day, type, title, detail, minutes }
}

const CHAPTER_1: Chapter = {
  id: "ch1-stop-the-bleeding",
  title: "Stop the Bleeding",
  weekStart: 1,
  weekEnd: 7,
  objectives: [
    "Stop losing games to opening rakes and cheap tactics.",
    "Clock hygiene: play with increment, and never lose on time.",
    "Fix the equal-position illusion — stop inventing advantages that aren't there.",
  ],
  week: [
    block("c1-sun", 0, "rest", "Rest", "Rest, or casual unrated only. Never play rated tired."),
    block("c1-mon", 1, "other", "Tactics + rapid game", "Tactics/pattern practice, then one rapid game (15+10) with a full review.", 45),
    block("c1-tue", 2, "other", "Endgame play-it-out", "Convert a winning endgame (+1.5 to +3) against the engine; replay any failure.", 30),
    block("c1-wed", 3, "calibration_session", "Calibration session", "Run a Learn calibration deck; write your eval before every reveal.", 20),
    block("c1-thu", 4, "other", "Tactics + rapid game", "Tactics/pattern practice, then one rapid game (15+10) with a full review.", 45),
    block("c1-fri", 5, "spar_rival", "Spar your rival", "Play your rival's openings with the clock on.", 45),
    block("c1-sat", 6, "long_game_review", "Long game + review", "One slow game (30+20), then an engine-last review with rebuttal notes."),
  ],
  exitCriteria: [
    { metric: "maia_rapid", cmp: ">=", target: 1350 },
    { metric: "flag_net", cmp: ">=", target: -30 },
    { metric: "calib_mae_level", cmp: "<", target: 0.7 },
  ],
}

const CHAPTER_2: Chapter = {
  id: "ch2-conversion",
  title: "Conversion",
  weekStart: 8,
  weekEnd: 18,
  objectives: [
    "Convert winning positions — endgame technique is the biggest trainable leak.",
    "Groove K+P and rook-endgame fundamentals (opposition, Lucena/Philidor, the square rule).",
    "Spar your rival's positions and track the score.",
  ],
  week: [
    block("c2-sun", 0, "rest", "Rest", "Rest, or casual unrated only. Never play rated tired."),
    block("c2-mon", 1, "other", "Endgame play-it-out", "Convert a +2 position vs the engine; replay every failure.", 30),
    block("c2-tue", 2, "calibration_session", "Calibration session", "Run a Learn calibration deck; write your eval before every reveal.", 20),
    block("c2-wed", 3, "other", "Endgame fundamentals", "K+P and rook-endgame drills — opposition, Lucena/Philidor, the square rule.", 30),
    block("c2-thu", 4, "other", "Endgame play-it-out", "Convert a +2 position vs the engine; replay every failure.", 30),
    block("c2-fri", 5, "spar_rival", "Spar your rival", "Play from your rival's positions; track your score.", 45),
    block("c2-sat", 6, "long_game_review", "Long game + review", "One slow game (30+20), then an engine-last review with rebuttal notes."),
  ],
  exitCriteria: [
    { metric: "eg_conversion", cmp: ">=", target: 0.5 },
    { metric: "maia_rapid", cmp: ">=", target: 1450 },
    { metric: "spar_score", cmp: ">=", target: 0.4 },
  ],
}

const CHAPTER_3: Chapter = {
  id: "ch3-rival-taper",
  title: "Rival Taper",
  weekStart: 19,
  weekEnd: 23,
  objectives: [
    "Prepare specific anti-lines against your rival's repertoire.",
    "Spar above your rival's weight so the real thing feels slow.",
    "Rehearse slow, OTB-style games under match conditions.",
  ],
  week: [
    block("c3-sun", 0, "rest", "Rest", "Rest, or casual unrated only. Never play rated tired."),
    block("c3-mon", 1, "other", "Anti-line prep", "Drill your prepared lines against the rival's repertoire — discomfort over theory.", 45),
    block("c3-tue", 2, "spar_rival", "Spar your rival (above weight)", "Spar one strength band above your rival's level.", 45),
    block("c3-wed", 3, "calibration_session", "Calibration session", "Run a Learn calibration deck; write your eval before every reveal.", 20),
    block("c3-thu", 4, "spar_rival", "Spar your rival", "Play your rival's openings with the clock on.", 45),
    block("c3-fri", 5, "other", "OTB-simulation game", "A slow game on a physical board if you can — OTB eyes differ from screen eyes."),
    block("c3-sat", 6, "long_game_review", "Long game + review", "One slow game (30+20), then an engine-last review with rebuttal notes."),
  ],
  exitCriteria: [
    { metric: "maia_rapid", cmp: ">=", target: 1500 },
    { metric: "spar_score", cmp: ">=", target: 0.45 },
  ],
}

export const ROAD_TO_1900: Program = {
  name: "Road to 1900",
  goal: "Reach 1900 over the board — the first milestone a match against your rival. The goal outlives the milestone.",
  chapters: [CHAPTER_1, CHAPTER_2, CHAPTER_3],
}

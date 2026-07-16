// Measurement refresh glue for the Training tab (spec 215, Tier 2).
//
// Two refresh paths, both landing in the same MetricPoint store:
//
// 1. IN-APP: spar_score is recomputed directly from the locally persisted
//    spar results (lib/spar-results), and eg_conversion from the persisted
//    playout verdicts (lib/playout) — fully automatic, no script.
// 2. SCRIPT: maia_rapid / eg_conversion / flag_net come from the monthly
//    self-analysis pipeline (scripts/measure_monthly.py, the rescued
//    fetch→engage→analyze→maia→stats chain). The script writes
//    data/rivals/training_metrics.json; the Training tab imports that file.
//    On the desktop shell the tab can now also SPAWN the script in place
//    (src-tauri/src/measure.rs) with its output streamed live — the progress
//    surface the earlier import-only step was waiting for. The import path
//    stays for the plain browser and for terminal runs.
//
// Everything here is pure (no localStorage, no Tauri) — the component owns
// persistence, same split as lib/training-program.

import {
  METRIC_KEYS,
  type MetricKey,
  type MetricPoint,
} from "@/lib/training-program"
import type { MeasureLine, MeasureReport } from "@chessgui/core/platform-types"

export type { MeasureLine, MeasureReport }
import { sparScore, type SparResultEntry } from "@/lib/spar-results"
import { egConversion, type PlayoutResultEntry } from "@/lib/playout"

// ---------------------------------------------------------------------------
// Measurement-file import (the script's output)
// ---------------------------------------------------------------------------

/** Shape written by scripts/measure_monthly.py. A bare MetricPoint[] is also
 *  accepted (hand-maintained files). */
export interface MeasurementFile {
  generated_at?: string
  points: MetricPoint[]
}

function isMetricKey(k: unknown): k is MetricKey {
  return typeof k === "string" && (METRIC_KEYS as string[]).includes(k)
}

function validPoint(p: unknown): p is MetricPoint {
  if (typeof p !== "object" || p === null) return false
  const q = p as Record<string, unknown>
  return (
    typeof q.at === "string" &&
    /^\d{4}-\d{2}(-\d{2})?$/.test(q.at) &&
    isMetricKey(q.metric) &&
    typeof q.value === "number" &&
    Number.isFinite(q.value) &&
    (q.note === undefined || typeof q.note === "string")
  )
}

/**
 * Parse a measurement file's text into validated MetricPoints. Throws with a
 * plain-language message on malformed input (shown verbatim in the UI); points
 * that fail validation are rejected loudly, not skipped silently.
 */
export function parseMeasurementJson(text: string): MetricPoint[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error("Not valid JSON.")
  }
  const arr = Array.isArray(data)
    ? data
    : typeof data === "object" && data !== null && Array.isArray((data as MeasurementFile).points)
      ? (data as MeasurementFile).points
      : null
  if (arr === null) {
    throw new Error("Expected a { points: [...] } object or a bare array of metric points.")
  }
  if (arr.length === 0) throw new Error("The file contains no metric points.")
  const bad = arr.findIndex((p) => !validPoint(p))
  if (bad !== -1) {
    throw new Error(
      `Point ${bad + 1} is malformed — need { at: "YYYY-MM[-DD]", metric: one of ${METRIC_KEYS.join("/")}, value: number }.`,
    )
  }
  return arr.map((p) => ({ at: p.at, metric: p.metric, value: p.value, ...(p.note ? { note: p.note } : {}) }))
}

export interface MergeResult {
  merged: MetricPoint[]
  added: number
  /** Same (at, metric) already present with a different value/note — the
   *  imported point supersedes it (removed + re-appended, so latestMetric
   *  reads the import). */
  replaced: number
  /** Identical points skipped (re-importing the same file is a no-op). */
  unchanged: number
}

/** Merge imported points into the store, keyed by (at, metric). */
export function mergeMetricPoints(existing: MetricPoint[], imported: MetricPoint[]): MergeResult {
  const merged = [...existing]
  let added = 0
  let replaced = 0
  let unchanged = 0
  for (const p of imported) {
    const i = merged.findIndex((e) => e.at === p.at && e.metric === p.metric)
    if (i === -1) {
      merged.push(p)
      added++
    } else if (merged[i].value === p.value && (merged[i].note ?? "") === (p.note ?? "")) {
      unchanged++
    } else {
      merged.splice(i, 1)
      merged.push(p)
      replaced++
    }
  }
  return { merged, added, replaced, unchanged }
}

// ---------------------------------------------------------------------------
// In-app pipeline run (spec 215 Tier 2 spawn) — pure helpers for the panel
// ---------------------------------------------------------------------------

/** Storage key for the persisted chess.com username the run form remembers. */
export const MEASURE_USER_KEY = "chessgui:training-measure-user"

/** Tail cap for the streamed run log kept in state (memory bound — the run
 *  emits one line per analyzed game; only the recent tail matters on screen). */
export const MEASURE_LOG_TAIL = 200

/** Human labels for the pipeline's `$ <cmd>` stage announcements (the script
 *  prints one per stage on stderr — see scripts/measure_monthly.py run()). */
const STAGE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["fetch_chesscom.py", "Fetching chess.com archives"],
  ["self_engage.py", "Filtering engaged games"],
  ["self_analyze.py", "Profiling games (endgames, flags)"],
  ["self_maia.py", "Maia policy matrix — the multi-minute lc0 stage"],
  ["self_stats.py", "Estimating rating"],
]

/** Stage label for a streamed line, or null when the line isn't a stage
 *  announcement (plain progress output). */
export function stageForLine(line: string): string | null {
  if (!line.startsWith("$ ")) return null
  for (const [pat, label] of STAGE_LABELS) {
    if (line.includes(pat)) return label
  }
  return null
}

/** Append one line to the run log, keeping only the last `cap` lines. */
export function appendLogLine(log: string[], line: string, cap: number = MEASURE_LOG_TAIL): string[] {
  const next = [...log, line]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/**
 * Status message for a finished run, or null when the run succeeded with a
 * readable metrics file — the caller then imports `metrics_json` and lets the
 * merge report speak instead.
 */
export function measureRunMessage(report: MeasureReport): string | null {
  if (report.cancelled) return "Measurement run cancelled — nothing imported."
  if (report.exit_code !== 0) {
    return `Pipeline failed (exit ${report.exit_code ?? "unknown"}) — see the run log.`
  }
  if (report.metrics_json == null) {
    return "Pipeline finished but the metrics file was unreadable — use Import measurements…."
  }
  return null
}

// ---------------------------------------------------------------------------
// In-app spar-score refresh
// ---------------------------------------------------------------------------

/** Local year-month (YYYY-MM) — the monthly measurement label. */
export function monthLabel(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

/**
 * The spar_score MetricPoint for the current month, computed from the stored
 * spar results. Null when no counting games exist in the window (nothing to
 * measure — the UI says so instead of writing a fake 0). Flagged games are
 * INCLUDED and the note says how many (flag, never drop).
 */
export function sparScorePoint(
  entries: SparResultEntry[],
  now: number = Date.now(),
): MetricPoint | null {
  const s = sparScore(entries, now)
  if (s.score === null) return null
  const flaggedNote = s.flagged > 0 ? `, ${s.flagged} flagged` : ""
  return {
    at: monthLabel(new Date(now)),
    metric: "spar_score",
    value: Math.round(s.score * 1000) / 1000,
    note: `from ${s.games} spar game${s.games === 1 ? "" : "s"}${flaggedNote}`,
  }
}

/**
 * The eg_conversion MetricPoint for the current month, computed from the
 * stored playout verdicts (lib/playout). Null when no counting win-claim
 * playouts exist in the window. The note carries provenance ("in-app
 * playouts") so it never masquerades as the monthly self-analysis pipeline's
 * number — merging is keyed by (at, metric), so whichever ran last for the
 * month wins, note attached. Flagged games are INCLUDED and counted in the
 * note (flag, never drop).
 */
export function egConversionPoint(
  entries: PlayoutResultEntry[],
  now: number = Date.now(),
): MetricPoint | null {
  const c = egConversion(entries, now)
  if (c.rate === null) return null
  const flaggedNote = c.flagged > 0 ? `, ${c.flagged} flagged` : ""
  return {
    at: monthLabel(new Date(now)),
    metric: "eg_conversion",
    value: Math.round(c.rate * 1000) / 1000,
    note: `from ${c.games} in-app playout${c.games === 1 ? "" : "s"}${flaggedNote}`,
  }
}

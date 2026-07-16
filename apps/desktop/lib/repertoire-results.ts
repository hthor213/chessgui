// Repertoire drill results store + spaced-repetition schedule (spec 900
// "Opening repertoire builder").
//
// This IS the "repertoire trainer schedule store" that spec 211's results
// module (lib/puzzle-results.ts) says failed rakes will one day ride; moving
// the rake ladder onto it stays future work — the two logs remain separate
// so neither migrates the other's history.
//
// Same private-local pattern as lib/puzzle-results.ts: every graded drill is
// appended to an attempt LOG in localStorage (never bundled, never
// committed), and everything else — per-card streak, due queue — is DERIVED
// from the log, so there is one source of truth and no state to migrate.
//
// Schedule: unlike avoidance puzzles (where a SOLVED puzzle graduates and
// only failures respawn), a repertoire card is reviewed forever — knowing
// your line IS the retained skill. Success walks a graduating ladder keyed
// by the current correct streak (1d, 3d, 7d, 16d, 35d, 90d and it stays at
// 90d); a failure makes the card due immediately, so it leads the very next
// deck — relearning a forgotten line shouldn't wait a day. Never-attempted
// cards are "new", not "due"; the deck builder (lib/repertoire.ts) draws
// them after the reviews.
//
// Identity: cards are keyed by their stable id, "rep:<color>:<normalized
// FEN>" (lib/repertoire.ts) — stable across repertoire rebuilds, so history
// survives a re-extraction. If a rebuild changes a position's expected move,
// the old streak carries over to the new move; first honest failure resets
// it, which is the behavior we want anyway.

import { getProviders } from "@/lib/platform"

export interface RepertoireResultEntry {
  /** Unique attempt id (timestamp + entropy). */
  id: string
  /** ISO datetime of the attempt. */
  at: string
  /** Stable card id ("rep:<color>:<fen key>", lib/repertoire.ts). */
  key: string
  correct: boolean
}

export const REPERTOIRE_RESULTS_STORAGE_KEY = "chessgui:repertoire-results"

/** Interval after the Nth consecutive success; sticks at the last rung. */
export const REVIEW_LADDER_DAYS = [1, 3, 7, 16, 35, 90] as const

const DAY_MS = 24 * 60 * 60 * 1000

/** Interval applied after a success that makes the streak `streak` (>= 1). */
export function reviewIntervalDays(streak: number): number {
  const idx = Math.min(Math.max(streak, 1), REVIEW_LADDER_DAYS.length) - 1
  return REVIEW_LADDER_DAYS[idx]
}

export function buildRepertoireResult(input: {
  key: string
  correct: boolean
  at?: string
}): RepertoireResultEntry {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: input.at ?? new Date().toISOString(),
    key: input.key,
    correct: input.correct,
  }
}

export function appendRepertoireResult(
  entries: RepertoireResultEntry[],
  entry: RepertoireResultEntry,
): RepertoireResultEntry[] {
  return [...entries, entry]
}

// ---------------------------------------------------------------------------
// Schedule (derived, never stored)
// ---------------------------------------------------------------------------

export interface CardSchedule {
  key: string
  /** Consecutive correct answers counting back from the latest attempt. */
  streak: number
  /** Lifetime attempts / correct (the setup screen's record line). */
  attempts: number
  correct: number
  /** Epoch ms of the latest attempt. */
  lastAt: number
  /** Epoch ms the card is next due. A failure is due immediately. */
  dueAt: number
}

/** Per-card schedule derived from the attempt log. Cards absent from the log
 *  have no schedule — they are "new" and the deck builder handles them. */
export function cardSchedules(
  entries: readonly RepertoireResultEntry[],
): Map<string, CardSchedule> {
  // The log is append-only and chronological, but sort defensively by time
  // so a merged/imported log still derives the right streaks.
  const byKey = new Map<string, RepertoireResultEntry[]>()
  for (const e of entries) {
    if (!Number.isFinite(Date.parse(e.at))) continue
    const list = byKey.get(e.key)
    if (list) list.push(e)
    else byKey.set(e.key, [e])
  }
  const schedules = new Map<string, CardSchedule>()
  for (const [key, list] of byKey) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    let streak = 0
    for (let i = list.length - 1; i >= 0 && list[i].correct; i--) streak++
    const last = list[list.length - 1]
    const lastAt = Date.parse(last.at)
    const dueAt = last.correct ? lastAt + reviewIntervalDays(streak) * DAY_MS : lastAt
    schedules.set(key, {
      key,
      streak,
      attempts: list.length,
      correct: list.filter((e) => e.correct).length,
      lastAt,
      dueAt,
    })
  }
  return schedules
}

/** Schedules due for review at `now`, longest-overdue first — that order IS
 *  the deck-draw priority (same convention as puzzle-results.dueRespawns). */
export function dueReviews(
  entries: readonly RepertoireResultEntry[],
  now: number = Date.now(),
): CardSchedule[] {
  return [...cardSchedules(entries).values()]
    .filter((s) => s.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt)
}

// ---------------------------------------------------------------------------
// StorageProvider glue (client-only; the provider absorbs unavailability)
// ---------------------------------------------------------------------------

export function loadRepertoireResults(): RepertoireResultEntry[] {
  try {
    const raw = getProviders().storage.get(REPERTOIRE_RESULTS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as RepertoireResultEntry[]) : []
  } catch {
    return []
  }
}

export function persistRepertoireResults(entries: RepertoireResultEntry[]): void {
  // Storage unavailable — entries stay in memory only.
  getProviders().storage.set(REPERTOIRE_RESULTS_STORAGE_KEY, JSON.stringify(entries))
}

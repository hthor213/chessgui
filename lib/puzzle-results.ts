// Avoidance-puzzle results store (spec 211 session-flow items: streak/score
// persistence + failed-puzzle respawn).
//
// Every graded answer is appended to an attempt LOG in localStorage — the
// same private-local pattern as lib/spar-results.ts (never bundled, never
// committed). Everything else (per-band record, due respawns) is DERIVED
// from the log, so there is one source of truth and no state to migrate.
//
// Spaced repetition: spec 211 says failed rakes "ride the same schedule
// store as the repertoire trainer (Phase 6 spec, to be written)" and names
// NO intervals. Until that store exists, this module uses an honest fixed
// ladder — 1d after the first failure, 3d after the second, 7d from the
// third on — chosen as the simplest schedule that spaces reviews out
// without pretending to be SM-2. A puzzle whose LAST attempt was solved is
// graduated (the spec asks that failed rakes come back, not that solved
// ones keep cycling). Failed calm positions respawn on the same ladder: a
// self-made rake is still a rake.
//
// Identity: rake puzzles are keyed by (fen, trap_uci) — the puzzles table's
// own dedup key, stable across DB rebuilds where row ids are not. The row id
// is stored alongside as a fetch handle and re-checked against the fen at
// respawn time. Calm positions carry their own stable string ids.

import { getProviders } from "@/lib/platform"
import type { GradeVerdict } from "@/lib/puzzles"

export type PuzzleKind = "rake" | "calm"

export interface PuzzleResultEntry {
  /** Unique attempt id (timestamp + entropy). */
  id: string
  /** ISO datetime of the attempt. */
  at: string
  /** Stable puzzle identity: "rake:<fen>|<trap_uci>" or the calm row id. */
  key: string
  kind: PuzzleKind
  band: string | null
  /** DB row id for rake puzzles (fetch handle, NOT identity); null for calm. */
  puzzleId: number | null
  /** FEN at attempt time — re-checked when a respawned row is refetched. */
  fen: string
  verdict: GradeVerdict
  correct: boolean
}

export const PUZZLE_RESULTS_STORAGE_KEY = "chessgui:puzzle-results"

export function rakeKey(fen: string, trapUci: string): string {
  return `rake:${fen}|${trapUci}`
}

export function buildPuzzleResult(input: {
  key: string
  kind: PuzzleKind
  band: string | null
  puzzleId: number | null
  fen: string
  verdict: GradeVerdict
  correct: boolean
  at?: string
}): PuzzleResultEntry {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: input.at ?? new Date().toISOString(),
    key: input.key,
    kind: input.kind,
    band: input.band,
    puzzleId: input.puzzleId,
    fen: input.fen,
    verdict: input.verdict,
    correct: input.correct,
  }
}

export function appendPuzzleResult(
  entries: PuzzleResultEntry[],
  entry: PuzzleResultEntry,
): PuzzleResultEntry[] {
  return [...entries, entry]
}

// ---------------------------------------------------------------------------
// Per-band record (the setup screen's stats row)
// ---------------------------------------------------------------------------

/** Recent-window size for the stats row — one week, the natural cadence of
 *  the Training tab's Mon/Thu rake_deck blocks. */
export const RECENT_WINDOW_DAYS = 7

export interface BandRecord {
  band: string
  attempted: number
  solved: number
  recentAttempted: number
  recentSolved: number
}

/** Solved/attempted per band, all-time + last RECENT_WINDOW_DAYS. Entries
 *  with no band land in a "?" bucket. Sorted by band label. */
export function bandRecords(
  entries: readonly PuzzleResultEntry[],
  now: number = Date.now(),
): BandRecord[] {
  const cutoff = now - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const byBand = new Map<string, BandRecord>()
  for (const e of entries) {
    const band = e.band ?? "?"
    let rec = byBand.get(band)
    if (!rec) {
      rec = { band, attempted: 0, solved: 0, recentAttempted: 0, recentSolved: 0 }
      byBand.set(band, rec)
    }
    rec.attempted++
    if (e.correct) rec.solved++
    const t = Date.parse(e.at)
    if (Number.isFinite(t) && t >= cutoff && t <= now) {
      rec.recentAttempted++
      if (e.correct) rec.recentSolved++
    }
  }
  return [...byBand.values()].sort((a, b) => a.band.localeCompare(b.band))
}

// ---------------------------------------------------------------------------
// Spaced-repetition respawn (derived, never stored)
// ---------------------------------------------------------------------------

/** Failure ladder in days: 1st fail → 1d, 2nd → 3d, 3rd+ → 7d. See the
 *  module header for why these numbers (spec 211 names none). */
export const RESPAWN_LADDER_DAYS = [1, 3, 7] as const

const DAY_MS = 24 * 60 * 60 * 1000

/** Interval applied after the `failCount`-th failure (failCount >= 1). */
export function respawnIntervalDays(failCount: number): number {
  const idx = Math.min(Math.max(failCount, 1), RESPAWN_LADDER_DAYS.length) - 1
  return RESPAWN_LADDER_DAYS[idx]
}

export interface Respawn {
  key: string
  kind: PuzzleKind
  band: string | null
  puzzleId: number | null
  fen: string
  /** Lifetime failures on this puzzle. */
  failCount: number
  /** Epoch ms the puzzle becomes due. */
  dueAt: number
}

/**
 * Puzzles due for review at `now`: last attempt failed, and the ladder
 * interval since that failure has elapsed. Sorted longest-overdue first —
 * that order IS the deck-draw priority. Not-yet-due failures are excluded
 * (they'll surface when their day comes), as are puzzles whose last attempt
 * was correct (graduated).
 */
export function dueRespawns(
  entries: readonly PuzzleResultEntry[],
  now: number = Date.now(),
): Respawn[] {
  type Acc = { last: PuzzleResultEntry; lastAt: number; fails: number }
  const byKey = new Map<string, Acc>()
  for (const e of entries) {
    const t = Date.parse(e.at)
    if (!Number.isFinite(t)) continue
    const acc = byKey.get(e.key)
    if (!acc) {
      byKey.set(e.key, { last: e, lastAt: t, fails: e.correct ? 0 : 1 })
    } else {
      if (!e.correct) acc.fails++
      if (t >= acc.lastAt) {
        acc.last = e
        acc.lastAt = t
      }
    }
  }
  const due: Respawn[] = []
  for (const { last, lastAt, fails } of byKey.values()) {
    if (last.correct) continue
    const dueAt = lastAt + respawnIntervalDays(fails) * DAY_MS
    if (dueAt > now) continue
    due.push({
      key: last.key,
      kind: last.kind,
      band: last.band,
      puzzleId: last.puzzleId,
      fen: last.fen,
      failCount: fails,
      dueAt,
    })
  }
  return due.sort((a, b) => a.dueAt - b.dueAt)
}

/** Lifetime failures recorded for `key` — feeds the "comes back in Nd"
 *  message after a fail. */
export function failCountFor(entries: readonly PuzzleResultEntry[], key: string): number {
  let n = 0
  for (const e of entries) if (e.key === key && !e.correct) n++
  return n
}

// ---------------------------------------------------------------------------
// StorageProvider glue (client-only; the provider absorbs unavailability)
// ---------------------------------------------------------------------------

export function loadPuzzleResults(): PuzzleResultEntry[] {
  try {
    const raw = getProviders().storage.get(PUZZLE_RESULTS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as PuzzleResultEntry[]) : []
  } catch {
    return []
  }
}

export function persistPuzzleResults(entries: PuzzleResultEntry[]): void {
  // Storage unavailable — entries stay in memory only.
  getProviders().storage.set(PUZZLE_RESULTS_STORAGE_KEY, JSON.stringify(entries))
}

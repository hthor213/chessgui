// Spar-results persistence (spec 215, Tier 1).
//
// Every COMPLETED Play-vs-Bot game (a real result: checkmate, stalemate,
// resignation, agreed/forced draw) is stored locally with its declared intent:
// serious games count toward training by default, probe games are stored
// flagged and NEVER count (spec 215 Tier 1; spec 214: probe aborts record
// nothing at all — an aborted probe never reaches this module).
//
// Honest-by-design rule (spec 215, from the first live spar): anomaly
// detection may FLAG a game for reclassification but never silently excludes.
// Flagged games stay in the score until the user reclassifies them; the flags
// are shown next to the number they feed.
//
// Storage is localStorage (private data, never bundled/committed), matching
// the sibling spar stores (persona feedback + decision log in spar-tab) and
// the Training tab's metrics. Pure helpers below are SSR-safe; only
// loadSparResults/persistSparResults touch localStorage, guarded.

import { getProviders } from "@/lib/platform"
import type { SparColor } from "@/lib/spar"

export type SparResultOutcome = "win" | "loss" | "draw"
export type SparResultMode = "serious" | "probe"

/** Anomaly flags — reasons a game might not belong in the rating signal.
 *  Pace/eval anomalies proper need clocks / an evaluator the spar loop doesn't
 *  have yet (v1 spar is unclocked); until then the honest proxies are
 *  game-length signals. Never used to exclude — only to flag. */
export type SparAnomalyFlag = "short_game" | "early_resign"

/** Decisive games shorter than this many plies get flagged `short_game`
 *  (probe-shaped: real games at these levels essentially never end that fast). */
export const SHORT_GAME_PLIES = 12
/** Resignations before this many plies get flagged `early_resign`
 *  (a drive-by resign, not a fought game). */
export const EARLY_RESIGN_PLIES = 16

export interface SparResultEntry {
  /** Unique id (timestamp + entropy) — the reclassification handle. */
  id: string
  /** ISO datetime the game ended. */
  at: string
  opponent: string
  level: number
  mode: SparResultMode
  userColor: SparColor
  result: SparResultOutcome
  /** The UI's own end label, verbatim (e.g. "Checkmate — White wins"). */
  resultLabel: string
  plies: number
  /** Declared intent: does this game feed the training metrics? Serious games
   *  default true; probe games are always false and can never be flipped. */
  countsTowardTraining: boolean
  /** Time control the game was played at ("10+5", spec 215) — absent on
   *  unclocked games and on every pre-clock entry. Training aggregates
   *  filter on this string. */
  timeControl?: string
  /** Anomaly flags — shown, never silently acted on. Empty = clean. */
  anomalyFlags: SparAnomalyFlag[]
  /** Set when the user manually reclassified countsTowardTraining. */
  reclassifiedAt?: string
}

export const SPAR_RESULTS_STORAGE_KEY = "chessgui:spar-results"

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

/**
 * Map the spar screen's end label to the USER's outcome. Labels covered are
 * exactly the ones the spar screen produces: sparStatus() checkmate/stalemate/
 * insufficient/draw labels, plus the manual ends ("You resigned — 0-1",
 * "Draw agreed — ½–½"). Unknown labels return null (nothing is recorded —
 * better no data than wrong data).
 */
export function resultFromLabel(label: string, userColor: SparColor): SparResultOutcome | null {
  if (/resigned/i.test(label)) return "loss"
  if (/white wins/i.test(label)) return userColor === "white" ? "win" : "loss"
  if (/black wins/i.test(label)) return userColor === "black" ? "win" : "loss"
  if (/draw/i.test(label)) return "draw"
  return null
}

// ---------------------------------------------------------------------------
// Anomaly flagging (flag, never drop)
// ---------------------------------------------------------------------------

export function detectAnomalies(input: {
  result: SparResultOutcome
  resultLabel: string
  plies: number
}): SparAnomalyFlag[] {
  const flags: SparAnomalyFlag[] = []
  if (input.result !== "draw" && input.plies < SHORT_GAME_PLIES) flags.push("short_game")
  if (/resigned/i.test(input.resultLabel) && input.plies < EARLY_RESIGN_PLIES) {
    flags.push("early_resign")
  }
  return flags
}

export const ANOMALY_LABELS: Record<SparAnomalyFlag, string> = {
  short_game: "very short game",
  early_resign: "early resignation",
}

// ---------------------------------------------------------------------------
// Entry construction + store operations (pure — callers persist)
// ---------------------------------------------------------------------------

export function buildSparResult(input: {
  opponent: string
  level: number
  mode: SparResultMode
  userColor: SparColor
  resultLabel: string
  plies: number
  at?: string
  /** Explicit per-game intent (the SparConfig screen's "Counts toward
   *  training" toggle). Omitted = the old implicit default (serious counts,
   *  probe doesn't). A probe game is ALWAYS forced false regardless of this
   *  value — spec 215 "probe never counts" is not overridable at record time
   *  (matches setCountsToward's same refusal at reclassify time). */
  countsTowardTraining?: boolean
  /** The game's TC string ("10+5"); null/omitted = unclocked, not stored. */
  timeControl?: string | null
}): SparResultEntry | null {
  const result = resultFromLabel(input.resultLabel, input.userColor)
  if (result === null) return null
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: input.at ?? new Date().toISOString(),
    opponent: input.opponent,
    level: input.level,
    mode: input.mode,
    userColor: input.userColor,
    result,
    resultLabel: input.resultLabel,
    plies: input.plies,
    // Declared intent: serious counts by default (or the explicit toggle
    // value, if given); probe never counts, no matter what was passed.
    countsTowardTraining: input.mode === "serious" ? (input.countsTowardTraining ?? true) : false,
    anomalyFlags: detectAnomalies({ result, resultLabel: input.resultLabel, plies: input.plies }),
    ...(input.timeControl ? { timeControl: input.timeControl } : {}),
  }
}

export function appendSparResult(entries: SparResultEntry[], entry: SparResultEntry): SparResultEntry[] {
  return [...entries, entry]
}

export function removeSparResult(entries: SparResultEntry[], id: string): SparResultEntry[] {
  return entries.filter((e) => e.id !== id)
}

/**
 * Reclassify one game's counts-toward-training intent. Probe games can never
 * be flipped to counting (spec 215: "probe never counts") — the call is a
 * no-op for them.
 */
export function setCountsToward(
  entries: SparResultEntry[],
  id: string,
  counts: boolean,
  at: string = new Date().toISOString(),
): SparResultEntry[] {
  return entries.map((e) => {
    if (e.id !== id) return e
    if (e.mode === "probe" && counts) return e
    if (e.countsTowardTraining === counts) return e
    return { ...e, countsTowardTraining: counts, reclassifiedAt: at }
  })
}

// ---------------------------------------------------------------------------
// The spar_score metric (feeds the Training tab measurement panel)
// ---------------------------------------------------------------------------

/** Rolling window the spar score is computed over. Monthly cadence, doubled
 *  for sample size — the note on the metric point states the window. */
export const SPAR_SCORE_WINDOW_DAYS = 60

export interface SparScore {
  /** Expected-score-style fraction in [0,1], or null with no counting games. */
  score: number | null
  /** Counting games in the window (serious + countsTowardTraining). */
  games: number
  /** Of those, how many carry anomaly flags (INCLUDED in score — flag, don't drop). */
  flagged: number
}

export function sparScore(
  entries: SparResultEntry[],
  now: number = Date.now(),
  windowDays: number = SPAR_SCORE_WINDOW_DAYS,
): SparScore {
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000
  let w = 0
  let d = 0
  let n = 0
  let flagged = 0
  for (const e of entries) {
    if (e.mode !== "serious" || !e.countsTowardTraining) continue
    const t = Date.parse(e.at)
    if (!Number.isFinite(t) || t < cutoff || t > now) continue
    n++
    if (e.anomalyFlags.length > 0) flagged++
    if (e.result === "win") w++
    else if (e.result === "draw") d++
  }
  return { score: n > 0 ? (w + d / 2) / n : null, games: n, flagged }
}

// ---------------------------------------------------------------------------
// StorageProvider glue (client-only; the provider absorbs unavailability)
// ---------------------------------------------------------------------------

export function loadSparResults(): SparResultEntry[] {
  try {
    const raw = getProviders().storage.get(SPAR_RESULTS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as SparResultEntry[]) : []
  } catch {
    return []
  }
}

export function persistSparResults(entries: SparResultEntry[]): void {
  // Storage unavailable — entries stay in memory only.
  getProviders().storage.set(SPAR_RESULTS_STORAGE_KEY, JSON.stringify(entries))
}

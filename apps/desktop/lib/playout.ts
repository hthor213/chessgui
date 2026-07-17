// "Play it out" — conversion scoring for played-out positions (spec 211
// checklist item; unblocks spec 215 Tier 1 `endgame_playout`).
//
// From a calibration reveal (and, hook-ready, a future 211 puzzle) the user
// plays the position to a result against a Maia band. The user plays the side
// whose eval claim is being tested — the side the engine says is better — and
// at game end the result is compared to what the eval claimed via the
// eval->win-prob curve (lib/win-prob): converted / held / dropped.
//
// Perceiving +2 and converting +2 are different skills (spec 213's
// perception-vs-conversion gap, as a training loop — spec 211 "Play it out").
//
// Storage is its own localStorage store (PLAYOUT_STORAGE_KEY), a sibling of
// lib/spar-results — a DISTINCT entry kind, never mixed into spar results
// (spec 215 Tier 1 coordination note: don't overload spar results silently).
// Pure helpers throughout; only loadPlayoutResults/persistPlayoutResults touch
// localStorage, guarded, like the sibling stores.

import {
  DEFAULT_LOGISTIC_K,
  winProb,
  type WinProbCurve,
} from "@chessgui/core/win-prob"
import { MATE_EVAL_PAWNS } from "@chessgui/core/tournament"
import { getProviders } from "@/lib/platform"
import {
  detectAnomalies,
  resultFromLabel,
  type SparAnomalyFlag,
  type SparResultMode,
  type SparResultOutcome,
} from "@/lib/spar-results"
import type { SparColor } from "@/lib/spar"

// ---------------------------------------------------------------------------
// The claim: eval -> expected score for the side being tested
// ---------------------------------------------------------------------------

/**
 * The curve the verdict is judged against: the pure logistic at the default
 * slope (0.4/pawn). No lab probability map applies here — the engine-lab
 * anchors (spec 212) describe engine-vs-engine conversion at engine TCs, not
 * a human converting vs a Maia band, so the honest choice is the documented
 * fallback shape rather than borrowing anchors measured on a different
 * population. Revisit once playout results themselves are numerous enough to
 * fit a human curve.
 */
export const PLAYOUT_CURVE: WinProbCurve = {
  anchors: [],
  k: DEFAULT_LOGISTIC_K,
  source: "logistic-default",
}

/** Eval in White-POV pawns from a calibration position's ground truth: cp/100,
 *  or a mate pinned to ±MATE_EVAL_PAWNS by its sign (the same pinning
 *  lib/tournament's plyEvalPawns applies). 0 when both are null (malformed). */
export function evalPawnsOf(sfCp: number | null, sfMate: number | null): number {
  if (sfMate != null) return (sfMate >= 0 ? 1 : -1) * MATE_EVAL_PAWNS
  return (sfCp ?? 0) / 100
}

/**
 * The side the user plays: the side the eval claim favours — converting the
 * advantage IS the exercise. A dead-level claim (eval exactly 0) has no
 * favoured side; the side to move plays it (holding a level position as the
 * mover is the natural reading of "test the claim" there).
 */
export function playoutUserSide(evalPawns: number, toMove: SparColor): SparColor {
  if (evalPawns > 0) return "white"
  if (evalPawns < 0) return "black"
  return toMove
}

/** Expected score in [0,1] for `side`, from a White-POV eval via the curve. */
export function expectedScoreFor(evalPawns: number, side: SparColor): number {
  const white = winProb(PLAYOUT_CURVE, evalPawns)
  return side === "white" ? white : 1 - white
}

/**
 * Expected score at or above which the claim is "this is a WIN" (score 1);
 * below it the claim is "this holds" (score ½). At the default slope 0.6
 * corresponds to about +1.0 for the favoured side, so the conversion decks
 * (+1.5 to +3) claim wins and the level deck (±0.5) claims draws. A design
 * choice — spec 211 names the mechanic but not the cut — so the threshold is
 * exported, and every stored entry carries the raw expected score so the
 * semantics can be re-derived if the cut moves.
 */
export const CLAIM_WIN_PROB = 0.6

/** What the eval claims for the user's side. Never "loss": the user plays the
 *  FAVOURED side by construction, so expected ≥ 0.5 up to curve symmetry. */
export type PlayoutClaim = "win" | "draw"

export function claimFor(expected: number): PlayoutClaim {
  return expected >= CLAIM_WIN_PROB ? "win" : "draw"
}

/** The score the claim asserts: win → 1, draw(hold) → ½. */
export function claimedScore(claim: PlayoutClaim): number {
  return claim === "win" ? 1 : 0.5
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * converted — the result met (or beat) what the eval claimed;
 * held      — half a point short of a claimed win (drew a winning position:
 *             didn't convert, didn't lose the thread entirely);
 * dropped   — lost, from any claim (a loss always drops the claim);
 * abandoned — exited mid-game, no result (spec 215 playout hardening: an
 *             invisible abandon would let hard games vanish from the record).
 *             Stored for visibility only — never conversion evidence.
 */
export type PlayoutVerdict = "converted" | "held" | "dropped" | "abandoned"

export function playoutVerdict(claim: PlayoutClaim, actualScore: number): PlayoutVerdict {
  if (actualScore >= claimedScore(claim)) return "converted"
  if (actualScore === 0.5) return "held"
  return "dropped"
}

export const VERDICT_LABELS: Record<PlayoutVerdict, string> = {
  converted: "Converted",
  held: "Held",
  dropped: "Dropped",
  abandoned: "Abandoned",
}

/** win → 1, draw → ½, loss → 0. */
export function outcomeScore(result: SparResultOutcome): number {
  return result === "win" ? 1 : result === "draw" ? 0.5 : 0
}

// ---------------------------------------------------------------------------
// Launch plumbing (calibration reveal / training exercise / future puzzle)
// ---------------------------------------------------------------------------

/** Where a playout was launched from. "puzzle" is hook-ready for spec 211's
 *  solver — nothing constructs it yet. */
export type PlayoutSourceKind = "calibration" | "training" | "puzzle"

/** Everything the playout screen needs to start a game. Constructed by the
 *  launching surface (calibration reveal, training exercise, future puzzle). */
export interface PlayoutRequest {
  fen: string
  /** The eval claim being tested, White-POV pawns. */
  evalPawns: number
  source: PlayoutSourceKind
  /** Context shown in the header (deck name, curated-position name), if any. */
  label?: string
  /** Default Maia band; the user can change it pre-game. */
  defaultLevel?: number
  /** Stable id of the launch position (deck slot id, calibration
   *  game_id:ply), when the surface has one — carried onto stored entries. */
  positionId?: string
}

export const DEFAULT_PLAYOUT_LEVEL = 1700

/**
 * Default opponent band from a calibration position's source-game Elo band —
 * "default level from the position's band": the strength the claim lived at,
 * clamped into the published Maia set (1100–1900). Band midpoints, with the
 * open ends pinned to the nearest playable band.
 */
export function levelForEloBand(eloBand: string): number {
  switch (eloBand) {
    case "<1600":
      return 1500
    case "1600-2000":
      return 1800
    case "2000-2400":
    case "2400+":
      return 1900
    default:
      return DEFAULT_PLAYOUT_LEVEL
  }
}

// ---------------------------------------------------------------------------
// Curated training deck (spec 215 endgame_playout, v1)
// ---------------------------------------------------------------------------

/** One curated conversion position. Evals are stated approximations over
 *  theory-won material situations (a rook up, K+R vs K, connected passers vs
 *  bare king), NOT engine measurements — honest for a claim that is a win by
 *  theory either way. Replaced by mined positions once the 211 Tier-1
 *  generator lands. */
export interface PlayoutDeckPosition {
  id: string
  name: string
  fen: string
  /** White-POV pawns, approximate (see above). */
  evalPawns: number
}

export const TRAINING_PLAYOUT_DECK: PlayoutDeckPosition[] = [
  {
    id: "kr-vs-k",
    name: "K+R vs K — box the king",
    fen: "8/8/4k3/8/4K3/8/3R4/8 w - - 0 1",
    evalPawns: 6.5,
  },
  {
    id: "rook-up-endgame",
    name: "A clean rook up",
    fen: "8/8/4kp2/8/8/4K3/4P3/4R3 w - - 0 1",
    evalPawns: 5,
  },
  {
    id: "connected-passers",
    name: "Connected passers vs bare king",
    fen: "8/5k2/8/8/8/4PP2/4K3/8 w - - 0 1",
    evalPawns: 4,
  },
]

/** A PlayoutRequest for one training-deck position, picked uniformly. */
export function pickTrainingPlayout(random: () => number = Math.random): PlayoutRequest {
  const pos = TRAINING_PLAYOUT_DECK[Math.floor(random() * TRAINING_PLAYOUT_DECK.length)]
  return {
    fen: pos.fen,
    evalPawns: pos.evalPawns,
    source: "training",
    label: pos.name,
    defaultLevel: DEFAULT_PLAYOUT_LEVEL,
    positionId: pos.id,
  }
}

// ---------------------------------------------------------------------------
// Result entries + store (sibling of lib/spar-results, distinct kind)
// ---------------------------------------------------------------------------

export interface PlayoutResultEntry {
  /** Unique id (timestamp + entropy) — the reclassification handle. */
  id: string
  /** ISO datetime the game ended. */
  at: string
  /** Distinct entry kind — this store never mixes with spar results. */
  kind: "playout"
  source: PlayoutSourceKind
  /** Declared intent, the spar template (spec 215 Tier 1): serious playouts
   *  feed eg_conversion by default; probe playouts are stored flagged and
   *  NEVER count. */
  mode: SparResultMode
  /** The start position played out. */
  fen: string
  /** Stable id of the launch position, when the request carried one. */
  positionId?: string
  /** The claim tested, White-POV pawns. */
  evalPawns: number
  userSide: SparColor
  /** Maia band played against. */
  level: number
  /** Expected score for the user's side under PLAYOUT_CURVE, at record time. */
  expectedScore: number
  claim: PlayoutClaim
  /** null on an abandoned playout — there is no result to score. */
  result: SparResultOutcome | null
  /** The playout screen's own end label, verbatim. */
  resultLabel: string
  /** null on an abandoned playout. */
  actualScore: number | null
  verdict: PlayoutVerdict
  plies: number
  /** Wall-clock ms from game start to the recorded end; only abandons carry
   *  it today (finished games predate the field). */
  elapsedMs?: number
  /** Serious playouts count by default; probe never counts and can never be
   *  flipped on (same rule as spar results). */
  countsTowardTraining: boolean
  /** Anomaly flags (shared spar proxies: short game / early resign) — shown
   *  next to the number they feed, never used to exclude. */
  anomalyFlags: SparAnomalyFlag[]
  /** Set when the user manually reclassified countsTowardTraining. */
  reclassifiedAt?: string
}

export const PLAYOUT_STORAGE_KEY = "chessgui:playout-results"

/** Unique entry id (timestamp + entropy) — the reclassification handle. */
function newEntryId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Build the stored entry for a finished playout. Reuses the spar screens'
 * label→outcome parsing (identical labels: both loops end via sparStatus plus
 * the same manual ends). Unknown labels return null — nothing is recorded
 * rather than a guessed verdict.
 */
export function buildPlayoutResult(input: {
  source: PlayoutSourceKind
  fen: string
  positionId?: string
  evalPawns: number
  userSide: SparColor
  level: number
  mode: SparResultMode
  resultLabel: string
  plies: number
  at?: string
  /** Explicit per-game intent (the playout config's "Counts toward training"
   *  toggle). Omitted = serious counts, probe doesn't. A probe playout is
   *  ALWAYS forced false — spec 215 "probe never counts" is not overridable
   *  at record time (same refusal as buildSparResult). */
  countsTowardTraining?: boolean
}): PlayoutResultEntry | null {
  const result = resultFromLabel(input.resultLabel, input.userSide)
  if (result === null) return null
  const expected = expectedScoreFor(input.evalPawns, input.userSide)
  const claim = claimFor(expected)
  const actual = outcomeScore(result)
  return {
    id: newEntryId(),
    at: input.at ?? new Date().toISOString(),
    kind: "playout",
    source: input.source,
    mode: input.mode,
    fen: input.fen,
    positionId: input.positionId,
    evalPawns: input.evalPawns,
    userSide: input.userSide,
    level: input.level,
    expectedScore: expected,
    claim,
    result,
    resultLabel: input.resultLabel,
    actualScore: actual,
    verdict: playoutVerdict(claim, actual),
    plies: input.plies,
    countsTowardTraining: input.mode === "serious" ? (input.countsTowardTraining ?? true) : false,
    anomalyFlags: detectAnomalies({ result, resultLabel: input.resultLabel, plies: input.plies }),
  }
}

/** The verbatim label an abandon entry carries — a manual exit, not a game
 *  end, so it deliberately parses to no SparResultOutcome. */
export const ABANDON_RESULT_LABEL = "Abandoned — exited mid-game"

/**
 * Build the stored entry for a mid-playout abandon (spec 215 playout
 * hardening: Exit-without-result must stay visible in the record, not vanish).
 * No result exists, so result/actualScore are null and countsTowardTraining is
 * ALWAYS false — an abandon is never conversion evidence and must not touch
 * eg_conversion either way.
 */
export function buildPlayoutAbandon(input: {
  source: PlayoutSourceKind
  fen: string
  positionId?: string
  evalPawns: number
  userSide: SparColor
  level: number
  mode: SparResultMode
  /** Plies played (both sides) before the exit. */
  plies: number
  /** Wall-clock ms the playout ran before the exit. */
  elapsedMs: number
  at?: string
}): PlayoutResultEntry {
  const expected = expectedScoreFor(input.evalPawns, input.userSide)
  return {
    id: newEntryId(),
    at: input.at ?? new Date().toISOString(),
    kind: "playout",
    source: input.source,
    mode: input.mode,
    fen: input.fen,
    positionId: input.positionId,
    evalPawns: input.evalPawns,
    userSide: input.userSide,
    level: input.level,
    expectedScore: expected,
    claim: claimFor(expected),
    result: null,
    resultLabel: ABANDON_RESULT_LABEL,
    actualScore: null,
    verdict: "abandoned",
    plies: input.plies,
    elapsedMs: input.elapsedMs,
    countsTowardTraining: false,
    anomalyFlags: [],
  }
}

export function appendPlayoutResult(
  entries: PlayoutResultEntry[],
  entry: PlayoutResultEntry,
): PlayoutResultEntry[] {
  return [...entries, entry]
}

export function removePlayoutResult(entries: PlayoutResultEntry[], id: string): PlayoutResultEntry[] {
  return entries.filter((e) => e.id !== id)
}

/**
 * Reclassify one playout's counts-toward-training intent. Probe playouts can
 * never be flipped to counting (spec 215: "probe never counts"), and neither
 * can abandons (no result — nothing to count) — the call is a no-op for both.
 * Mirrors lib/spar-results' setCountsToward.
 */
export function setPlayoutCountsToward(
  entries: PlayoutResultEntry[],
  id: string,
  counts: boolean,
  at: string = new Date().toISOString(),
): PlayoutResultEntry[] {
  return entries.map((e) => {
    if (e.id !== id) return e
    if ((e.mode === "probe" || e.verdict === "abandoned") && counts) return e
    if (e.countsTowardTraining === counts) return e
    return { ...e, countsTowardTraining: counts, reclassifiedAt: at }
  })
}

// ---------------------------------------------------------------------------
// The eg_conversion metric (feeds the Training tab measurement panel)
// ---------------------------------------------------------------------------

/** Rolling window the in-app conversion rate is computed over — same monthly
 *  cadence doubled for sample size as the spar score. */
export const EG_CONVERSION_WINDOW_DAYS = 60

export interface EgConversion {
  /** converted / games over the counting win-claim playouts, or null with
   *  nothing to measure. */
  rate: number | null
  /** Counting playouts in the window (serious + countsTowardTraining +
   *  win claim — hold-claim playouts test defence, not conversion). */
  games: number
  converted: number
  held: number
  dropped: number
  /** Of the counting games, how many carry anomaly flags (INCLUDED in the
   *  rate — flag, don't drop). */
  flagged: number
}

/**
 * The in-app endgame-conversion rate: over the last `windowDays`, the fraction
 * of counting WIN-claim playouts the user actually converted. Hold-claim
 * playouts (level positions) are excluded — holding a draw is a different
 * skill than the conversion this metric measures, and the monthly pipeline's
 * eg_conversion counts won positions only. Probe / unticked games never count;
 * abandons never count regardless of flags (no result — not conversion
 * evidence in either direction); flagged games count and are reported.
 */
export function egConversion(
  entries: PlayoutResultEntry[],
  now: number = Date.now(),
  windowDays: number = EG_CONVERSION_WINDOW_DAYS,
): EgConversion {
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000
  let converted = 0
  let held = 0
  let dropped = 0
  let flagged = 0
  for (const e of entries) {
    if (e.verdict === "abandoned") continue // structural: no result to aggregate
    if (e.mode !== "serious" || !e.countsTowardTraining) continue
    if (e.claim !== "win") continue
    const t = Date.parse(e.at)
    if (!Number.isFinite(t) || t < cutoff || t > now) continue
    if (e.anomalyFlags.length > 0) flagged++
    if (e.verdict === "converted") converted++
    else if (e.verdict === "held") held++
    else dropped++
  }
  const games = converted + held + dropped
  return { rate: games > 0 ? converted / games : null, games, converted, held, dropped, flagged }
}

/**
 * Backfill the declared-intent fields on entries stored before they existed.
 * Legacy playouts were all played straight (there was no probe mode to pick),
 * so serious + counting is the honest reading; anomaly flags are recomputed
 * from the stored result fields, which detectAnomalies is pure over.
 */
export function normalizePlayoutResult(
  e: Omit<PlayoutResultEntry, "mode" | "countsTowardTraining" | "anomalyFlags"> &
    Partial<Pick<PlayoutResultEntry, "mode" | "countsTowardTraining" | "anomalyFlags">>,
): PlayoutResultEntry {
  const mode = e.mode ?? "serious"
  return {
    ...e,
    mode,
    countsTowardTraining:
      mode === "serious" ? (e.countsTowardTraining ?? true) : false,
    anomalyFlags:
      e.anomalyFlags ??
      // e.result is null only on abandons, which always carry flags already —
      // but stay honest for hand-edited stores: no result, no anomaly proxies.
      (e.result == null
        ? []
        : detectAnomalies({ result: e.result, resultLabel: e.resultLabel, plies: e.plies })),
  }
}

// StorageProvider glue (client-only; the provider absorbs unavailability).

export function loadPlayoutResults(): PlayoutResultEntry[] {
  try {
    const raw = getProviders().storage.get(PLAYOUT_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? (parsed as PlayoutResultEntry[]).map(normalizePlayoutResult)
      : []
  } catch {
    return []
  }
}

export function persistPlayoutResults(entries: PlayoutResultEntry[]): void {
  // Storage unavailable — entries stay in memory only.
  getProviders().storage.set(PLAYOUT_STORAGE_KEY, JSON.stringify(entries))
}

// Labeler profile + adaptive elicitation (spec 213, Phases A and B).
//
// Design doc §6.1: a label is only usable if we know who produced it — "a
// ~1300 with a 1500-ish endgame perceived this as +1.2" is data; an anonymous
// "+1.2" is not. So a session opens with a brief lock-in burst (~10–20
// positions) that pins the labeler's per-phase profile just tightly enough for
// their answers to read as a known-level human's perception. Previously saved
// sessions are the prior, so returning users skip most (or all) of it.
//
// Both phases only REORDER the already-sampled session — deterministically,
// no RNG; neither draws new positions. Phase A's plan is a pure function of
// (sampled order, prior profile). Phase B (the section at the bottom) takes
// over after the burst: now that the tier-1 evaluator exists, every next slot
// is filled by model need — evaluator-variant disagreement + coverage
// sparsity — instead of the sampled order.
//
// Pure functions, no React or Tauri — unit-tested in
// __tests__/calibration-profile.test.ts.

import { normalizeAnswer, MIN_PHASE_N } from "./calibration"
import type {
  CalibrationAnswer,
  CalibrationPosition,
  CalibrationResults,
  CalibrationSession,
  LabelerProfile,
} from "./calibration"
import { BANDS, PHASES, scoredAnswers, type Scored } from "./calibration-stats"
import type { HumanTreeOptions } from "@chessgui/core/human-eval-tree-types"

/** Answers per phase at which that phase of the profile counts as pinned.
 *  Reuses MIN_PHASE_N (=8), the existing "fewer than this is too thin to read"
 *  threshold from the per-phase results table — same evidential bar, one
 *  constant. A fresh user therefore gets an 8+8 = 16-position burst, inside
 *  the spec's "~10–20 positions" band. */
export const PROFILE_LOCK_N = MIN_PHASE_N

/** Hard ceiling on the lock-in burst — the spec's "~10–20 positions" upper
 *  bound. With the current two-phase vector the fresh-user burst is 16, so the
 *  cap only binds if the profile ever grows more dimensions. */
export const LOCK_IN_CAP = 20

/** Signed eval error of one scored answer: user assertion − Stockfish, pawns
 *  (+ = the user leaned more White than the engine). Range answers are signed
 *  distance to the violated edge, 0 inside — mirroring `rangeError`. */
export function signedError(s: Scored): number {
  if (s.userRange) {
    const { lo, hi } = s.userRange
    if (lo != null && s.sfEval < lo) return lo - s.sfEval
    if (hi != null && s.sfEval > hi) return -(s.sfEval - hi)
    return 0
  }
  return s.userEval - s.sfEval
}

/** A profile with nothing in it (fresh labeler). */
export function emptyProfile(): LabelerProfile {
  return {
    sessions: 0,
    answers: 0,
    bias: null,
    sd: null,
    per_phase: PHASES.map((phase) => ({ phase, count: 0, mae: null, bias: null })),
  }
}

function meanOf(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

/** The profile evidenced by a single session's answers. */
export function profileOfSession(
  session: CalibrationSession,
  answers: CalibrationAnswer[],
): LabelerProfile {
  const scored = scoredAnswers(session, answers)
  const signed = scored.map(signedError)
  const bias = meanOf(signed)
  const sd =
    bias == null
      ? null
      : Math.sqrt(signed.reduce((a, e) => a + (e - bias) * (e - bias), 0) / signed.length)
  return {
    sessions: 1,
    answers: scored.length,
    bias,
    sd,
    per_phase: PHASES.map((phase) => {
      const inPhase = scored.filter((s) => s.pos.phase === phase)
      return {
        phase,
        count: inPhase.length,
        mae: meanOf(inPhase.map((s) => s.absError)),
        bias: meanOf(inPhase.map(signedError)),
      }
    }),
  }
}

/** Weighted-mean merge; exact — merging per-session profiles equals computing
 *  over the concatenated answers. */
function mergeMean(na: number, ma: number | null, nb: number, mb: number | null): number | null {
  const n = na + nb
  if (n === 0) return null
  return ((ma ?? 0) * na + (mb ?? 0) * nb) / n
}

/** Merge two profiles exactly (Chan's parallel formula for the pooled sd, so
 *  no raw answers need to be kept around to fold a new session in). */
export function mergeProfiles(a: LabelerProfile, b: LabelerProfile): LabelerProfile {
  const n = a.answers + b.answers
  let sd: number | null = null
  if (n > 0) {
    const m2a = (a.sd ?? 0) * (a.sd ?? 0) * a.answers
    const m2b = (b.sd ?? 0) * (b.sd ?? 0) * b.answers
    const delta = (b.bias ?? 0) - (a.bias ?? 0)
    sd = Math.sqrt((m2a + m2b + (delta * delta * a.answers * b.answers) / n) / n)
  }
  return {
    sessions: a.sessions + b.sessions,
    answers: n,
    bias: mergeMean(a.answers, a.bias, b.answers, b.bias),
    sd,
    per_phase: PHASES.map((phase) => {
      const ca = a.per_phase.find((c) => c.phase === phase) ?? { phase, count: 0, mae: null, bias: null }
      const cb = b.per_phase.find((c) => c.phase === phase) ?? { phase, count: 0, mae: null, bias: null }
      return {
        phase,
        count: ca.count + cb.count,
        mae: mergeMean(ca.count, ca.mae, cb.count, cb.mae),
        bias: mergeMean(ca.count, ca.bias, cb.count, cb.bias),
      }
    }),
  }
}

/** Whether a stored results file was a reveal session. Blind
 *  (show_reveal=false) sessions are methodologically distinct — no feedback
 *  between positions (docs/research/calibration-data-format.md) — so
 *  cross-session aggregates must never mix the two modes. Files that predate
 *  the flag were all reveal sessions. */
export function isRevealResults(r: CalibrationResults): boolean {
  return r.show_reveal !== false
}

/** Fold every saved results file into one profile, oldest first. Tolerates the
 *  full history: v1 point sessions, pre-think_ms answers (normalized in), and
 *  malformed entries (skipped — a damaged artifact degrades the prior, it
 *  never blocks a session). Returns null when nothing usable exists, so a
 *  fresh labeler is distinguishable from an all-miss one.
 *
 *  `showReveal` given ⇒ only sessions of that reveal mode are folded (the
 *  blind/reveal split above); omitted keeps the historical pool-everything
 *  behavior for callers that want the raw union. */
export function buildProfileFromResults(
  results: CalibrationResults[],
  showReveal?: boolean,
): LabelerProfile | null {
  const usable = results.filter(
    (r) =>
      r != null &&
      typeof r === "object" &&
      r.session?.positions != null &&
      Array.isArray(r.answers) &&
      (showReveal === undefined || isRevealResults(r) === showReveal),
  )
  if (usable.length === 0) return null
  return usable.reduce(
    (acc, r) => mergeProfiles(acc, profileOfSession(r.session, r.answers.map(normalizeAnswer))),
    emptyProfile(),
  )
}

/** How many more answers each phase (PHASES order) needs before the profile is
 *  pinned there. A null profile is a fresh labeler: full need everywhere. */
export function lockInNeed(profile: LabelerProfile | null): number[] {
  return PHASES.map((phase) => {
    const count = profile?.per_phase.find((c) => c.phase === phase)?.count ?? 0
    return Math.max(0, PROFILE_LOCK_N - count)
  })
}

/**
 * The Phase-A presentation plan for a sampled session: a permutation of the
 * position indices whose head is the lock-in burst, plus the burst's length.
 *
 * Greedy and deterministic: each burst slot takes the earliest unused position
 * of the *neediest* phase (ties broken in PHASES order) — the design doc's
 * multidimensional twist ("the most informative next item may be an easy
 * endgame count rather than a harder middlegame") reduced to the phase vector.
 * A phase the sample can't supply just gets what exists. After the burst the
 * remaining positions follow in their original sampled order.
 */
export function lockInPlan(
  positions: CalibrationPosition[],
  profile: LabelerProfile | null,
): { order: number[]; lockInCount: number } {
  const needs = lockInNeed(profile)
  // Per-phase queues of position indices, original order preserved.
  const queues = PHASES.map((phase) =>
    positions.flatMap((p, i) => (p.phase === phase ? [i] : [])),
  )
  const heads = PHASES.map(() => 0)
  const burst: number[] = []
  const used = new Set<number>()
  while (burst.length < LOCK_IN_CAP) {
    let pick = -1
    for (let ph = 0; ph < PHASES.length; ph++) {
      if (needs[ph] > 0 && heads[ph] < queues[ph].length && (pick === -1 || needs[ph] > needs[pick])) {
        pick = ph
      }
    }
    if (pick === -1) break
    const idx = queues[pick][heads[pick]]
    heads[pick] += 1
    needs[pick] -= 1
    burst.push(idx)
    used.add(idx)
  }
  const rest = positions.map((_, i) => i).filter((i) => !used.has(i))
  return { order: [...burst, ...rest], lockInCount: burst.length }
}

/** Apply the lock-in plan: the same session with its positions reordered so
 *  the burst comes first. Answer indices always refer to the REORDERED array —
 *  presentation order and position index stay one thing, as everywhere else. */
export function applyLockIn(
  session: CalibrationSession,
  profile: LabelerProfile | null,
): { session: CalibrationSession; lockInCount: number } {
  const { order, lockInCount } = lockInPlan(session.positions, profile)
  return {
    session: { ...session, positions: order.map((i) => session.positions[i]) },
    lockInCount,
  }
}

// ---------------------------------------------------------------------------
// Phase B — model-driven selection (spec 213 adaptive elicitation, Phase B)
// ---------------------------------------------------------------------------
//
// After the lock-in burst, every next position is chosen by what the MODEL
// needs, not by presentation order (design doc §6.3, tier 1) — blending the
// two uncertainty streams computable today:
//
//   1. Evaluator-variant disagreement: tier-1 Eval_R swept across three
//      rating bands (the existing `human_eval_sweep` command, reused
//      read-only). The spread in pawns is how much a label here prunes model
//      space — a position every variant agrees on teaches nothing. The tab's
//      prefetcher scores upcoming positions while the user thinks, so the
//      measured 1–4 s/stop latency disappears.
//   2. Coverage sparsity: labels-so-far per (phase × |SF eval| band) cell,
//      prior sessions included — the labeler is most valuable where their
//      own label corpus is thin. (Corpus-backed sparsity and §5-coefficient
//      starvation are tier 2, blocked on the mining tables.)
//
// Selection only reorders the sampled session, one slot at a time as the user
// advances: the neediest remaining position is promoted into the next slot,
// so "answer indices refer to the positions array" stays true and every
// sampled position is still eventually shown — the session budget is the
// spec's "the '100' is a budget". Deterministic given the same spreads and
// counts: argmax with ties to the earliest remaining position. There is no
// completion state (design doc §6.4) — the readout below reports where labels
// are saturating instead.

/** Evaluator variants for the disagreement stream: the ends + middle of
 *  Maia-1's native range. Three bands = maia.rs's warm-pool size (LRU cap 3),
 *  so a sweep never thrashes the lc0 pool. */
export const DISAGREEMENT_BANDS = [1100, 1500, 1900] as const

/** Sweep knobs for disagreement scoring: shallower than the display sweep's
 *  default depth 3 (this is a ranking signal, not a shown eval) but with the
 *  default nucleus and leaf depth — leaf TT keys are band- and depth-free, so
 *  these sweeps share leaf evals with the analysis panel's perception curves
 *  and across the three bands. */
export const PHASE_B_KNOBS: HumanTreeOptions = { depth: 2 }

/** Upcoming positions the prefetcher keeps disagreement-scored ahead of the
 *  user (~1–3 s each; a think is typically far longer). */
export const PHASE_B_PREFETCH = 3

/** Pawns of disagreement a fully-unlabeled coverage cell is worth: an unseen
 *  (phase × band) cell outranks anything but a large evaluator split, and the
 *  bonus decays as 1/(1+count) once labels accumulate. */
export const SPARSITY_WEIGHT = 2

/** Spread inputs are clamped to ±this (mirrors TREE_MATE_PAWNS) so one
 *  mate-band blowup can't dominate the ranking forever. */
const SPREAD_CLAMP_PAWNS = 12

/** Evaluator disagreement for one position: max − min Eval_R in pawns across
 *  the swept bands, each clamped to ±SPREAD_CLAMP_PAWNS. Null with fewer than
 *  two points (a cancelled sweep) — the caller retries rather than record a
 *  partial spread. */
export function disagreementOf(pawnsByBand: number[]): number | null {
  if (pawnsByBand.length < 2) return null
  const clamped = pawnsByBand.map((p) =>
    Math.max(-SPREAD_CLAMP_PAWNS, Math.min(SPREAD_CLAMP_PAWNS, p)),
  )
  return Math.max(...clamped) - Math.min(...clamped)
}

/** Coverage cell of a position: game phase × |SF eval| band. */
export function cellKey(pos: Pick<CalibrationPosition, "phase" | "band">): string {
  return `${pos.phase}|${pos.band}`
}

/** Labels per coverage cell across saved results — the sparsity stream's
 *  prior. Same tolerance as buildProfileFromResults: v1 point sessions load,
 *  malformed entries are skipped, never fatal. `showReveal` given ⇒ only
 *  sessions of that reveal mode count (blind/reveal split, like
 *  buildProfileFromResults). */
export function cellCounts(
  results: CalibrationResults[],
  showReveal?: boolean,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const r of results) {
    if (r == null || typeof r !== "object" || r.session?.positions == null || !Array.isArray(r.answers)) {
      continue
    }
    if (showReveal !== undefined && isRevealResults(r) !== showReveal) continue
    for (const s of scoredAnswers(r.session, r.answers.map(normalizeAnswer))) {
      const k = cellKey(s.pos)
      counts[k] = (counts[k] ?? 0) + 1
    }
  }
  return counts
}

/** The prior cell counts plus the running session's usable answers so far —
 *  what selection sees at each advance. */
export function countsWithSession(
  prior: Record<string, number>,
  session: CalibrationSession,
  answers: CalibrationAnswer[],
): Record<string, number> {
  const counts = { ...prior }
  for (const s of scoredAnswers(session, answers)) {
    const k = cellKey(s.pos)
    counts[k] = (counts[k] ?? 0) + 1
  }
  return counts
}

/** The blended Phase-B need score, in pawn-equivalents: evaluator spread
 *  (0 when unscored — sweeps unavailable or not prefetched yet) plus the
 *  decaying sparsity bonus for the position's coverage cell. */
export function phaseBScore(spread: number | null, cellCount: number): number {
  return (spread ?? 0) + SPARSITY_WEIGHT / (1 + cellCount)
}

/** Index of the neediest position in `positions[from..]` — the one the model
 *  wants labeled next. Deterministic: strict argmax keeps the earliest
 *  position on ties, so with no spreads and uniform coverage the sampled
 *  order stands. */
export function pickNext(
  positions: CalibrationPosition[],
  from: number,
  spreads: Record<string, number>,
  counts: Record<string, number>,
): number {
  let best = from
  let bestScore = -Infinity
  for (let i = from; i < positions.length; i++) {
    const p = positions[i]
    const score = phaseBScore(spreads[p.fen] ?? null, counts[cellKey(p)] ?? 0)
    if (score > bestScore) {
      best = i
      bestScore = score
    }
  }
  return best
}

/** Move the position at `from` into slot `to`, preserving the relative order
 *  of everything else. `from` must be ≥ `to` (the pick comes from the
 *  unanswered tail), so indices below `to` — the already-answered positions —
 *  never move and committed answer indices stay valid. No-op when equal. */
export function promoteAt(
  session: CalibrationSession,
  to: number,
  from: number,
): CalibrationSession {
  if (from === to) return session
  const positions = [...session.positions]
  const [chosen] = positions.splice(from, 1)
  positions.splice(to, 0, chosen)
  return { ...session, positions }
}

/** The diminishing-returns readout (design doc §6.4): data collection has no
 *  completion state, so instead report where labels are piling up and where
 *  the next budget should go. Null until anything is labeled. Ties resolve to
 *  the earliest cell in PHASES × BANDS order, so the text is deterministic. */
export function phaseBReadout(counts: Record<string, number>): string | null {
  const cells = PHASES.flatMap((phase) =>
    BANDS.map((band) => ({
      label: `${phase} ${band}`,
      count: counts[`${phase}|${band}`] ?? 0,
    })),
  )
  let most = cells[0]
  let least = cells[0]
  for (const c of cells) {
    if (c.count > most.count) most = c
    if (c.count < least.count) least = c
  }
  if (most.count === 0) return null
  return `${most.label} is the most saturated (${most.count} labels); ${least.label} is the bottleneck (${least.count})`
}

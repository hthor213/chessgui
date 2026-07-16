// Labeler profile + Phase-A lock-in (spec 213 adaptive elicitation, Phase A).
//
// Design doc §6.1: a label is only usable if we know who produced it — "a
// ~1300 with a 1500-ish endgame perceived this as +1.2" is data; an anonymous
// "+1.2" is not. So a session opens with a brief lock-in burst (~10–20
// positions) that pins the labeler's per-phase profile just tightly enough for
// their answers to read as a known-level human's perception. Previously saved
// sessions are the prior, so returning users skip most (or all) of it.
//
// Phase A only REORDERS the already-sampled session — deterministically, no
// RNG: the plan is a pure function of (sampled order, prior profile). It never
// draws new positions; model-driven *selection* is Phase B, which is blocked
// on the tier-1 evaluator and deliberately not built here.
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
import { PHASES, scoredAnswers, type Scored } from "./calibration-stats"

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

/** Fold every saved results file into one profile, oldest first. Tolerates the
 *  full history: v1 point sessions, pre-think_ms answers (normalized in), and
 *  malformed entries (skipped — a damaged artifact degrades the prior, it
 *  never blocks a session). Returns null when nothing usable exists, so a
 *  fresh labeler is distinguishable from an all-miss one. */
export function buildProfileFromResults(results: CalibrationResults[]): LabelerProfile | null {
  const usable = results.filter(
    (r) => r != null && typeof r === "object" && r.session?.positions != null && Array.isArray(r.answers),
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

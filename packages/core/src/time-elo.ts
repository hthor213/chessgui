// Machine-speed / time-compression Elo model (spec 216 tier-0).
//
// Spec 216 "The model" (specs/216-machine-speed-elo-model.md:17-33): engine
// strength is a function of COMPUTE PER MOVE (nodes ≈ nps × seconds), not
// wall-clock. `Elo(t) ≈ a + b·log₂(t)` — near-linear in log-time, so the
// nonlinearity lives in `b` (Elo per doubling), ~50–100 for SF-class engines
// and SHRINKING at longer controls (216:20-22). This module owns the curve,
// the compression→ΔElo cost, the cross-machine (nps) equivalence, and the
// pacing floor — everything the tier-0 checklist (216:71) pins to
// `lib/time-elo.ts`, minus the UI wiring.
//
// Two independent knobs (216:8-15): TIME FORMAT (defines the simulated clocks)
// and PLAYBACK PACE (theater). Search engines pay a known, nonlinear Elo cost
// to be compressed below their compute budget; policy personas (Maia/BT3) are
// time-invariant and pay exactly zero — hence the `timeSensitive` flag.

// ---------------------------------------------------------------------------
// The curve: Elo per doubling of compute, b(t)
// ---------------------------------------------------------------------------

/**
 * One anchor of the b(t) curve: `b` Elo per doubling of compute AT this point
 * on the log₂(seconds-per-move) axis. Anchors are stored in log₂-seconds
 * because the whole model is linear there (a doubling of compute is a step of
 * +1 in log₂Sec), which makes ΔElo a plain integral of `b` over the axis.
 */
export type BAnchor = { log2Sec: number; b: number }

/**
 * The strength-vs-compute curve. `b` is either a single constant (Elo per
 * doubling, same at every control) or a small set of anchor points that are
 * linearly interpolated — because `b` shrinks at longer controls (216:22), a
 * constant over-charges long-time-control compression. `source` is the UI
 * provenance flag (216:28-30): shipped `prior` curves are literature-informed
 * guesses; the engine-lab time-odds ladder later overwrites them with
 * `measured` values once ≥2 rungs have CI excluding zero.
 */
export type EloCurve = {
  source: "prior" | "measured"
  b: number | BAnchor[]
  /**
   * Ladder-measured per-move floor (seconds): the fastest rung the time-odds
   * ladder completed cleanly on this machine, written by
   * `scripts/calibration/fit_curve.py`. Replaces the tier-0 0.05s machine-min
   * placeholder (216:75) when present; absent on prior curves and on measured
   * curves fitted before the field existed.
   */
  machine_min_seconds?: number
}

function anchor(seconds: number, b: number): BAnchor {
  return { log2Sec: Math.log2(seconds), b }
}

/**
 * Literature-informed PRIOR anchors (216:22 gives the shape "~50–100,
 * shrinking at longer controls"; these specific values are the priors this
 * project ships and flags as PRIOR in the UI until the lab measures them):
 * b ≈ 90 @ 0.1s/move, 70 @ 1s, 55 @ 10s, 40 @ 60s, 30 @ 240s. Ascending in
 * seconds (and therefore in log2Sec), as `bAt`/`integrateB` assume.
 */
export const DEFAULT_PRIOR_ANCHORS: BAnchor[] = [
  anchor(0.1, 90),
  anchor(1, 70),
  anchor(10, 55),
  anchor(60, 40),
  anchor(240, 30),
]

/** The curve shipped by default: prior anchors, flagged `prior`. */
export const DEFAULT_PRIOR_CURVE: EloCurve = {
  source: "prior",
  b: DEFAULT_PRIOR_ANCHORS,
}

/**
 * Interpolated Elo-per-doubling at a given point on the log₂(seconds) axis.
 * Constant curves ignore the argument; anchored curves interpolate linearly
 * and hold flat (clamp) beyond the outermost anchors, so extrapolating past
 * 240s or below 0.1s charges the boundary rate rather than a runaway line.
 */
export function bAt(curve: EloCurve, log2Sec: number): number {
  const b = curve.b
  if (typeof b === "number") return b
  if (b.length === 0) return 0
  if (log2Sec <= b[0].log2Sec) return b[0].b
  const last = b[b.length - 1]
  if (log2Sec >= last.log2Sec) return last.b
  for (let i = 1; i < b.length; i++) {
    if (log2Sec <= b[i].log2Sec) {
      const lo = b[i - 1]
      const hi = b[i]
      const t = (log2Sec - lo.log2Sec) / (hi.log2Sec - lo.log2Sec)
      return lo.b + t * (hi.b - lo.b)
    }
  }
  return last.b // unreachable given the clamp above; guards float edge cases
}

/**
 * ∫ b(x) dx over the log₂(seconds) axis from `fromLog2` to `toLog2`. `b` is
 * piecewise-linear (or constant), so a trapezoid rule that KNOTS on every
 * anchor inside the interval is exact — this is what makes ΔElo the true
 * area under the shrinking-b curve rather than the naive b(base)·log₂(C)
 * rectangle. Returns 0 for an empty/reversed interval.
 */
function integrateB(curve: EloCurve, fromLog2: number, toLog2: number): number {
  if (!(toLog2 > fromLog2)) return 0
  const b = curve.b
  if (typeof b === "number") return b * (toLog2 - fromLog2)

  // Knots: the endpoints plus every anchor strictly inside the interval.
  const xs: number[] = [fromLog2]
  for (const a of b) {
    if (a.log2Sec > fromLog2 && a.log2Sec < toLog2) xs.push(a.log2Sec)
  }
  xs.push(toLog2)
  xs.sort((p, q) => p - q)

  let area = 0
  for (let i = 1; i < xs.length; i++) {
    const x0 = xs[i - 1]
    const x1 = xs[i]
    area += ((bAt(curve, x0) + bAt(curve, x1)) / 2) * (x1 - x0)
  }
  return area
}

// ---------------------------------------------------------------------------
// Compression → ΔElo
// ---------------------------------------------------------------------------

/**
 * Elo cost of compressing a time control by factor `compressionFactor`
 * (C > 1 = faster; the compressed budget is `baseSecondsPerMove / C`). This
 * is the AREA under b(t) across the doublings spanned, i.e.
 * ∫ from log₂(base/C) to log₂(base) of b — NOT b(base)·log₂(C), which
 * over/under-charges whenever the interval crosses an anchor where b changes
 * slope. Returns 0 for C ≤ 1 (no compression = no cost) and for a
 * non-positive base (nothing to compress).
 */
export function deltaElo(
  curve: EloCurve,
  baseSecondsPerMove: number,
  compressionFactor: number,
): number {
  if (!(compressionFactor > 1)) return 0
  if (!(baseSecondsPerMove > 0)) return 0
  const upper = Math.log2(baseSecondsPerMove)
  const lower = upper - Math.log2(compressionFactor)
  return integrateB(curve, lower, upper)
}

/**
 * Cross-machine equivalence at EQUAL NODES (216:24-26, 58-59). To reach the
 * same node count `fromNps × fromSeconds`, a machine running at `toNps` needs
 * `fromSeconds × fromNps / toNps` seconds. Example (spec 216 tier-2): a
 * homeserver at 60s ≈ a slower laptop at more seconds, or a faster laptop at
 * fewer. `curve` is accepted for API symmetry with the rest of the module and
 * to leave room for a non-same-nodes model later; the same-nodes mapping does
 * not consult it.
 */
export function equivalentSeconds(
  curve: EloCurve,
  fromSeconds: number,
  toNps: number,
  fromNps: number,
): number {
  void curve
  if (!(toNps > 0)) return 0
  return (fromSeconds * fromNps) / toNps
}

/** Seconds for display in an equivalence line: whole above 10s, one decimal
 *  down to 1s, two below — "22s", "5.5s", "0.25s". */
function formatEquivSeconds(seconds: number): string {
  if (seconds >= 10) return `${Math.round(seconds)}s`
  const s = seconds >= 1 ? seconds.toFixed(1) : seconds.toFixed(2)
  return `${s.replace(/\.?0+$/, "")}s`
}

/**
 * Human-readable cross-machine equivalence (216 Tier 2): what `refSeconds`
 * per move buys in nodes on the `remote` machine, restated as seconds per
 * move on the `local` one — "homeserver 60s/move ≈ laptop 22s/move". Null
 * when either side lacks a positive nps (no honest equivalence without both
 * benches). Same-nodes mapping via `equivalentSeconds`.
 */
export function equivalenceLine(
  curve: EloCurve,
  local: { hostname: string; nps: number },
  remote: { hostname: string; nps: number },
  refSeconds = 60,
): string | null {
  if (!(local.nps > 0) || !(remote.nps > 0) || !(refSeconds > 0)) return null
  const localSeconds = equivalentSeconds(curve, refSeconds, local.nps, remote.nps)
  return (
    `${remote.hostname} ${formatEquivSeconds(refSeconds)}/move` +
    ` ≈ ${local.hostname} ${formatEquivSeconds(localSeconds)}/move`
  )
}

// ---------------------------------------------------------------------------
// Per-engine curves & profile plumbing (216 Tier 2)
// ---------------------------------------------------------------------------

/**
 * The slice of a machine profile the per-engine helpers consume — structural,
 * so both the local `MachineProfile` and imported remote profiles fit without
 * this module importing the transport types.
 */
export type SpeedProfileLike = {
  hostname?: string
  engine_name?: string
  nps?: number
  curve?: unknown
  engines?: Record<string, { nps?: number; curve?: unknown } | undefined> | null
}

/**
 * Validate an unknown profile `curve` value (the Rust side stores it as
 * opaque JSON) into an `EloCurve`, or null if it isn't one. Extra fields the
 * fitter writes (`rungs`, `fitted_at`, `machine_min_seconds`) ride along.
 */
export function asEloCurve(raw: unknown): EloCurve | null {
  if (typeof raw !== "object" || raw === null) return null
  const c = raw as { source?: unknown; b?: unknown }
  if (c.source !== "prior" && c.source !== "measured") return null
  if (typeof c.b === "number" && Number.isFinite(c.b)) return raw as EloCurve
  if (
    Array.isArray(c.b) &&
    c.b.every(
      (a: unknown): a is BAnchor =>
        typeof a === "object" &&
        a !== null &&
        typeof (a as BAnchor).log2Sec === "number" &&
        typeof (a as BAnchor).b === "number",
    )
  ) {
    return raw as EloCurve
  }
  return null
}

/**
 * The b(t) curve to use for one engine on a machine (216 Tier 2 "per-engine
 * curves"): that engine's own measured curve when the ladder has fitted one,
 * else the profile's top-level curve (the last-benched engine's), else the
 * literature prior. Safe on null/legacy profiles.
 */
export function curveForEngine(
  profile: SpeedProfileLike | null | undefined,
  engineName?: string | null,
): EloCurve {
  const engineCurve = engineName
    ? asEloCurve(profile?.engines?.[engineName]?.curve)
    : null
  return engineCurve ?? asEloCurve(profile?.curve) ?? DEFAULT_PRIOR_CURVE
}

/**
 * One engine's benched nps on a machine, falling back to the profile's
 * top-level (last-benched) figure. 0 = never benched (no honest equivalence).
 */
export function npsForEngine(
  profile: SpeedProfileLike | null | undefined,
  engineName?: string | null,
): number {
  const n = engineName ? profile?.engines?.[engineName]?.nps : undefined
  if (typeof n === "number" && n > 0) return n
  const top = profile?.nps
  return typeof top === "number" && top > 0 ? top : 0
}

/**
 * The machine's minimum seconds/move for pacing floors: the ladder-measured
 * `machine_min_seconds` riding on a fitted curve when present, else
 * `fallbackSeconds` (the tier-0 placeholder, 216:75). Takes the raw curve
 * value so callers can pass `profile?.curve` straight through.
 */
export function machineMinSeconds(curve: unknown, fallbackSeconds: number): number {
  const v = (curve as { machine_min_seconds?: unknown } | null | undefined)
    ?.machine_min_seconds
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallbackSeconds
}

/**
 * Per-engine cross-machine equivalence (216 Tier 2 "per-engine curves"): one
 * line per engine BOTH machines have benched, each at equal nodes using that
 * engine's own nps on each side — Reckless and SF scale differently across
 * machines, so a single shared line misstates one of them. Engines only one
 * side knows are skipped; empty when there's no overlap (callers fall back
 * to the top-level `equivalenceLine`).
 */
export function engineEquivalenceLines(
  local: SpeedProfileLike & { hostname: string },
  remote: SpeedProfileLike & { hostname: string },
  refSeconds = 60,
): { engine: string; line: string }[] {
  // Entry nps only — no top-level fallback here, which would silently pit
  // one engine's speed against a DIFFERENT engine's (the last one benched).
  const entryNps = (p: SpeedProfileLike, engine: string): number => {
    const n = p.engines?.[engine]?.nps
    return typeof n === "number" && n > 0 ? n : 0
  }
  const lines: { engine: string; line: string }[] = []
  for (const engine of Object.keys(local.engines ?? {}).sort()) {
    if (!(remote.engines && engine in remote.engines)) continue
    const line = equivalenceLine(
      curveForEngine(local, engine),
      { hostname: local.hostname, nps: entryNps(local, engine) },
      { hostname: remote.hostname, nps: entryNps(remote, engine) },
      refSeconds,
    )
    if (line !== null) lines.push({ engine, line })
  }
  return lines
}

// ---------------------------------------------------------------------------
// Time control → seconds per move
// ---------------------------------------------------------------------------

/** The move budget the average-seconds-per-move estimate assumes (216 UI). */
export const MOVE_BUDGET = 40

/**
 * A time control. `movesPerControl` present = classical N-moves-in-X (the
 * base time buys that many moves); absent = sudden death (base time is the
 * whole game, budgeted over `MOVE_BUDGET` moves). `incrementSeconds` is the
 * per-move add-back.
 */
export type TimeControl = {
  baseSeconds: number
  incrementSeconds: number
  movesPerControl?: number
}

/**
 * Average seconds available per move, assuming a `MOVE_BUDGET`-move game.
 * Classical 40-in-X → X/40 + increment; sudden death → base/40 + increment.
 * Both reduce to `base / moves + increment` with `moves` defaulting to the
 * budget — the value `deltaElo`/pacing consume as `baseSecondsPerMove`.
 */
export function secondsPerMoveOf(format: TimeControl): number {
  const moves = format.movesPerControl ?? MOVE_BUDGET
  return format.baseSeconds / moves + format.incrementSeconds
}

// ---------------------------------------------------------------------------
// Pacing: strength readout + floor
// ---------------------------------------------------------------------------

/**
 * Result of the live Elo readout on the pacing slider (216:41-43). `deltaElo`
 * is the (non-negative) Elo shed versus face value at this pace; `reason` is
 * the UI string. Policy personas short-circuit to zero with a distinct reason.
 */
export type PaceStrength = {
  deltaElo: number
  timeSensitive: boolean
  reason: string
}

/**
 * Policy personas (Maia/BT3-policy) answer in milliseconds; their strength is
 * time-invariant, so compression costs them nothing (216:14-15, 33). This is
 * the exact string the UI shows for that case (216:43).
 */
export const POLICY_PERSONA_REASON = "no strength change (policy persona)"

/** Shown for a search engine playing at or above its compute budget (C ≤ 1). */
export const FULL_STRENGTH_REASON = "full strength at this pace"

/**
 * The pacing-slider Elo readout (216:41-43). For `timeSensitive: false`
 * backends (policy personas) returns 0 with `POLICY_PERSONA_REASON`. For
 * search engines returns the curve's ΔElo cost and the spec's face-value
 * string; at or above the compute budget (no compression) the cost is 0.
 */
export function paceStrength(
  curve: EloCurve,
  baseSecondsPerMove: number,
  compressionFactor: number,
  opts: { timeSensitive?: boolean } = {},
): PaceStrength {
  const timeSensitive = opts.timeSensitive ?? true
  if (!timeSensitive) {
    return { deltaElo: 0, timeSensitive: false, reason: POLICY_PERSONA_REASON }
  }
  const d = deltaElo(curve, baseSecondsPerMove, compressionFactor)
  if (d <= 0) {
    return { deltaElo: 0, timeSensitive: true, reason: FULL_STRENGTH_REASON }
  }
  return {
    deltaElo: d,
    timeSensitive: true,
    reason: `≈ face value − ${Math.round(d)} Elo at this pace`,
  }
}

/**
 * The pacing-slider floor (216:39, tier-0 checklist 216:75): playback pace
 * cannot drop below 1.25× the minimum compute time — the buffer that keeps
 * user moves and window drags responsive. Below the compute budget is
 * physically impossible for a search engine anyway; this is the softer
 * interaction floor on top of that.
 */
export const PACE_FLOOR_MULTIPLIER = 1.25

/** 1.25 × the minimum compute seconds — the user-interaction pacing floor. */
export function paceFloor(minComputeSeconds: number): number {
  return PACE_FLOOR_MULTIPLIER * minComputeSeconds
}

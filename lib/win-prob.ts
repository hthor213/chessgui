// Eval -> win-probability curve + per-move swing labeling (spec 212 tier-1).
//
// Spec 212 "Error report per game" (specs/212-tournament-game-analysis.md:23-31):
// classify each move by WIN-PROBABILITY swing, not raw centipawns, and derive
// the eval->win-prob curve from the run's own probability map (the eval-bucket
// -> W/D/L data the tournament already computes) instead of borrowing lichess
// constants tuned for humans. Checklist (212:77-78): curve from the map with a
// logistic fit as fallback; labeling at configurable thresholds.
//
// "Win-prob" throughout is the EXPECTED SCORE of the side to move's POV owner
// (wins + draws/2), i.e. ProbBin.avgWhiteScore — the spec derives the curve
// from a W/D/L map but is silent on how draws weigh; expected score is the
// natural scalar and what the map already aggregates.
//
// Stationarity assumption (endorsed by 212:19 using the STARTING-eval map as
// the per-ply substrate): a +1.0 at ply 40 is assumed to convert like a +1.0
// at ply 0 for these engines at this TC.

import {
  gameResult,
  plyEvalPawns,
  type GameOutcome,
  type PlyEval,
  type ProbBin,
} from "@/lib/tournament"

// ---------------------------------------------------------------------------
// Thresholds (spec 212:28-29)
// ---------------------------------------------------------------------------

export type MoveLabel = "inaccuracy" | "mistake" | "blunder"

/** Win-prob-drop thresholds, mover perspective, as fractions of 1. */
export type SwingThresholds = {
  inaccuracy: number
  mistake: number
  blunder: number
}

/**
 * Spec 212:29 defaults — "inaccuracy / mistake / blunder at configurable
 * win-prob-drop thresholds (defaults e.g. 5/10/20 percentage points,
 * engine-perspective)".
 */
export const DEFAULT_THRESHOLDS: SwingThresholds = {
  inaccuracy: 0.05,
  mistake: 0.1,
  blunder: 0.2,
}

// ---------------------------------------------------------------------------
// Eval -> win-prob curve
// ---------------------------------------------------------------------------

/**
 * Logistic slope (per pawn) used when there is no lab data to fit at all.
 * Spec 212 pins the primary source (the run's own probability map) and the
 * fallback SHAPE (logistic) but is silent on the no-data constant; 0.4/pawn
 * matches the 0.004/cp squash the eval graph already uses (lib/annotations.ts
 * evalToUnit), so the last-resort default is at least internally consistent.
 */
export const DEFAULT_LOGISTIC_K = 0.4

/**
 * Fitted slopes are clamped to this range: below 0.05 the curve is flat noise
 * (labels would never fire), above 3.0 a single sparse bin can manufacture a
 * cliff. Spec is silent on fit guards; bounds chosen so the default (0.4) and
 * any plausible engine-lab slope sit comfortably inside.
 */
export const LOGISTIC_K_RANGE: [number, number] = [0.05, 3.0]

/** Bins with fewer games than this are too noisy to serve as curve anchors. */
export const MIN_ANCHOR_GAMES = 5

/** Fewer usable anchor bins than this and we fall back to the logistic. */
export const MIN_ANCHOR_BINS = 3

/**
 * Eval (White-POV pawns) -> White expected score in [0,1].
 *
 * - `anchors` non-empty: piecewise-linear through the (isotonic-regressed) map
 *   anchors, with logistic tails outside the anchored range so extreme evals
 *   and mates saturate toward 0/1 instead of extrapolating linearly.
 * - `anchors` empty: pure logistic 1/(1+exp(-k*e)) — the spec's fallback.
 */
export type WinProbCurve = {
  /** Monotone (non-decreasing w) anchor points, ascending by e. */
  anchors: { e: number; w: number }[]
  /** Logistic slope per pawn (tails + fallback). */
  k: number
  /** Where the curve came from, for UI provenance. */
  source: "map" | "logistic-fit" | "logistic-default"
}

const LOGIT_CLAMP = 1e-3

function logit(p: number): number {
  const c = Math.min(1 - LOGIT_CLAMP, Math.max(LOGIT_CLAMP, p))
  return Math.log(c / (1 - c))
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

type WeightedPoint = { x: number; y: number; w: number }

/**
 * Weighted isotonic regression (PAVA), non-decreasing. Small-sample bins make
 * the raw map non-monotone; labeling against a non-monotone curve would let a
 * strictly-improving eval read as a win-prob drop, so monotonicity is enforced
 * before the anchors are used. (Spec is silent on smoothing; flagged.)
 */
function isotonicNonDecreasing(pts: WeightedPoint[]): WeightedPoint[] {
  type Block = { sum: number; w: number; n: number }
  const blocks: Block[] = []
  for (const p of pts) {
    blocks.push({ sum: p.y * p.w, w: p.w, n: 1 })
    // Pool adjacent violators: merge while the running means decrease.
    while (blocks.length >= 2) {
      const b = blocks[blocks.length - 1]
      const a = blocks[blocks.length - 2]
      if (a.sum / a.w <= b.sum / b.w) break
      blocks.pop()
      a.sum += b.sum
      a.w += b.w
      a.n += b.n
    }
  }
  const out: WeightedPoint[] = []
  let i = 0
  for (const b of blocks) {
    const mean = b.sum / b.w
    for (let j = 0; j < b.n; j++, i++) out.push({ x: pts[i].x, y: mean, w: pts[i].w })
  }
  return out
}

/**
 * One-parameter weighted logistic fit through (0, 0.5): least squares on
 * logit(w) = k*e over the given points. Returns null when the data carries no
 * slope information (all points at e=0, or a non-positive fit).
 */
function fitLogisticK(pts: WeightedPoint[]): number | null {
  let num = 0
  let den = 0
  for (const p of pts) {
    num += p.w * p.x * logit(p.y)
    den += p.w * p.x * p.x
  }
  if (den <= 0) return null
  const k = num / den
  if (!(k > 0)) return null
  return Math.min(LOGISTIC_K_RANGE[1], Math.max(LOGISTIC_K_RANGE[0], k))
}

/**
 * Derive the eval->win-prob curve from the run's own probability map
 * (spec 212 checklist line 77). Bins with >= `minAnchorGames` games become
 * anchors (isotonic-regressed); with fewer than MIN_ANCHOR_BINS usable bins
 * the curve falls back to a logistic — fitted to whatever bins exist, else the
 * documented default slope.
 */
export function deriveWinProbCurve(
  bins: ProbBin[],
  minAnchorGames = MIN_ANCHOR_GAMES,
): WinProbCurve {
  const pts: WeightedPoint[] = bins
    .filter((b) => b.count > 0)
    .map((b) => ({ x: b.center, y: b.avgWhiteScore, w: b.count }))
    .sort((a, b) => a.x - b.x)

  // Slope for the tails (and the whole curve when we fall back).
  const kFit = fitLogisticK(pts)
  const k = kFit ?? DEFAULT_LOGISTIC_K

  const anchorPts = pts.filter((p) => p.w >= minAnchorGames)
  if (anchorPts.length >= MIN_ANCHOR_BINS) {
    const iso = isotonicNonDecreasing(anchorPts)
    return {
      anchors: iso.map((p) => ({ e: p.x, w: p.y })),
      k,
      source: "map",
    }
  }
  return { anchors: [], k, source: kFit !== null ? "logistic-fit" : "logistic-default" }
}

/**
 * White expected score for a White-POV eval in pawns. Inside the anchored
 * range: linear interpolation. Outside it: a logistic tail with the curve's
 * slope, offset to pass through the boundary anchor, so extreme cp and mates
 * (pinned to +/-MATE_EVAL_PAWNS by plyEvalPawns) saturate toward 1/0.
 */
export function winProb(curve: WinProbCurve, pawns: number): number {
  const a = curve.anchors
  if (a.length === 0) return sigmoid(curve.k * pawns)

  const first = a[0]
  const last = a[a.length - 1]
  if (pawns <= first.e) {
    return sigmoid(curve.k * (pawns - first.e) + logit(first.w))
  }
  if (pawns >= last.e) {
    return sigmoid(curve.k * (pawns - last.e) + logit(last.w))
  }
  // Bracketing anchors for linear interpolation.
  for (let i = 1; i < a.length; i++) {
    if (pawns <= a[i].e) {
      const lo = a[i - 1]
      const hi = a[i]
      const t = hi.e === lo.e ? 0 : (pawns - lo.e) / (hi.e - lo.e)
      return lo.w + t * (hi.w - lo.w)
    }
  }
  return last.w // unreachable; guards float edge cases
}

// ---------------------------------------------------------------------------
// Per-move swing computation + labeling (spec 212:28-31)
// ---------------------------------------------------------------------------

/**
 * One move's win-prob swing. Fields per spec 212:30-31 — "ply, mover (engine),
 * eval before/after, best-move gap if the evaluator reported a PV, clock
 * remaining".
 */
export type MoveSwing = {
  /** 1-based half-move index: the move that produced the position at `ply`. */
  ply: number
  /** UCI of the move, when the game record carries it. */
  uci: string | null
  mover: "white" | "black"
  /** Which engine moved ("a"/"b" per the batch pairing: A is White unless flipped). */
  engine: "a" | "b"
  /** Neutral-evaluator scores (White-POV) before/after the move. */
  evalBefore: PlyEval
  evalAfter: PlyEval
  /** Win-prob (expected score) before/after, MOVER perspective (spec 212:29). */
  wpBefore: number
  wpAfter: number
  /** Mover-perspective change: negative = the move cost the mover win-prob. */
  delta: number
  /** max(0, -delta) — the drop the thresholds are applied to. */
  drop: number
  label: MoveLabel | null
  /**
   * Mover's remaining clock (ms) after the move. From the caller-supplied
   * per-ply clocks when given (streamed MoveEvents), else from the outcome's
   * persisted `GameResult.clocks_ms` (spec 212 tier-1 clock persistence).
   * Null only when neither source has this ply (e.g. pre-212 payloads).
   */
  clockMs: number | null
  /**
   * Spec 212:30 "best-move gap if the evaluator reported a PV": how much the
   * played move cost vs the evaluator's best line, in centipawns, mover POV.
   * `evalBefore` is by definition the best-line value of the position, so the
   * gap is max(0, best-line cp − played-move cp); it is pinned to 0 when the
   * played move IS the evaluator's PV move (suppressing re-search noise), and
   * null when the evaluator reported no PV for the before-position.
   */
  bestMoveGapCp: number | null
}

/** Per-ply clocks (ms remaining after the move at that ply), keyed by ply. */
export type ClockByPly = Map<number, { wtimeMs: number; btimeMs: number }>

function labelForDrop(drop: number, t: SwingThresholds): MoveLabel | null {
  if (drop >= t.blunder) return "blunder"
  if (drop >= t.mistake) return "mistake"
  if (drop >= t.inaccuracy) return "inaccuracy"
  return null
}

/** Side to move at ply 0, from the game's start FEN (field 2). */
function startSideToMove(startFen: string): "w" | "b" {
  return startFen.split(/\s+/)[1] === "b" ? "b" : "w"
}

/**
 * Win-prob swing for every scored move of one game, in ply order. Moves are
 * only scored when the evaluator produced evals at BOTH the ply before and the
 * ply after; gaps are skipped rather than bridged, because bridging would
 * attribute two movers' swings to one move (spec is silent on gaps; flagged).
 * Err and aborted games yield [].
 */
export function computeMoveSwings(
  outcome: GameOutcome,
  curve: WinProbCurve,
  thresholds: SwingThresholds = DEFAULT_THRESHOLDS,
  clocks?: ClockByPly,
): MoveSwing[] {
  const g = gameResult(outcome)
  if (!g || outcome.aborted) return []

  const byPly = new Map<number, PlyEval>()
  for (const pe of outcome.evals ?? []) byPly.set(pe.ply, pe)

  const startSide = startSideToMove(g.start_fen)
  const swings: MoveSwing[] = []

  for (let before = 0; before < g.plies; before++) {
    const after = before + 1
    const evalBefore = byPly.get(before)
    const evalAfter = byPly.get(after)
    if (!evalBefore || !evalAfter) continue
    const pawnsBefore = plyEvalPawns(evalBefore)
    const pawnsAfter = plyEvalPawns(evalAfter)
    if (pawnsBefore === null || pawnsAfter === null) continue

    // Mover parity is anchored to the start FEN's side to move (eval-qualified
    // seeds can start with Black to move).
    const whiteMoves = (before % 2 === 0) === (startSide === "w")
    const mover = whiteMoves ? "white" : "black"
    // Engine A is White unless the game is flipped (see buildSpecs).
    const engine = whiteMoves !== outcome.flipped ? "a" : "b"

    const whiteBefore = winProb(curve, pawnsBefore)
    const whiteAfter = winProb(curve, pawnsAfter)
    const wpBefore = whiteMoves ? whiteBefore : 1 - whiteBefore
    const wpAfter = whiteMoves ? whiteAfter : 1 - whiteAfter
    const delta = wpAfter - wpBefore
    const drop = Math.max(0, -delta)

    // Mover's clock after the move: caller-supplied stream clocks win, else
    // the persisted GameResult.clocks_ms (index i pairs with moves[i]).
    const clk = clocks?.get(after) ?? null
    let clockMs = clk ? (whiteMoves ? clk.wtimeMs : clk.btimeMs) : null
    if (clockMs === null) {
      const rec = g.clocks_ms?.[before]
      if (rec) clockMs = whiteMoves ? rec[0] : rec[1]
    }

    // Best-move gap (cp, mover POV) when the evaluator reported a PV for the
    // before-position. Mates are pinned by plyEvalPawns, so the gap saturates
    // rather than blowing up.
    const uci = g.moves[before] ?? null
    const best = evalBefore.best ?? null
    const bestMoveGapCp =
      best === null
        ? null
        : uci === best
          ? 0
          : Math.max(
              0,
              Math.round(
                (whiteMoves ? pawnsBefore - pawnsAfter : pawnsAfter - pawnsBefore) * 100,
              ),
            )

    swings.push({
      ply: after,
      uci,
      mover,
      engine,
      evalBefore,
      evalAfter,
      wpBefore,
      wpAfter,
      delta,
      drop,
      label: labelForDrop(drop, thresholds),
      clockMs,
      bestMoveGapCp,
    })
  }
  return swings
}

/** Only the labeled (inaccuracy/mistake/blunder) moves of one game. */
export function labelGameMoves(
  outcome: GameOutcome,
  curve: WinProbCurve,
  thresholds: SwingThresholds = DEFAULT_THRESHOLDS,
  clocks?: ClockByPly,
): MoveSwing[] {
  return computeMoveSwings(outcome, curve, thresholds, clocks).filter(
    (s) => s.label !== null,
  )
}

/**
 * Spec 212 "Decisive moment per game" (212:33-35): the single largest win-prob
 * DROP — where the game was decided. Null when no move lost any win-prob
 * (e.g. no evals, or a game of monotone gains only).
 */
export function decisiveMoment(swings: MoveSwing[]): MoveSwing | null {
  let best: MoveSwing | null = null
  for (const s of swings) {
    if (s.drop > 0 && (best === null || s.drop > best.drop)) best = s
  }
  return best
}

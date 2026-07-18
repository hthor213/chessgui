// Per-game performance Elo (spec 202 "Per-game performance Elo"). Pure module —
// no engine, no I/O, no React. The fitted corpus error model is passed in as an
// argument (the desktop shell loads the JSON and hands it over); packages/core
// stays free of asset/platform dependencies.
//
// Honesty gate (213/224 house rule): a single game is a thin sample, so the
// number is deliberately coarse and its label always says so.
//
// Two estimators, spec 202's order of preference:
//   1. PRIMARY — band likelihood under the corpus error model
//      (error_model.fit.json). Each of the player's classified moves has a
//      P(mistake | eval, phase, clock) for every Elo band; the player's own
//      moves (which were / weren't mistakes) pick the most likely band by
//      log-likelihood. Feature extraction mirrors scripts/mining/error_model.py
//      EXACTLY (mover-POV eval-before bucket, material phase, clock bucket,
//      1.0-pawn mistake threshold) so the scoring lands in the cells the corpus
//      was counted into.
//   2. FALLBACK — average centipawn loss (ACPL) + mistake/blunder counts mapped
//      to an approximate band, used when no fit is supplied or a side has too
//      few scored moves to score against the corpus.
//
// The raw fit is DEGENERATE at its extreme bands (the corpus has almost no
// 2800+ moves, so those cells are noise and the mistake rate stops decreasing
// with Elo — which once made a blunder-heavy game read as ~3200). `regularizeFit`
// corrects this at score time (coverage clamp + monotonicity); the shell runs it
// once and hands the corrected model to `estimatePerformance`. See its doc.
//
// Opening-book/forced-move exclusion (spec 202): a move with exactly one legal
// reply is not a choice, so it is excluded from BOTH estimators. True
// opening-book exclusion needs a book database this layer does not have; the
// error model's `opening` phase already carries the low early-move mistake rate,
// so opening moves are scored (not dropped) and flagged as a known limitation.

import { judgeMove, hasJudgmentNag, nodeEval } from "./annotations";
import type { MoveNode, NodeEval } from "./game-tree";
import { parseFen } from "chessops/fen";
import { Chess } from "chessops/chess";

/** A side needs at least this many scored moves before we'll estimate. */
const MIN_SCORED_MOVES = 4;

// Centipawn loss per move is clamped to this cap for the ACPL average (mate maps
// to the cap) so a single thrown mate doesn't swamp it — the mistake/blunder
// counts already carry the "this game had a catastrophe" signal.
const CAP_CP = 1000;

// Corpus-model feature constants — MUST match scripts/mining/error_model.py and
// scripts/persona/fit_error_model.py (band|phase|eval_bucket_lower|clock_bucket).
const MATE_CP = 10_000; // mining's MATE_CP: a mate tag becomes ±this before bucketing
const MISTAKE_DROP_CP = 100; // mover-POV eval drop >= 1.0 pawn == a "mistake"
const EVAL_BUCKET_CP = 50; // 0.5-pawn buckets
const EVAL_CLAMP_CP = 500; // eval clamped to [-5.0, +5.0) before bucketing
const ENDGAME_PHASE_MAX = 8; // persona.rs phase_for: material weight <= 8 => endgame
const OPENING_MAX_PLY = 16; // ...else opening while (0-based move index) < 16
const BAND_WIDTH = 100;

// Band-level corpus support below which a band is dropped by `regularizeFit`
// (see its doc). In error_model.fit.json the per-band move count falls off a
// cliff above ~2700 (2700 ≈ 106k moves; 2800 ≈ 31k, 3100 ≈ 533, 3200 ≈ 103) —
// exactly where the fitted mistake-rate curve stops being monotone in Elo and
// produces the artifact that made a blunder-heavy game read as a top band. A
// 100k-move floor keeps 1400–2700 and trims the noisy tail.
const COVERAGE_FLOOR_MOVES = 100_000;

// Approximate ACPL -> rating band (fallback path). Thresholds are rough and
// intentionally so (documented as approximate in every label). Midpoints are
// representative club/expert ratings, not a calibrated scale.
const ACPL_BANDS: { maxAcpl: number; band: number; bandLabel: string }[] = [
  { maxAcpl: 20, band: 2200, bandLabel: "2200+" },
  { maxAcpl: 35, band: 1900, bandLabel: "1900" },
  { maxAcpl: 60, band: 1600, bandLabel: "1600" },
  { maxAcpl: 90, band: 1300, bandLabel: "1300" },
  { maxAcpl: Infinity, band: 1100, bandLabel: "1100" },
];

/** The fitted corpus error model (data/personas/error_model.fit.json). */
export interface ErrorModelFit {
  meta: {
    /** Band labels present, e.g. ["1400", ..., "3200"] (100-Elo lower edges).
     *  After `regularizeFit`, only the adequately-sampled bands remain. */
    bands: string[];
    global_rate?: number;
    /** Set by `regularizeFit`. */
    regularized?: boolean;
    /** Band-level move floor used to trim sparse bands (null if unenforced). */
    coverageFloor?: number | null;
  };
  /** band label -> { cells: "phase|eval_bucket_lower|clock" -> P(mistake) };
   *  `moves` is the band's corpus support (present in the real fit, used by
   *  `regularizeFit` to trim inadequately-sampled bands). */
  bands: Record<string, { cells: Record<string, number>; moves?: number }>;
}

export interface SidePerformance {
  /** Representative Elo of the estimate (band midpoint for ACPL, band lower
   *  edge for the corpus model). */
  band: number;
  /** Human label — ALWAYS caveated, e.g.
   *  "performed like ~1500 — single game, wide range". */
  label: string;
  /** Which estimator produced this. */
  method: "error-model" | "acpl";
  /** 68%-ish range of the corpus-model estimate (Elo). Absent for ACPL. */
  low?: number;
  high?: number;
  /** Average centipawn loss over the side's scored moves. */
  acpl: number;
  mistakes: number;
  blunders: number;
  /** How many of the side's moves were scored (both evals present, not forced). */
  scored: number;
}

export interface PerformanceElo {
  white: SidePerformance | null;
  black: SidePerformance | null;
}

/** NodeEval -> white-perspective centipawns; mate becomes ±MATE_CP. */
function whitePovCp(ev: NodeEval): number {
  if (ev.mate !== undefined) return ev.mate > 0 ? MATE_CP : -MATE_CP;
  return ev.cp ?? 0;
}

/** Mover-POV cp -> "+0.0"-style bucket lower edge (error_model.py eval_bucket). */
function evalBucketLabel(moverCp: number): string {
  const clamped = Math.max(-EVAL_CLAMP_CP, Math.min(EVAL_CLAMP_CP - 1, moverCp));
  const lower = Math.floor(clamped / EVAL_BUCKET_CP) * EVAL_BUCKET_CP;
  const pawns = lower / 100;
  return `${pawns < 0 ? "" : "+"}${pawns.toFixed(1)}`;
}

/** [%clk] seconds -> clock bucket label (error_model.py clock_bucket). */
function clockBucketLabel(seconds: number | undefined): string {
  if (seconds === undefined) return "none";
  if (seconds >= 600) return "600plus";
  if (seconds >= 300) return "300-600";
  if (seconds >= 120) return "120-300";
  if (seconds >= 60) return "60-120";
  if (seconds >= 30) return "30-60";
  return "lt30";
}

/** persona.rs phase_for: endgame (by material) wins over the opening ply test.
 *  `weight` = knights+bishops (x1) + rooks (x2) + queens (x4), both sides (24 at
 *  the start); `moveIndex` is the 0-based move index (root's first move = 0). */
function phaseFor(weight: number, moveIndex: number): string {
  if (weight <= ENDGAME_PHASE_MAX) return "endgame";
  if (moveIndex < OPENING_MAX_PLY) return "opening";
  return "middlegame";
}

/** The position a mover faces (FEN before the move), parsed once and reused for
 *  the phase weight and the forced-move test. `null` if the FEN can't be read
 *  (should not happen for a chessops-built tree). */
function positionBefore(fen: string): {
  phaseWeight: number;
  legalMoveCount: number;
} | null {
  const setup = parseFen(fen);
  if (setup.isErr) return null;
  const board = setup.unwrap().board;
  const phaseWeight =
    board.knight.size() +
    board.bishop.size() +
    2 * board.rook.size() +
    4 * board.queen.size();
  const pos = Chess.fromSetup(setup.unwrap());
  if (pos.isErr) return { phaseWeight, legalMoveCount: 2 }; // unknown -> not forced
  let legalMoveCount = 0;
  for (const dests of pos.unwrap().allDests().values()) {
    legalMoveCount += dests.size();
  }
  return { phaseWeight, legalMoveCount };
}

interface Observation {
  key: string; // "phase|eval_bucket_lower|clock"
  mistake: boolean;
}

interface SideAccumulator {
  loss: number;
  scored: number;
  mistakes: number;
  blunders: number;
  obs: Observation[];
}

function emptyAcc(): SideAccumulator {
  return { loss: 0, scored: 0, mistakes: 0, blunders: 0, obs: [] };
}

/** Pool-adjacent-violators (isotonic regression) for a NON-INCREASING fit over
 *  an ordered sequence. Unweighted — the fit JSON carries no per-cell counts, so
 *  every band's cell weighs equally. Pooling collapses a run of violators to
 *  their mean, which also creates ties (equal-likelihood bands) that widen the
 *  reported range where the corpus can't distinguish. */
function isotonicNonIncreasing(y: number[]): number[] {
  const vals: number[] = [];
  const wts: number[] = [];
  for (const yi of y) {
    vals.push(yi);
    wts.push(1);
    // Non-increasing is violated when an earlier pool sits BELOW a later one.
    while (vals.length > 1 && vals[vals.length - 2] < vals[vals.length - 1]) {
      const v2 = vals.pop()!;
      const w2 = wts.pop()!;
      const v1 = vals.pop()!;
      const w1 = wts.pop()!;
      vals.push((v1 * w1 + v2 * w2) / (w1 + w2));
      wts.push(w1 + w2);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < vals.length; i++) {
    for (let k = 0; k < wts[i]; k++) out.push(vals[i]);
  }
  return out;
}

/**
 * Correct the fitted corpus model at score time (spec 202 follow-up) so a
 * single game's band estimate is trustworthy without refitting the corpus:
 *
 *  1. **Coverage clamp** — drop bands whose corpus support (band-level `moves`)
 *     is below `COVERAGE_FLOOR_MOVES`. In error_model.fit.json the top bands are
 *     sampled from a handful of games (3200 ≈ 103 moves), so their rates are
 *     noise; trimming them makes the top usable band an honest, open-ended
 *     ceiling instead of a spurious "~3200". If no band carries a `moves` count
 *     (e.g. a synthetic fixture), no clamp is applied.
 *  2. **Monotonicity** — within each (phase, eval, clock) cell, force the
 *     mistake rate to be non-increasing in Elo via isotonic regression. A
 *     stronger band can never have a higher modelled mistake rate, so more
 *     mistakes always pull the estimate DOWN, never up (the bug that made a
 *     blunder-heavy game out-rank a clean one).
 *
 * Pure and idempotent; memoize the result in the shell (it runs once per fit).
 */
export function regularizeFit(fit: ErrorModelFit): ErrorModelFit {
  const sorted = fit.meta.bands
    .map((label) => ({ label, value: Number.parseInt(label, 10), moves: fit.bands[label]?.moves }))
    .filter((b) => Number.isFinite(b.value))
    .sort((a, b) => a.value - b.value);

  const hasCounts = sorted.some((b) => typeof b.moves === "number");
  const usable = hasCounts
    ? sorted.filter((b) => (b.moves ?? 0) >= COVERAGE_FLOOR_MOVES)
    : sorted;
  // Never clamp everything away: if the floor is too aggressive for this fit,
  // keep the best-supported band rather than returning an unscoreable model.
  const kept = usable.length > 0 ? usable : sorted.slice(-1);
  const labels = kept.map((b) => b.label);
  const globalRate = fit.meta.global_rate ?? 0.15;

  const keys = new Set<string>();
  for (const { label } of kept) {
    for (const k of Object.keys(fit.bands[label]?.cells ?? {})) keys.add(k);
  }

  const bands: ErrorModelFit["bands"] = {};
  for (const { label, moves } of kept) bands[label] = { cells: {}, moves };
  for (const key of keys) {
    const curve = labels.map((label) => {
      const r = fit.bands[label]?.cells[key];
      return typeof r === "number" ? r : globalRate;
    });
    const mono = isotonicNonIncreasing(curve);
    labels.forEach((label, i) => {
      bands[label].cells[key] = mono[i];
    });
  }

  return {
    meta: {
      ...fit.meta,
      bands: labels,
      regularized: true,
      coverageFloor: hasCounts ? COVERAGE_FLOOR_MOVES : null,
    },
    bands,
  };
}

/** Log-likelihood band estimate over one side's classified moves. Returns null
 *  when the fit can't score the side (no bands, or no observation landed in a
 *  known cell). `atCeiling` is true when the estimate is pinned to the top
 *  usable band — the corpus can't resolve higher, so the label reads "~X+". */
function bandLikelihood(
  obs: Observation[],
  fit: ErrorModelFit,
): { band: number; low: number; high: number; atCeiling: boolean } | null {
  const bands = fit.meta.bands
    .map((b) => ({ label: b, value: Number.parseInt(b, 10) }))
    .filter((b) => Number.isFinite(b.value))
    .sort((a, b) => a.value - b.value);
  if (bands.length === 0) return null;
  const globalRate = fit.meta.global_rate ?? 0.15;

  let usable = 0;
  const logLik = bands.map(({ label }) => {
    const cells = fit.bands[label]?.cells ?? {};
    let ll = 0;
    for (const o of obs) {
      const raw = cells[o.key];
      const p = raw === undefined ? globalRate : raw;
      const clamped = Math.min(1 - 1e-6, Math.max(1e-6, p));
      ll += o.mistake ? Math.log(clamped) : Math.log(1 - clamped);
    }
    return ll;
  });
  // "usable" only cares that at least one observation matched a real cell; an
  // all-fallback score would still pick a band but carries no corpus signal.
  for (const o of obs) {
    if (fit.bands[bands[0].label]?.cells[o.key] !== undefined) usable += 1;
  }
  if (usable === 0) return null;

  const maxLl = Math.max(...logLik);
  const weights = logLik.map((ll) => Math.exp(ll - maxLl));
  const total = weights.reduce((a, b) => a + b, 0);
  const posterior = weights.map((w) => w / total);

  // Point estimate: the HIGHEST band within a whisker of the max posterior.
  // Monotonization can leave the top bands tied (a clean game the corpus can't
  // separate); taking the highest tied band reports the honest ceiling rather
  // than an arbitrary lower member of the pool.
  const maxPost = Math.max(...posterior);
  let mleIdx = 0;
  for (let i = 0; i < posterior.length; i++) {
    if (posterior[i] >= maxPost - 1e-9) mleIdx = i;
  }
  const atCeiling = mleIdx === bands.length - 1;

  // 68%-ish credible interval over band lower edges (uniform prior).
  let cum = 0;
  let low = bands[0].value;
  let high = bands[bands.length - 1].value;
  let lowSet = false;
  for (let i = 0; i < bands.length; i++) {
    cum += posterior[i];
    if (!lowSet && cum >= 0.16) {
      low = bands[i].value;
      lowSet = true;
    }
    if (cum >= 0.84) {
      high = bands[i].value;
      break;
    }
  }
  // The point estimate must lie within its own reported range — with only a
  // handful of scored moves the posterior is broad, so a peak at the ceiling can
  // sit above the 84th percentile. Widen to include it.
  const point = bands[mleIdx].value;
  return { band: point, low: Math.min(low, point), high: Math.max(high, point), atCeiling };
}

function finishSide(
  acc: SideAccumulator,
  fit: ErrorModelFit | null | undefined,
): SidePerformance | null {
  if (acc.scored < MIN_SCORED_MOVES) return null;
  const acpl = Math.round(acc.loss / acc.scored);

  if (fit) {
    const est = bandLikelihood(acc.obs, fit);
    if (est) {
      // At the top usable band the corpus can't resolve higher — report an
      // open-ended floor ("~2700+") rather than a false-precision point/CI.
      const point = est.atCeiling ? `~${est.band}+` : `~${est.band}`;
      return {
        band: est.band,
        method: "error-model",
        label: `performed like ${point} — single game, wide range`,
        low: est.low,
        high: est.high,
        acpl,
        mistakes: acc.mistakes,
        blunders: acc.blunders,
        scored: acc.scored,
      };
    }
  }

  // ACPL fallback.
  const rawAcpl = acc.loss / acc.scored;
  const hit =
    ACPL_BANDS.find((b) => rawAcpl < b.maxAcpl) ?? ACPL_BANDS[ACPL_BANDS.length - 1];
  return {
    band: hit.band,
    method: "acpl",
    label: `~${hit.bandLabel} performance — single game, rough`,
    acpl,
    mistakes: acc.mistakes,
    blunders: acc.blunders,
    scored: acc.scored,
  };
}

/**
 * Estimate each player's performance for THIS game from the mainline.
 *
 * `mainline` is the mainline node array INCLUDING the root at index 0 (exactly
 * what `GameTree.mainlineNodes()` returns). A move is *scored* only when the
 * position AND the position before it both carry an eval and the move was not
 * forced (more than one legal reply); a side with fewer than MIN_SCORED_MOVES
 * scored moves comes back null (not enough signal to judge).
 *
 * When `fit` is supplied, the band-likelihood corpus estimator is preferred;
 * otherwise (or when a side can't be scored against the corpus) the ACPL
 * fallback is used.
 */
export function estimatePerformance(
  mainline: MoveNode[],
  fit?: ErrorModelFit | null,
): PerformanceElo {
  const white = emptyAcc();
  const black = emptyAcc();

  for (let i = 1; i < mainline.length; i++) {
    const node = mainline[i];
    const prev = mainline[i - 1];
    const before = nodeEval(prev);
    const after = nodeEval(node);
    if (!before || !after) continue;

    // Forced moves aren't a choice — exclude from both estimators.
    const pos = positionBefore(prev.fen);
    if (pos && pos.legalMoveCount === 1) continue;

    const moverIsWhite = node.ply % 2 === 1;
    const acc = moverIsWhite ? white : black;
    const sign = moverIsWhite ? 1 : -1;

    const beforeMover = sign * whitePovCp(before);
    const afterMover = sign * whitePovCp(after);
    const drop = beforeMover - afterMover; // positive = the mover lost ground

    // ACPL uses a capped drop; the corpus mistake bit uses the raw 1-pawn rule.
    acc.loss += Math.max(0, Math.min(CAP_CP, drop));
    acc.scored += 1;

    if (pos) {
      const phase = phaseFor(pos.phaseWeight, node.ply - 1);
      const key = `${phase}|${evalBucketLabel(beforeMover)}|${clockBucketLabel(node.clock)}`;
      acc.obs.push({ key, mistake: drop >= MISTAKE_DROP_CP });
    }

    // Prefer the engine's stored judgment NAG (written by Analyze Game); fall
    // back to classifying the eval swing directly for imported [%eval] games.
    if (hasJudgmentNag(node.nags)) {
      if (node.nags.includes(4)) acc.blunders += 1;
      else if (node.nags.includes(2)) acc.mistakes += 1;
    } else {
      const j = judgeMove(before, after, moverIsWhite);
      if (j === "blunder") acc.blunders += 1;
      else if (j === "mistake") acc.mistakes += 1;
    }
  }

  return { white: finishSide(white, fit), black: finishSide(black, fit) };
}

export { MIN_SCORED_MOVES, BAND_WIDTH };

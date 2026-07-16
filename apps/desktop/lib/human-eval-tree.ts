// Tier-1 of the Elo-conditioned evaluator (spec 213 Phase 3) — the
// human-visible tree. Typed wrapper over the Rust `human_eval_tree` command
// (src-tauri/src/human_search.rs): a restricted minimax where each node's
// candidates are the top-p nucleus of the Maia-R policy and leaves are scored
// by fixed-depth Stockfish. Unlike tier-0 this needs no live Stockfish PV
// stream — the backend runs its own engine over the restricted tree.
//
// Experimental (spec's honest label): hyperparameters (top_p, depth, caps)
// are provisional until the E5 ablations freeze them.

import { getProviders } from "@/lib/platform";

// Extracted to @chessgui/core (spec 220 step 5); re-exported so existing
// importers keep working.
import type {
  HumanSweepResult,
  HumanTreeOptions,
  HumanTreeResult,
} from "@chessgui/core/human-eval-tree-types";
export type { HumanSweepResult, HumanTreeOptions, HumanTreeResult };

/**
 * Display clamp for tree pawns, mirroring tier-0's MATE_PAWNS: the backend
 * collapses mates to ±1000 pawns, which is a mate signal, not a blend input.
 */
export const TREE_MATE_PAWNS = 12;

export function clampTreePawns(pawns: number): number {
  return Math.max(-TREE_MATE_PAWNS, Math.min(TREE_MATE_PAWNS, pawns));
}

/**
 * Invoke args for `human_eval_tree` (exported pure so vitest can pin the
 * Rust command's camelCase parameter names without a Tauri shell; the
 * desktop provider in lib/platform/tauri.ts is the one real consumer).
 * Unset knobs are omitted — the backend owns the defaults.
 */
export function treeInvokeArgs(
  fen: string,
  band: number,
  opts: HumanTreeOptions = {}
): Record<string, unknown> {
  const args: Record<string, unknown> = { fen, band };
  if (opts.bandOpening !== undefined) args.bandOpening = opts.bandOpening;
  if (opts.bandMiddlegame !== undefined) args.bandMiddlegame = opts.bandMiddlegame;
  if (opts.bandEndgame !== undefined) args.bandEndgame = opts.bandEndgame;
  if (opts.depth !== undefined) args.depth = opts.depth;
  if (opts.topP !== undefined) args.topP = opts.topP;
  if (opts.maxCandidates !== undefined) args.maxCandidates = opts.maxCandidates;
  if (opts.maxNodes !== undefined) args.maxNodes = opts.maxNodes;
  if (opts.leafDepth !== undefined) args.leafDepth = opts.leafDepth;
  return args;
}

/**
 * Invoke args for `human_eval_sweep` (pure, vitest-pinned like treeInvokeArgs).
 * Sweeps the SCALAR slider — per-phase band overrides are meaningless when
 * the band itself is the swept variable, so only the shape knobs pass through.
 * The progress channel is added by the desktop provider, not here.
 */
export function sweepInvokeArgs(
  fen: string,
  bands: number[],
  opts: HumanTreeOptions = {}
): Record<string, unknown> {
  const args: Record<string, unknown> = { fen, bands };
  if (opts.depth !== undefined) args.depth = opts.depth;
  if (opts.topP !== undefined) args.topP = opts.topP;
  if (opts.maxCandidates !== undefined) args.maxCandidates = opts.maxCandidates;
  if (opts.maxNodes !== undefined) args.maxNodes = opts.maxNodes;
  if (opts.leafDepth !== undefined) args.leafDepth = opts.leafDepth;
  return args;
}

/**
 * Background sweep across `bands` → the perception curve (spec 213's flagship
 * visual): Eval_R per slider stop for one position. `onPoint` fires as each
 * stop lands, so the chart fills in progressively. Shares the backend session
 * TT with `humanEvalTree` — the selected band's stop is usually cached
 * already. Starting a new sweep cancels the previous one; a cancelled sweep
 * resolves (partial points, `cancelled: true`) rather than rejecting.
 */
export async function humanEvalSweep(
  fen: string,
  bands: number[],
  opts: HumanTreeOptions = {},
  onPoint?: (p: HumanTreeResult) => void
): Promise<HumanSweepResult> {
  return getProviders().engine.humanEvalSweep(fen, bands, opts, onPoint);
}

/** Cancel any in-flight sweep (position changed, tree mode off, unmount). */
export async function humanEvalSweepCancel(): Promise<void> {
  return getProviders().engine.humanEvalSweepCancel();
}

/**
 * Eval_R for `fen` at rating `band` via the restricted human-visible tree.
 * Rejects with the backend's error string (no lc0 / no stockfish / bad band);
 * callers degrade the same way tier-0 does. Deterministic per (fen, band,
 * knobs, Stockfish build) — repeat calls are served by the backend's
 * session transposition cache.
 */
export async function humanEvalTree(
  fen: string,
  band: number,
  opts: HumanTreeOptions = {}
): Promise<HumanTreeResult> {
  return getProviders().engine.humanEvalTree(fen, band, opts);
}

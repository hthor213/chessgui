// Tier-1 of the Elo-conditioned evaluator (spec 213 Phase 3) — the
// human-visible tree. Typed wrapper over the Rust `human_eval_tree` command
// (src-tauri/src/human_search.rs): a restricted minimax where each node's
// candidates are the top-p nucleus of the Maia-R policy and leaves are scored
// by fixed-depth Stockfish. Unlike tier-0 this needs no live Stockfish PV
// stream — the backend runs its own engine over the restricted tree.
//
// Experimental (spec's honest label): hyperparameters (top_p, depth, caps)
// are provisional until the E5 ablations freeze them.

import { invoke } from "@tauri-apps/api/core";

export interface HumanTreeOptions {
  /** Search depth in plies (backend default 3, clamped 1–6). */
  depth?: number;
  /** Cumulative policy mass per node's candidate set (default 0.8). */
  topP?: number;
  /** Hard cap on candidates per node (default 4). */
  maxCandidates?: number;
  /** Total node budget; past it nodes are scored as leaves (default 300). */
  maxNodes?: number;
  /** Fixed Stockfish depth for leaf evals (default 10). */
  leafDepth?: number;
}

export interface HumanTreeResult {
  band: number;
  /** Eval_R, White-POV centipawns (mates collapse to ~±100000). */
  cp_white: number;
  /** Eval_R, White-POV pawns. Mate-magnitude values need clampTreePawns. */
  pawns: number;
  depth: number;
  nodes: number;
  leaf_evals: number;
  tt_hits: number;
  /** Best human-visible line from the root, UCI. */
  pv: string[];
}

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
 * Rust command's camelCase parameter names without a Tauri shell). Unset
 * knobs are omitted — the backend owns the defaults.
 */
export function treeInvokeArgs(
  fen: string,
  band: number,
  opts: HumanTreeOptions = {}
): Record<string, unknown> {
  const args: Record<string, unknown> = { fen, band };
  if (opts.depth !== undefined) args.depth = opts.depth;
  if (opts.topP !== undefined) args.topP = opts.topP;
  if (opts.maxCandidates !== undefined) args.maxCandidates = opts.maxCandidates;
  if (opts.maxNodes !== undefined) args.maxNodes = opts.maxNodes;
  if (opts.leafDepth !== undefined) args.leafDepth = opts.leafDepth;
  return args;
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
  return invoke<HumanTreeResult>("human_eval_tree", treeInvokeArgs(fen, band, opts));
}

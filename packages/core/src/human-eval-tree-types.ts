// Human-eval-tree domain types (spec 213 Phase 3) — extracted to
// @chessgui/core (spec 220 step 5).

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

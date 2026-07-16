// Tier-0 of the Elo-conditioned evaluator ("Human eval") — the instant blend.
//
// Design doc §6, Tier 0:
//
//     Eval_R^fast = w·SF + (1−w)·anchor
//     w      = mass the Maia-R policy assigns to Stockfish's PV move
//     anchor = second-PV eval when MultiPV≥2 is available, else material eval
//
// Interpretation: if rating-R players overwhelmingly play the move Stockfish's
// +4 rests on, the +4 is human-real at R (w≈1, Eval_R≈SF). If the policy barely
// considers it, the position is worth its fallback value (w≈0, Eval_R≈anchor).
// This is a one-forward-pass approximation of the tier-1 human-visible tree at
// depth 1 — honest enough for a live slider, and the divergence from Stockfish
// is the product.
//
// Scope kept to tier-0's defining constraint — a SINGLE Maia forward pass per
// stop. The doc's optional refinements (averaging w over the first two PV plies;
// extra smoothing) would each cost another query/position and are deferred to
// tier 1, where the real restricted-tree search lives.
//
// All evals are White-POV pawns, matching every other eval in the app.

import type { UciScore, PvLine } from "@chessgui/core/uci-parser";
import type { MaiaPolicy } from "@/lib/maia";
import { computeMaterial } from "@chessgui/core/material";

/**
 * Bounded pawn-equivalent for a mate score inside the blend. A raw ±M value has
 * no pawn magnitude, and blending an unbounded number would swamp the anchor and
 * print absurd figures ("+100"). Tier-0's number is an approximation, not a mate
 * announcement, so a decisive-but-finite magnitude keeps the blend sane.
 */
export const MATE_PAWNS = 12;

/** UciScore -> White-POV pawns, with mates mapped to ±MATE_PAWNS. */
export function pawnsFromScore(score: UciScore, turn: "white" | "black"): number {
  const flip = turn === "black" ? -1 : 1;
  if (score.type === "mate") {
    return (score.value * flip > 0 ? 1 : -1) * MATE_PAWNS;
  }
  return (score.value * flip) / 100;
}

/** Signed White-POV material balance in pawns (the anchor fallback). */
export function materialPawns(fen: string): number {
  const m = computeMaterial(fen);
  if (m.advantage === "white") return m.points;
  if (m.advantage === "black") return -m.points;
  return 0;
}

/** Policy mass band R assigns to `uci` (0 if the move isn't listed). */
export function policyMass(policy: MaiaPolicy, uci: string): number {
  return policy.moves.find((m) => m.uci === uci)?.prob ?? 0;
}

export interface TierZeroInput {
  /** Stockfish eval, White-POV pawns (mate-bounded). */
  sfPawns: number;
  /** No-resource baseline, White-POV pawns. */
  anchorPawns: number;
  /** Policy mass on Stockfish's PV move, in [0, 1]. */
  w: number;
}

/** The core blend. Pure; clamps w defensively. */
export function evalRFast({ sfPawns, anchorPawns, w }: TierZeroInput): number {
  const cw = Math.min(1, Math.max(0, w));
  return cw * sfPawns + (1 - cw) * anchorPawns;
}

export interface HumanEvalArgs {
  fen: string;
  /** Side to move when the Stockfish `lines` were computed. */
  scoreTurn: "white" | "black";
  /** Stockfish PV lines for `fen` (multipv 1..N). */
  lines: PvLine[];
  /** Maia policy for `fen` at the chosen band. */
  policy: MaiaPolicy;
}

export interface HumanEvalResult {
  /** Eval_R^fast, White-POV pawns. */
  evalR: number;
  sfPawns: number;
  anchorPawns: number;
  /** Policy mass Stockfish's move got at this band. */
  w: number;
  anchorSource: "second-pv" | "material";
  /** Stockfish's PV move (UCI) that w measures. */
  pvMove: string;
}

/**
 * Assemble the tier-0 result from a Stockfish stream and a Maia policy for the
 * same position. Returns null when there's no usable Stockfish PV yet (nothing
 * to blend).
 */
export function computeHumanEval(args: HumanEvalArgs): HumanEvalResult | null {
  const top = args.lines.find((l) => l.multipv === 1);
  if (!top || top.uciMoves.length === 0) return null;

  const pvMove = top.uciMoves[0];
  const sfPawns = pawnsFromScore(top.score, args.scoreTurn);

  const second = args.lines.find((l) => l.multipv === 2);
  const anchorSource: "second-pv" | "material" = second ? "second-pv" : "material";
  const anchorPawns = second
    ? pawnsFromScore(second.score, args.scoreTurn)
    : materialPawns(args.fen);

  const w = policyMass(args.policy, pvMove);
  const evalR = evalRFast({ sfPawns, anchorPawns, w });

  return { evalR, sfPawns, anchorPawns, w, anchorSource, pvMove };
}

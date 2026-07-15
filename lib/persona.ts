// Typed wrapper over the Rust persona engine (src-tauri/src/persona.rs).
//
// Persona engine v1 (spec 214 "move-selection contract" steps 3+4+8+9): out of
// book, the rival picks a move by seeded sampling from the Maia policy with a
// Stockfish verification reweight, and returns a per-move decision log. The book
// phase stays in the frontend (spar-tab.tsx) and never reaches this command.

import { invoke } from "@tauri-apps/api/core";
import type { PersonaMove } from "@/lib/maia";

/** Per-move sampling + verification parameters (contract steps 3, 4). `seed` is
 *  per-game and `ply` per-move, so the RNG is seeded deterministically (step 8).
 *  `seed` must stay below 2^53 so it survives the JSON number round-trip. */
export interface PersonaParams {
  /** Maia rating band (the policy backend weights). */
  level: number;
  /** Global softmax sharpening over the combined policy+verification logit. */
  temperature: number;
  /** Policy-prior exponent in the reweight. */
  alpha: number;
  /** Eval-penalty coefficient (blunder suppression) in the reweight. */
  lambda: number;
  /** Candidate-set count cap (default 4 on the Rust side). */
  top_k?: number;
  /** Nucleus mass for the candidate set; overrides top_k when set. */
  top_p?: number;
  /** Stockfish verification depth; 0/undefined disables it (policy-only). */
  verify_depth?: number;
  /** Per-game seed. */
  seed: number;
  /** Half-move index within the game. */
  ply: number;
}

/** One candidate move's decision record (contract step 9). */
export interface PersonaCandidate {
  uci: string;
  san: string;
  /** Raw Maia policy probability. */
  policy_prob: number;
  /** Verification eval in centipawns, mover-POV; null when not verified. */
  eval_cp: number | null;
  /** Pawns behind the best-evaluated candidate (>= 0). */
  eval_penalty: number;
  /** Normalized final sampling weight. */
  weight: number;
}

/** The persona's move plus its per-move decision log (contract step 9). */
export interface PersonaDecision {
  uci: string;
  san: string;
  /** "verify-reweight" when Stockfish ran, "policy" otherwise. */
  reason: string;
  band: number;
  /** Per-move seed derived from (seed, ply); logged for reproducibility. */
  derived_seed: number;
  candidates: PersonaCandidate[];
}

/** v1 defaults: low temperature keeps the rival near human-plausible moves while
 *  the verification reweight (lambda) suppresses non-human blunders. Tunable
 *  per-persona later (spec 214 auto-tuning checklist item). */
export const DEFAULT_PERSONA_PARAMS = {
  temperature: 0.5,
  alpha: 1.0,
  lambda: 0.75,
  top_k: 4,
  verify_depth: 12,
} as const;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * The rival's out-of-book move for `fen` under `params`, with its decision log.
 * Outside Tauri (Playwright / unit tests) a mock returns a canned legal move
 * wrapped in a single-candidate decision so the spar flow is drivable headless.
 */
export async function personaMove(
  fen: string,
  params: PersonaParams,
): Promise<PersonaDecision> {
  if (!isTauri()) {
    return import("./persona-mock").then((m) => m.mockPersonaMove(fen, params));
  }
  return invoke<PersonaDecision>("persona_move", { fen, params });
}

/** Narrow a decision back to the bare move the spar loop applies. */
export function decisionToMove(d: PersonaDecision): PersonaMove {
  return { uci: d.uci, san: d.san };
}

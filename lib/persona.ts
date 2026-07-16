// Typed wrapper over the Rust persona engine (src-tauri/src/persona.rs).
//
// Persona engine (spec 214 "move-selection contract" steps 3+4+6+8+9): out of
// book, the rival picks a move by seeded sampling from the Maia policy with a
// Stockfish verification reweight — temperature scheduled by phase × clock,
// with an optional post-book style-bias window (step 3) and an endgame arm
// that switches the candidate source to deep Stockfish at low material
// (step 6) — and returns a per-move decision log. The book phase stays in the
// frontend (spar-tab.tsx) and never reaches this command.

import { getProviders } from "@/lib/platform";
import type { PersonaMove } from "@/lib/maia";

/** Temperature schedule (contract step 3): the base temperature is multiplied
 *  by a per-phase factor and a clock-pressure factor, clamped to [0.05, 3.0]
 *  on the Rust side. All fields optional — unset fields keep the Rust
 *  defaults (serde `#[serde(default)]`). */
export interface TemperatureSchedule {
  opening_mult?: number;
  middlegame_mult?: number;
  endgame_mult?: number;
  /** Own clock at or below this (ms) applies low_time_mult. */
  low_time_ms?: number;
  low_time_mult?: number;
  /** Own clock at or below this (ms) applies panic_mult instead. */
  panic_time_ms?: number;
  panic_mult?: number;
}

/** Post-book style-bias window (contract step 3): for `window_plies` after
 *  book exit, candidates matching any listed move type get their policy prior
 *  multiplied by `multiplier`. OFF by default (never sent) until the metrics
 *  harness can gate it — spec 214 hard rule: measured improvement before
 *  style claims. */
export interface StyleBias {
  window_plies: number;
  multiplier: number;
  /** v1 move classes: "capture" | "check" | "castle" | "pawn_push" | "quiet_piece". */
  move_types: string[];
}

/** Endgame arm (contract step 6): at low non-pawn material (phase weight <=
 *  phase_max; 24 at the start, endgame at <= 8) the candidate source switches
 *  to deep fixed-depth Stockfish MultiPV top-k, still humanized through the
 *  verification reweight. */
export interface EndgameArm {
  /** Non-pawn phase weight at or below which the arm engages (default 8). */
  phase_max?: number;
  /** Fixed Stockfish depth for candidate generation; 0 disables (default 16). */
  depth?: number;
  /** MultiPV candidate count (default 4). */
  top_k?: number;
}

/** Per-move sampling + verification parameters (contract steps 3, 4, 6). `seed`
 *  is per-game and `ply` per-move, so the RNG is seeded deterministically
 *  (step 8). `seed` must stay below 2^53 so it survives the JSON number
 *  round-trip. */
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
  /** Own remaining clock, ms. The spar loop is unclocked today, so this stays
   *  undefined there (no time-pressure spike); the Rust match runner passes
   *  the real clock. Honest note: contract step 3's clock dimension is
   *  implemented but only live where a clock exists. */
  clock_ms?: number;
  /** Plies since the position left the persona's book; undefined = unknown
   *  (the style-bias window never fires). */
  plies_since_book_exit?: number;
  /** Temperature schedule; undefined = flat `temperature` (v1 behavior). */
  schedule?: TemperatureSchedule;
  /** Style-bias window; undefined = OFF (the default, see StyleBias). */
  style_bias?: StyleBias;
  /** Endgame arm; undefined = disabled. */
  endgame?: EndgameArm;
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
  /** "endgame" when the endgame arm supplied the candidates, "verify-reweight"
   *  when Stockfish verification ran, "policy" otherwise. */
  reason: string;
  band: number;
  /** Per-move seed derived from (seed, ply); logged for reproducibility. */
  derived_seed: number;
  /** Detected phase: "opening" | "middlegame" | "endgame". Optional because
   *  the headless mock predates it; the Rust engine always sends it. */
  phase?: string;
  /** Effective (post-schedule) sampling temperature actually used. */
  temperature?: number;
  /** True when the style-bias window fired and a candidate matched. */
  style_bias_applied?: boolean;
  candidates: PersonaCandidate[];
}

/** Defaults: low temperature keeps the rival near human-plausible moves while
 *  the verification reweight (lambda) suppresses non-human blunders; the
 *  schedule scales temperature by phase (the clock dimension stays inert in
 *  the unclocked spar loop) and the endgame arm switches the candidate source
 *  to deep Stockfish at low material (contract steps 3 + 6). Style bias is
 *  deliberately ABSENT here — OFF until measured (spec 214 hard rule). All
 *  numbers untuned (auto-tuning is its own spec 214 checklist item). */
export const DEFAULT_PERSONA_PARAMS = {
  temperature: 0.5,
  alpha: 1.0,
  lambda: 0.75,
  top_k: 4,
  verify_depth: 12,
  /** Rust-side defaults spelled out for visibility. */
  schedule: {
    opening_mult: 0.6,
    middlegame_mult: 1.0,
    endgame_mult: 0.8,
    low_time_ms: 30_000,
    low_time_mult: 1.5,
    panic_time_ms: 10_000,
    panic_mult: 2.25,
  },
  endgame: { phase_max: 8, depth: 16, top_k: 4 },
} as const;

/**
 * The rival's out-of-book move for `fen` under `params`, with its decision log.
 * The browser provider (Playwright / unit tests) returns a canned legal move
 * wrapped in a single-candidate decision so the spar flow is drivable headless.
 */
export async function personaMove(
  fen: string,
  params: PersonaParams,
): Promise<PersonaDecision> {
  return getProviders().engine.personaMove(fen, params);
}

/** Narrow a decision back to the bare move the spar loop applies. */
export function decisionToMove(d: PersonaDecision): PersonaMove {
  return { uci: d.uci, san: d.san };
}

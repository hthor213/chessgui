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

// Extracted to @chessgui/core (spec 220 step 5); re-exported so existing
// importers keep working.
import type {
  EndgameArm,
  PersonaCandidate,
  PersonaDecision,
  PersonaParams,
  StyleBias,
  TemperatureSchedule,
} from "@chessgui/core/persona-types";
export type {
  EndgameArm,
  PersonaCandidate,
  PersonaDecision,
  PersonaParams,
  StyleBias,
  TemperatureSchedule,
};

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

/** Band-dependent sampling shape (realism audit waves R1.3 + R3.3, TS half):
 *  candidate width, policy floor, and endgame-arm depth are functions of the
 *  persona's HONEST Maia band — a 1300 gets a wide, low-floor candidate set
 *  and a shallow endgame arm so it botches endings at 1300-rate, instead of
 *  every band converting R+P endings with depth-16 Stockfish (the audit's
 *  "always-ON pieces overshoot the band" finding). Full strength (the BT3
 *  managed net) counts as the top band. Callers spread this AFTER a config's
 *  stored sampling overrides: every committed config today carries the same
 *  untuned defaults (audit item 5), so for these three knobs the band is the
 *  more honest signal — revisit the ordering when wave R2 lands per-persona
 *  tuned values. */
export function bandSamplingParams(
  level: number,
  fullStrength = false,
): Pick<PersonaParams, "top_k" | "policy_floor" | "endgame"> {
  const band = fullStrength ? Infinity : level;
  return {
    top_k: band <= 1300 ? 6 : band <= 1600 ? 5 : 4,
    policy_floor: band <= 1300 ? 0.005 : band <= 1600 ? 0.008 : 0.01,
    endgame: {
      ...DEFAULT_PERSONA_PARAMS.endgame,
      depth: band <= 1200 ? 6 : band <= 1500 ? 8 : band <= 1900 ? 10 : 16,
    },
  };
}

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

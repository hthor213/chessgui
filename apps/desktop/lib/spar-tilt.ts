// Tilt / momentum state (spec 214 realism audit, wave R3.1).
//
// Human error is bursty, not i.i.d. — a blunder rattles the next few moves,
// and a position sliding away loosens play while the slide lasts. This is a
// small per-game hidden state, updated from each of the bot's own decisions
// (the step-9 decision log carries everything needed), read back as a pair of
// multipliers on the sampling params passed to persona_move: temperature up,
// lambda (the blunder-suppression coefficient) down. This modulates the
// HUMAN-model sampling only — it is context-conditioned parameters, never
// noise-weakening an engine (spec 214 hard rule). Tilt is felt, not
// announced: no UI badge, but the applied multipliers are recorded alongside
// the stored decision log so realism debugging can see them.

import type { PersonaDecision } from "@/lib/persona";
import { chosenCandidateEvalPawns } from "@/lib/spar-think-time";

export const TILT = {
  /** (a) Blunder tilt: chosen candidate at least this many pawns behind the
   *  best candidate → the next BLUNDER_WINDOW_MOVES own moves are tilted. */
  BLUNDER_DROP_PAWNS: 1.5,
  BLUNDER_WINDOW_MOVES: 4,
  BLUNDER_TEMP_MULT: 1.3,
  BLUNDER_LAMBDA_MULT: 0.7,
  /** (b) Worsening trend: bot-POV chosen eval fell at least this many pawns
   *  across the trend window → looser while it persists. The window is 4 own
   *  decisions — first to last spans 6 plies of game, the audit's "over the
   *  last 6 plies". */
  TREND_DROP_PAWNS: 2.0,
  TREND_WINDOW_DECISIONS: 4,
  TREND_TEMP_MULT: 1.15,
  /** Composition caps: multipliers compose, but never past these. */
  TEMP_MULT_CAP: 1.6,
  LAMBDA_MULT_FLOOR: 0.6,
} as const;

export interface TiltState {
  /** Own moves still inside the blunder-tilt window (counts down per move). */
  blunderMovesLeft: number;
  /** Chosen-candidate evals (bot POV, pawns) of the last own decisions,
   *  oldest first, capped at TREND_WINDOW_DECISIONS. Unverified decisions
   *  (no eval) contribute nothing. */
  recentOwnEvals: number[];
}

export const INITIAL_TILT_STATE: TiltState = { blunderMovesLeft: 0, recentOwnEvals: [] };

export interface TiltMultipliers {
  temperatureMult: number;
  lambdaMult: number;
}

/** The multipliers to apply to the NEXT own move's temperature and lambda. */
export function tiltMultipliers(s: TiltState): TiltMultipliers {
  let temperatureMult = 1;
  let lambdaMult = 1;
  if (s.blunderMovesLeft > 0) {
    temperatureMult *= TILT.BLUNDER_TEMP_MULT;
    lambdaMult *= TILT.BLUNDER_LAMBDA_MULT;
  }
  if (worseningTrend(s.recentOwnEvals)) temperatureMult *= TILT.TREND_TEMP_MULT;
  return {
    temperatureMult: Math.min(temperatureMult, TILT.TEMP_MULT_CAP),
    lambdaMult: Math.max(lambdaMult, TILT.LAMBDA_MULT_FLOOR),
  };
}

function worseningTrend(evals: number[]): boolean {
  if (evals.length < TILT.TREND_WINDOW_DECISIONS) return false;
  const first = evals[evals.length - TILT.TREND_WINDOW_DECISIONS];
  const last = evals[evals.length - 1];
  return last <= first - TILT.TREND_DROP_PAWNS;
}

/** Whether a decision chose a move >= BLUNDER_DROP_PAWNS behind the best
 *  candidate (eval_penalty is exactly that gap, Rust-computed; unverified
 *  candidates can't testify either way). */
export function isBlunder(d: PersonaDecision): boolean {
  const chosen = d.candidates.find((c) => c.uci === d.uci);
  return !!chosen && chosen.eval_cp != null && chosen.eval_penalty >= TILT.BLUNDER_DROP_PAWNS;
}

/**
 * Fold one own decision into the state. Call AFTER the decision came back
 * (its params were sampled under the multipliers read from the PREVIOUS
 * state): a blunder (re)arms the full window; any other move consumes one
 * window move, so a blunder tilts exactly the next BLUNDER_WINDOW_MOVES
 * own moves.
 */
export function updateTilt(s: TiltState, decision: PersonaDecision): TiltState {
  const blunderMovesLeft = isBlunder(decision)
    ? TILT.BLUNDER_WINDOW_MOVES
    : Math.max(0, s.blunderMovesLeft - 1);
  const evalPawns = chosenCandidateEvalPawns(decision);
  const recentOwnEvals =
    evalPawns == null
      ? s.recentOwnEvals
      : [...s.recentOwnEvals, evalPawns].slice(-TILT.TREND_WINDOW_DECISIONS);
  return { blunderMovesLeft, recentOwnEvals };
}

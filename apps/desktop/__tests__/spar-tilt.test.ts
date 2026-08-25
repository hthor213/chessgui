import { describe, expect, it } from "vitest";
import {
  INITIAL_TILT_STATE,
  isBlunder,
  TILT,
  tiltMultipliers,
  updateTilt,
  type TiltState,
} from "@/lib/spar-tilt";
import type { PersonaDecision } from "@/lib/persona";

// Spec 214 realism audit wave R3.1: per-game tilt/momentum state — a recent
// blunder loosens the next 4 own moves, a worsening eval trend loosens play
// while it lasts. Read as multipliers on temperature/lambda; the state is
// pure, so every transition is directly assertable.

/** A decision whose CHOSEN move sits `penaltyPawns` behind the best
 *  candidate, with the chosen eval at `chosenEvalPawns` (bot POV). */
function mkDecision(chosenEvalPawns: number | null, penaltyPawns = 0): PersonaDecision {
  return {
    uci: "m0",
    san: "M0",
    reason: "verify-reweight",
    band: 1700,
    derived_seed: 1,
    phase: "middlegame",
    candidates: [
      {
        uci: "m0",
        san: "M0",
        policy_prob: 0.5,
        eval_cp: chosenEvalPawns == null ? null : Math.round(chosenEvalPawns * 100),
        eval_penalty: penaltyPawns,
        weight: 0.5,
      },
      {
        uci: "m1",
        san: "M1",
        policy_prob: 0.5,
        eval_cp: chosenEvalPawns == null ? null : Math.round((chosenEvalPawns + penaltyPawns) * 100),
        eval_penalty: 0,
        weight: 0.5,
      },
    ],
  };
}

describe("isBlunder", () => {
  it("fires when the chosen candidate is ≥1.5 pawns behind the best", () => {
    expect(isBlunder(mkDecision(-1.0, 1.6))).toBe(true);
    expect(isBlunder(mkDecision(-1.0, 1.5))).toBe(true);
    expect(isBlunder(mkDecision(-1.0, 1.4))).toBe(false);
    // Unverified decisions can't testify.
    expect(isBlunder(mkDecision(null, 2.0))).toBe(false);
  });
});

describe("blunder tilt — temperature ×1.3, lambda ×0.7 for the next 4 own moves", () => {
  it("arms on a blunder and decays after exactly 4 clean moves", () => {
    let s: TiltState = INITIAL_TILT_STATE;
    expect(tiltMultipliers(s)).toEqual({ temperatureMult: 1, lambdaMult: 1 });

    s = updateTilt(s, mkDecision(-2.0, 2.0)); // the blunder
    for (let i = 0; i < TILT.BLUNDER_WINDOW_MOVES; i++) {
      expect(tiltMultipliers(s).temperatureMult).toBeCloseTo(TILT.BLUNDER_TEMP_MULT);
      expect(tiltMultipliers(s).lambdaMult).toBeCloseTo(TILT.BLUNDER_LAMBDA_MULT);
      s = updateTilt(s, mkDecision(-2.0, 0)); // a clean move consumes one
    }
    expect(tiltMultipliers(s)).toEqual({ temperatureMult: 1, lambdaMult: 1 });
  });

  it("a fresh blunder re-arms the full window", () => {
    let s = updateTilt(INITIAL_TILT_STATE, mkDecision(-2.0, 2.0));
    s = updateTilt(s, mkDecision(-2.0, 0));
    s = updateTilt(s, mkDecision(-4.0, 2.0)); // blunders again mid-window
    expect(s.blunderMovesLeft).toBe(TILT.BLUNDER_WINDOW_MOVES);
  });
});

describe("worsening trend — temperature ×1.15 while the slide persists", () => {
  it("fires when the eval fell ≥2 pawns across the 4-decision (6-ply) window", () => {
    let s: TiltState = INITIAL_TILT_STATE;
    for (const e of [0.0, -0.5, -1.0, -2.5]) s = updateTilt(s, mkDecision(e, 0));
    expect(tiltMultipliers(s)).toEqual({
      temperatureMult: TILT.TREND_TEMP_MULT,
      lambdaMult: 1,
    });
    // The position stabilizes: the window slides past the drop and it clears.
    for (const e of [-2.4, -2.3, -2.2]) s = updateTilt(s, mkDecision(e, 0));
    expect(tiltMultipliers(s)).toEqual({ temperatureMult: 1, lambdaMult: 1 });
  });

  it("needs a full window of evals — a short game never fires it", () => {
    let s: TiltState = INITIAL_TILT_STATE;
    for (const e of [0.0, -3.0]) s = updateTilt(s, mkDecision(e, 0));
    expect(tiltMultipliers(s).temperatureMult).toBe(1);
  });

  it("unverified decisions contribute nothing to the eval window", () => {
    let s: TiltState = INITIAL_TILT_STATE;
    for (const e of [0.0, -0.5]) s = updateTilt(s, mkDecision(e, 0));
    const before = s.recentOwnEvals;
    s = updateTilt(s, mkDecision(null, 0));
    expect(s.recentOwnEvals).toEqual(before);
  });
});

describe("composition and caps", () => {
  it("blunder + trend compose (1.3 × 1.15), lambda stays at the blunder mult", () => {
    let s: TiltState = INITIAL_TILT_STATE;
    for (const e of [0.0, -0.5, -1.0]) s = updateTilt(s, mkDecision(e, 0));
    s = updateTilt(s, mkDecision(-2.5, 2.0)); // blunder AND completes the slide
    const m = tiltMultipliers(s);
    expect(m.temperatureMult).toBeCloseTo(
      Math.min(TILT.BLUNDER_TEMP_MULT * TILT.TREND_TEMP_MULT, TILT.TEMP_MULT_CAP),
    );
    expect(m.temperatureMult).toBeLessThanOrEqual(TILT.TEMP_MULT_CAP);
    expect(m.lambdaMult).toBeCloseTo(TILT.BLUNDER_LAMBDA_MULT);
    expect(m.lambdaMult).toBeGreaterThanOrEqual(TILT.LAMBDA_MULT_FLOOR);
  });
});

import { describe, it, expect } from "vitest";
import {
  personaMove,
  decisionToMove,
  DEFAULT_PERSONA_PARAMS,
  bandSamplingParams,
  type PersonaParams,
} from "@/lib/persona";
import { mockPersonaMove } from "@/lib/persona-mock";
import { applyUci } from "@/lib/spar";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function params(overrides: Partial<PersonaParams> = {}): PersonaParams {
  return { ...DEFAULT_PERSONA_PARAMS, level: 1700, seed: 42, ply: 0, ...overrides };
}

// These exercise the frontend wiring contract (types + wrapper + headless mock),
// NOT the Rust persona engine — outside Tauri `personaMove` resolves to the mock,
// so lc0/Stockfish are never touched here. The Rust sampling + reweight math is
// unit-tested in src-tauri/src/persona.rs.
describe("persona engine wiring (headless mock)", () => {
  it("returns a legal move wrapped in a decision log", async () => {
    const decision = await mockPersonaMove(START, params());
    expect(applyUci(START, decision.uci)).not.toBeNull();
    // Contract step 9 shape: a chosen move, a reason arm, and a candidate list.
    expect(decision.candidates.length).toBeGreaterThan(0);
    expect(decision.candidates[0].uci).toBe(decision.uci);
    expect(["policy", "verify-reweight"]).toContain(decision.reason);
    expect(typeof decision.derived_seed).toBe("number");
  });

  it("personaMove falls back to the mock outside Tauri", async () => {
    // In the vitest node env `window` is undefined, so the wrapper uses the mock
    // rather than invoking Tauri — the same path Playwright/headless runs take.
    const decision = await personaMove(START, params());
    expect(applyUci(START, decision.uci)).not.toBeNull();
    expect(decisionToMove(decision)).toEqual({ uci: decision.uci, san: decision.san });
  });

  it("carries the requested band and seed through", async () => {
    const decision = await mockPersonaMove(START, params({ level: 1900, seed: 7, ply: 3 }));
    expect(decision.band).toBe(1900);
    expect(Number.isFinite(decision.derived_seed)).toBe(true);
  });
});

// Contract steps 3 + 6 plumbing (spec 214): the defaults ship the temperature
// schedule and the endgame arm, style bias stays OFF until measured, and the
// new optional params flow through the wrapper without breaking headless runs.
describe("persona depth params (contract steps 3 + 6)", () => {
  it("defaults ship schedule + endgame arm, but never style bias", () => {
    expect(DEFAULT_PERSONA_PARAMS.schedule).toBeDefined();
    expect(DEFAULT_PERSONA_PARAMS.schedule.opening_mult).toBeLessThan(
      DEFAULT_PERSONA_PARAMS.schedule.middlegame_mult,
    );
    expect(DEFAULT_PERSONA_PARAMS.endgame).toBeDefined();
    expect(DEFAULT_PERSONA_PARAMS.endgame.depth).toBeGreaterThan(
      DEFAULT_PERSONA_PARAMS.verify_depth,
    );
    // Spec 214 hard rule: no style claims without measured improvement —
    // the bias must not be part of the defaults.
    expect("style_bias" in DEFAULT_PERSONA_PARAMS).toBe(false);
  });

  it("new optional params pass through the headless mock unharmed", async () => {
    const decision = await personaMove(START, {
      ...params(),
      clock_ms: 15_000,
      plies_since_book_exit: 2,
      schedule: { opening_mult: 0.7 },
      style_bias: { window_plies: 4, multiplier: 1.5, move_types: ["capture"] },
      endgame: { depth: 14 },
    });
    expect(applyUci(START, decision.uci)).not.toBeNull();
  });

  it("mock decisions carry the step-3 log fields", async () => {
    const opening = await mockPersonaMove(START, params({ ply: 0 }));
    expect(opening.phase).toBe("opening");
    expect(opening.temperature).toBe(DEFAULT_PERSONA_PARAMS.temperature);
    expect(opening.style_bias_applied).toBe(false);
    const middlegame = await mockPersonaMove(START, params({ ply: 20 }));
    expect(middlegame.phase).toBe("middlegame");
  });
});

// Realism audit waves R1.3 + R3.3 (TS half): candidate width, policy floor,
// and endgame-arm depth track the persona's HONEST band — a 1300 must botch
// endings at 1300-rate and keep off-policy human moves reachable, while full
// strength (BT3) counts as the top band.
describe("bandSamplingParams — per-band width / floor / endgame depth", () => {
  it("maps each band to the audit's depth/top_k/policy_floor table", () => {
    expect(bandSamplingParams(1100)).toEqual({
      top_k: 6,
      policy_floor: 0.005,
      endgame: { phase_max: 8, depth: 6, top_k: 4 },
    });
    expect(bandSamplingParams(1200).endgame?.depth).toBe(6);
    expect(bandSamplingParams(1300)).toMatchObject({
      top_k: 6,
      policy_floor: 0.005,
      endgame: { depth: 8 },
    });
    expect(bandSamplingParams(1500)).toMatchObject({
      top_k: 5,
      policy_floor: 0.008,
      endgame: { depth: 8 },
    });
    expect(bandSamplingParams(1600)).toMatchObject({
      top_k: 5,
      policy_floor: 0.008,
      endgame: { depth: 10 },
    });
    expect(bandSamplingParams(1900)).toMatchObject({
      top_k: 4,
      policy_floor: 0.01,
      endgame: { depth: 10 },
    });
  });

  it("full strength (BT3) counts as the top band regardless of fallback level", () => {
    expect(bandSamplingParams(1900, true)).toEqual({
      top_k: 4,
      policy_floor: 0.01,
      endgame: { phase_max: 8, depth: 16, top_k: 4 },
    });
    // The Maia fallback level does not drag a full-strength persona down.
    expect(bandSamplingParams(1100, true).endgame?.depth).toBe(16);
  });

  it("keeps the non-depth endgame fields at the shipped defaults", () => {
    const arm = bandSamplingParams(1300).endgame;
    expect(arm?.phase_max).toBe(DEFAULT_PERSONA_PARAMS.endgame.phase_max);
    expect(arm?.top_k).toBe(DEFAULT_PERSONA_PARAMS.endgame.top_k);
  });
});

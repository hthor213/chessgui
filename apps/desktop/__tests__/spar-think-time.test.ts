import { describe, expect, it } from "vitest";
import {
  bestCandidateEvalPawns,
  chosenCandidateEvalPawns,
  forcednessSignals,
  sparThinkTimeMs,
  THINK_TIME,
  type ThinkTimeInput,
} from "@/lib/spar-think-time";
import type { PersonaDecision } from "@/lib/persona";

// Spec 214 contract step 10 (realism audit wave R1.1): think-time computed
// from the decision the pipeline already made. Everything here is pure given
// the injected rng, so the arms and multipliers are directly assertable.

/** rng returning a fixed sequence (then repeating its last value). */
function seq(...vals: number[]): () => number {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)];
}

function mkDecision(
  weights: number[],
  overrides: Partial<PersonaDecision> = {},
  evals: (number | null)[] = [],
): PersonaDecision {
  return {
    uci: "m0",
    san: "M0",
    reason: "verify-reweight",
    band: 1700,
    derived_seed: 1,
    phase: "middlegame",
    candidates: weights.map((w, i) => ({
      uci: `m${i}`,
      san: `M${i}`,
      policy_prob: w,
      eval_cp: evals[i] ?? null,
      eval_penalty: 0,
      weight: w,
    })),
    ...overrides,
  };
}

const CALM = { onlyMove: false, recapture: false };

function input(overrides: Partial<ThinkTimeInput>): ThinkTimeInput {
  return {
    reason: "verify-reweight",
    decision: mkDecision([0.9, 0.1]),
    ply: 30,
    remainingClockMs: null,
    prevOwnBestEvalPawns: null,
    forced: CALM,
    rng: seq(0),
    ...overrides,
  };
}

describe("forcednessSignals (chessops)", () => {
  it("detects an only-move position", () => {
    // White Ka1 in check from Qb2; Kxb2 is the single legal move.
    const fen = "k7/8/8/8/8/8/1q6/K7 w - - 0 1";
    expect(forcednessSignals(fen, "a1b2", null).onlyMove).toBe(true);
  });

  it("a normal position is not an only-move", () => {
    const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    expect(forcednessSignals(start, "e2e4", null).onlyMove).toBe(false);
  });

  it("detects a recapture on the square the opponent just captured on", () => {
    const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const lastPly = { san: "Qxd5", uci: "c4d5" };
    expect(forcednessSignals(start, "e6d5", lastPly).recapture).toBe(true);
    // Different destination square, or a quiet last move → no recapture.
    expect(forcednessSignals(start, "e6e5", lastPly).recapture).toBe(false);
    expect(forcednessSignals(start, "e6d5", { san: "Qd5", uci: "c4d5" }).recapture).toBe(false);
  });
});

describe("decision eval readers", () => {
  it("best/chosen candidate evals in pawns, null when unverified", () => {
    const d = mkDecision([0.6, 0.4], {}, [-50, 25]);
    expect(bestCandidateEvalPawns(d)).toBe(0.25);
    expect(chosenCandidateEvalPawns(d)).toBe(-0.5);
    const unverified = mkDecision([1]);
    expect(bestCandidateEvalPawns(unverified)).toBeNull();
    expect(chosenCandidateEvalPawns(unverified)).toBeNull();
  });
});

describe("sparThinkTimeMs — arms (unclocked, middlegame)", () => {
  it("book replies are brisk recall: 400–1500ms", () => {
    const base = { reason: "book", decision: null };
    expect(sparThinkTimeMs(input({ ...base, rng: seq(0) }))).toBe(400);
    expect(sparThinkTimeMs(input({ ...base, rng: seq(1) }))).toBe(1500);
  });

  it("only-moves and recaptures snap: 300–900ms (beats every other arm)", () => {
    const forced = { onlyMove: true, recapture: false };
    expect(sparThinkTimeMs(input({ forced, rng: seq(0) }))).toBe(300);
    expect(sparThinkTimeMs(input({ forced, rng: seq(1) }))).toBe(900);
    const recapture = { onlyMove: false, recapture: true };
    expect(sparThinkTimeMs(input({ reason: "book", forced: recapture, rng: seq(0) }))).toBe(300);
  });

  it("a dominant top candidate (weight > 0.8) is a quick decision: 1–4s", () => {
    const d = mkDecision([0.9, 0.1]);
    expect(sparThinkTimeMs(input({ decision: d, rng: seq(0) }))).toBe(1000);
    expect(sparThinkTimeMs(input({ decision: d, rng: seq(1) }))).toBe(4000);
  });

  it("mid-shaped distributions take a normal think: 1.5–6s", () => {
    const d = mkDecision([0.7, 0.2, 0.1]); // top in (0.5, 0.8], gap 0.5
    expect(sparThinkTimeMs(input({ decision: d, rng: seq(0, 1) }))).toBe(1500);
    expect(sparThinkTimeMs(input({ decision: d, rng: seq(1, 1) }))).toBe(6000);
  });

  it("close calls (top < 0.5, or top-2 gap < 0.15) take a real think: 5–20s", () => {
    const lowTop = mkDecision([0.4, 0.3, 0.2, 0.1]);
    expect(sparThinkTimeMs(input({ decision: lowTop, rng: seq(0, 1) }))).toBe(5000);
    // The max draw needs an ample clock — unclocked it hits the 12s cap.
    expect(
      sparThinkTimeMs(input({ decision: lowTop, remainingClockMs: 600_000, rng: seq(1, 1) })),
    ).toBe(20_000);
    const narrowGap = mkDecision([0.55, 0.45]);
    expect(sparThinkTimeMs(input({ decision: narrowGap, rng: seq(0, 1) }))).toBe(5000);
  });

  it("tanks rarely (p=0.06) on middlegame close calls, ×2.5, capped at 12s unclocked", () => {
    const d = mkDecision([0.4, 0.3, 0.2, 0.1]);
    // Second draw is the tank roll: 0.05 < TANK_PROB fires, 0.5 doesn't.
    // (Ample clock so the ×2.5 shows uncapped: 5000 × 2.5 = 12.5s.)
    expect(
      sparThinkTimeMs(input({ decision: d, remainingClockMs: 600_000, rng: seq(0, 0.05) })),
    ).toBe(12_500);
    expect(sparThinkTimeMs(input({ decision: d, rng: seq(0, 0.5) }))).toBe(5000);
    // Unclocked cap: a tanked max draw would be 50s — clamped to 12s.
    expect(sparThinkTimeMs(input({ decision: d, rng: seq(1, 0.05) }))).toBe(
      THINK_TIME.UNCLOCKED_CAP_MS,
    );
    // Openings never tank (close call, but phase mult applies instead).
    const opening = mkDecision([0.4, 0.3, 0.2, 0.1], { phase: "opening" });
    expect(sparThinkTimeMs(input({ decision: opening, rng: seq(0, 0.05) }))).toBe(3000);
  });
});

describe("sparThinkTimeMs — surprise and phase", () => {
  it("thinks ×1.5 longer when the best eval dropped ≥1 pawn vs his previous decision", () => {
    const d = mkDecision([0.9, 0.1], {}, [-50, -120]); // best −0.5 pawns
    const surprised = input({ decision: d, prevOwnBestEvalPawns: 1.0, rng: seq(0) });
    expect(sparThinkTimeMs(surprised)).toBe(1500); // 1000 × 1.5
    // No baseline, or a small drop → no surprise.
    expect(sparThinkTimeMs(input({ decision: d, prevOwnBestEvalPawns: null, rng: seq(0) }))).toBe(1000);
    expect(sparThinkTimeMs(input({ decision: d, prevOwnBestEvalPawns: 0.0, rng: seq(0) }))).toBe(1000);
  });

  it("opening ×0.6 and endgame ×0.8 compress the base draw", () => {
    const opening = mkDecision([0.9, 0.1], { phase: "opening" });
    expect(sparThinkTimeMs(input({ decision: opening, rng: seq(0) }))).toBe(600);
    const endgame = mkDecision([0.9, 0.1], { phase: "endgame" });
    expect(sparThinkTimeMs(input({ decision: endgame, rng: seq(0) }))).toBe(800);
  });

  it("book replies fall back to a ply-based opening guess (no decision phase)", () => {
    // Ply 4: opening → 400 × 0.6 = 240, raised to the 300ms unclocked floor.
    expect(sparThinkTimeMs(input({ reason: "book", decision: null, ply: 4, rng: seq(0) }))).toBe(300);
    // Ply 30: middlegame fallback, no phase mult.
    expect(sparThinkTimeMs(input({ reason: "book", decision: null, ply: 30, rng: seq(0) }))).toBe(400);
  });
});

describe("sparThinkTimeMs — clock bounds", () => {
  const close = mkDecision([0.4, 0.3, 0.2, 0.1]);

  it("with ample time the draw passes through, capped at 8% of remaining", () => {
    expect(
      sparThinkTimeMs(input({ decision: close, remainingClockMs: 600_000, rng: seq(1, 0.5) })),
    ).toBe(20_000);
    // 8% cap binds: 20s draw against 120s remaining → 9.6s.
    expect(
      sparThinkTimeMs(input({ decision: close, remainingClockMs: 120_000, rng: seq(1, 0.5) })),
    ).toBe(9600);
  });

  it("compresses hard under 30s (×0.4) and brutally under 10s (×0.15, floor 150ms)", () => {
    // 20s remaining: 20000 × 0.4 = 8000, then the 8% cap (1600) bites.
    expect(
      sparThinkTimeMs(input({ decision: close, remainingClockMs: 20_000, rng: seq(1, 0.5) })),
    ).toBe(1600);
    // 5s remaining: 20000 × 0.15 = 3000, capped to min(400, max(200, 500)) = 400.
    expect(
      sparThinkTimeMs(input({ decision: close, remainingClockMs: 5000, rng: seq(1, 0.5) })),
    ).toBe(400);
    // The 150ms floor holds when the compressed draw would be tiny.
    expect(
      sparThinkTimeMs(input({ decision: close, remainingClockMs: 9000, rng: seq(0, 0.5) })),
    ).toBeGreaterThanOrEqual(150);
  });

  it("never self-flags: the sampled delay stays below the remaining time", () => {
    for (const rem of [100, 250, 400, 1000, 5000, 9999, 30_000, 300_000]) {
      const t = sparThinkTimeMs(
        input({ decision: close, remainingClockMs: rem, rng: seq(1, 0.5) }),
      );
      expect(t).toBeLessThan(rem);
      expect(t).toBeGreaterThanOrEqual(0);
    }
    expect(sparThinkTimeMs(input({ decision: close, remainingClockMs: 0 }))).toBe(0);
  });

  it("unclocked bounds: floor 300ms, cap 12s", () => {
    const forced = { onlyMove: true, recapture: false };
    expect(sparThinkTimeMs(input({ forced, rng: seq(0) }))).toBeGreaterThanOrEqual(
      THINK_TIME.UNCLOCKED_FLOOR_MS,
    );
    expect(
      sparThinkTimeMs(input({ decision: close, prevOwnBestEvalPawns: null, rng: seq(1, 0.05) })),
    ).toBeLessThanOrEqual(THINK_TIME.UNCLOCKED_CAP_MS);
  });
});

describe("sparThinkTimeMs — seeded determinism", () => {
  it("the same rng stream reproduces the same think time", () => {
    const d = mkDecision([0.4, 0.3, 0.2, 0.1]);
    const a = sparThinkTimeMs(input({ decision: d, rng: seq(0.37, 0.9) }));
    const b = sparThinkTimeMs(input({ decision: d, rng: seq(0.37, 0.9) }));
    expect(a).toBe(b);
  });
});

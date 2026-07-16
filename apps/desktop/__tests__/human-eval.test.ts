import { describe, it, expect } from "vitest";
import {
  evalRFast,
  pawnsFromScore,
  materialPawns,
  policyMass,
  computeHumanEval,
  MATE_PAWNS,
  type HumanEvalArgs,
} from "@/lib/human-eval";
import type { PvLine } from "@chessgui/core/uci-parser";
import type { MaiaPolicy } from "@/lib/maia";
import { INITIAL_FEN } from "@chessgui/core/game-tree";

function line(multipv: number, cp: number, uci: string): PvLine {
  return {
    multipv,
    score: { type: "cp", value: cp },
    depth: 20,
    sanMoves: [],
    uciMoves: [uci],
  };
}

describe("evalRFast — the blend", () => {
  it("w=1 returns Stockfish's eval (move is human-real)", () => {
    expect(evalRFast({ sfPawns: 4, anchorPawns: 1.2, w: 1 })).toBeCloseTo(4);
  });

  it("w=0 returns the anchor (move is invisible at this rating)", () => {
    expect(evalRFast({ sfPawns: 4, anchorPawns: 1.2, w: 0 })).toBeCloseTo(1.2);
  });

  it("interpolates linearly", () => {
    // 0.25*4 + 0.75*1.2 = 1.9
    expect(evalRFast({ sfPawns: 4, anchorPawns: 1.2, w: 0.25 })).toBeCloseTo(1.9);
  });

  it("clamps w outside [0,1]", () => {
    expect(evalRFast({ sfPawns: 4, anchorPawns: 1.2, w: 1.5 })).toBeCloseTo(4);
    expect(evalRFast({ sfPawns: 4, anchorPawns: 1.2, w: -0.5 })).toBeCloseTo(1.2);
  });
});

describe("pawnsFromScore — White-POV, mate-bounded", () => {
  it("centipawns divided by 100, flipped for Black to move", () => {
    expect(pawnsFromScore({ type: "cp", value: 320 }, "white")).toBeCloseTo(3.2);
    expect(pawnsFromScore({ type: "cp", value: 320 }, "black")).toBeCloseTo(-3.2);
  });

  it("maps mate to a bounded magnitude, correct sign", () => {
    expect(pawnsFromScore({ type: "mate", value: 3 }, "white")).toBe(MATE_PAWNS);
    expect(pawnsFromScore({ type: "mate", value: 3 }, "black")).toBe(-MATE_PAWNS);
    expect(pawnsFromScore({ type: "mate", value: -2 }, "white")).toBe(-MATE_PAWNS);
  });
});

describe("materialPawns — signed White-POV", () => {
  it("zero at the start", () => {
    expect(materialPawns(INITIAL_FEN)).toBe(0);
  });
  it("positive when White is up material", () => {
    // White up a pawn after 1.e4 d5 2.exd5
    expect(materialPawns("rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2")).toBe(1);
  });
});

describe("policyMass", () => {
  const policy: MaiaPolicy = {
    band: 1500,
    moves: [
      { uci: "e2e4", prob: 0.5 },
      { uci: "d2d4", prob: 0.23 },
    ],
    value: null,
  };
  it("returns the mass for a listed move", () => {
    expect(policyMass(policy, "e2e4")).toBeCloseTo(0.5);
  });
  it("returns 0 for an unlisted move", () => {
    expect(policyMass(policy, "a2a3")).toBe(0);
  });
});

describe("computeHumanEval — end to end", () => {
  const fen = "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 3 3";

  it("blends toward the 2nd PV when the resource is invisible at this band", () => {
    // Stockfish loves a sharp move worth +4; the fallback line is +1.2.
    const lines: PvLine[] = [line(1, 400, "f3g5"), line(2, 120, "d2d3")];
    const policy: MaiaPolicy = {
      band: 1500,
      // A 1500 barely plays the sharp move (10%); mostly the quiet one.
      moves: [
        { uci: "f3g5", prob: 0.1 },
        { uci: "d2d3", prob: 0.6 },
      ],
      value: null,
    };
    const res = computeHumanEval({ fen, scoreTurn: "white", lines, policy })!;
    expect(res.anchorSource).toBe("second-pv");
    expect(res.pvMove).toBe("f3g5");
    expect(res.w).toBeCloseTo(0.1);
    // 0.1*4 + 0.9*1.2 = 1.48 — far below Stockfish's +4.
    expect(res.evalR).toBeCloseTo(1.48);
    expect(res.evalR).toBeLessThan(res.sfPawns);
  });

  it("tracks Stockfish when the band overwhelmingly plays the move", () => {
    const lines: PvLine[] = [line(1, 400, "f3g5"), line(2, 120, "d2d3")];
    const policy: MaiaPolicy = {
      band: 1900,
      moves: [
        { uci: "f3g5", prob: 0.85 },
        { uci: "d2d3", prob: 0.05 },
      ],
      value: null,
    };
    const res = computeHumanEval({ fen, scoreTurn: "white", lines, policy })!;
    // 0.85*4 + 0.15*1.2 = 3.58 — close to +4.
    expect(res.evalR).toBeCloseTo(3.58);
    expect(res.evalR).toBeGreaterThan(3);
  });

  it("falls back to material when only one PV line exists", () => {
    const lines: PvLine[] = [line(1, 300, "f3g5")];
    const policy: MaiaPolicy = {
      band: 1500,
      moves: [{ uci: "f3g5", prob: 0.2 }],
      value: null,
    };
    const res = computeHumanEval({ fen, scoreTurn: "white", lines, policy })!;
    expect(res.anchorSource).toBe("material");
    // Even material in this position -> anchor 0. 0.2*3 + 0.8*0 = 0.6
    expect(res.anchorPawns).toBe(0);
    expect(res.evalR).toBeCloseTo(0.6);
  });

  it("returns null when there is no Stockfish PV yet", () => {
    const policy: MaiaPolicy = { band: 1500, moves: [], value: null };
    expect(computeHumanEval({ fen, scoreTurn: "white", lines: [], policy })).toBeNull();
  });
});

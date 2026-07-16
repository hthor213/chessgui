// Tier-1 human-visible tree — TS wrapper (spec 213 Phase 3).
//
// The search math itself is proven in Rust (src-tauri/src/human_search.rs
// synthetic-policy tests); here we pin the pure TS pieces: the invoke argument
// contract with the Rust command, and the mate-magnitude display clamp.

import { describe, it, expect } from "vitest";
import {
  clampTreePawns,
  sweepInvokeArgs,
  treeInvokeArgs,
  TREE_MATE_PAWNS,
} from "@/lib/human-eval-tree";

describe("treeInvokeArgs", () => {
  it("passes only fen and band when no options are set (backend owns defaults)", () => {
    expect(treeInvokeArgs("8/8/8/8/8/8/8/K6k w - - 0 1", 1500)).toEqual({
      fen: "8/8/8/8/8/8/8/K6k w - - 0 1",
      band: 1500,
    });
  });

  it("maps every knob to the Rust command's camelCase parameter names", () => {
    const args = treeInvokeArgs("fen", 1300, {
      bandOpening: 1100,
      bandMiddlegame: 1300,
      bandEndgame: 1500,
      depth: 2,
      topP: 0.9,
      maxCandidates: 3,
      maxNodes: 50,
      leafDepth: 8,
    });
    expect(args).toEqual({
      fen: "fen",
      band: 1300,
      bandOpening: 1100,
      bandMiddlegame: 1300,
      bandEndgame: 1500,
      depth: 2,
      topP: 0.9,
      maxCandidates: 3,
      maxNodes: 50,
      leafDepth: 8,
    });
  });

  it("omits per-phase bands when unset — the scalar band is the linked R⃗", () => {
    const args = treeInvokeArgs("fen", 1500);
    expect(args).not.toHaveProperty("bandOpening");
    expect(args).not.toHaveProperty("bandMiddlegame");
    expect(args).not.toHaveProperty("bandEndgame");
  });

  it("keeps explicit zero-ish values distinct from unset", () => {
    // depth 1 is the minimum meaningful depth and must not be dropped.
    expect(treeInvokeArgs("fen", 1100, { depth: 1 })).toHaveProperty("depth", 1);
  });
});

describe("sweepInvokeArgs", () => {
  it("passes only fen and bands when no options are set (backend owns defaults)", () => {
    expect(sweepInvokeArgs("fen", [1100, 1300, 1500])).toEqual({
      fen: "fen",
      bands: [1100, 1300, 1500],
    });
  });

  it("maps shape knobs to the Rust command's camelCase parameter names", () => {
    expect(
      sweepInvokeArgs("fen", [1100, 1900], {
        depth: 2,
        topP: 0.9,
        maxCandidates: 3,
        maxNodes: 50,
        leafDepth: 8,
      }),
    ).toEqual({
      fen: "fen",
      bands: [1100, 1900],
      depth: 2,
      topP: 0.9,
      maxCandidates: 3,
      maxNodes: 50,
      leafDepth: 8,
    });
  });

  it("never forwards per-phase bands — the band IS the swept variable", () => {
    const args = sweepInvokeArgs("fen", [1100], {
      bandOpening: 1100,
      bandMiddlegame: 1300,
      bandEndgame: 1500,
    });
    expect(args).not.toHaveProperty("bandOpening");
    expect(args).not.toHaveProperty("bandMiddlegame");
    expect(args).not.toHaveProperty("bandEndgame");
  });
});

describe("clampTreePawns", () => {
  it("passes normal evals through unchanged", () => {
    expect(clampTreePawns(0.35)).toBe(0.35);
    expect(clampTreePawns(-2.4)).toBe(-2.4);
    expect(clampTreePawns(0)).toBe(0);
  });

  it("collapses mate magnitudes (±~1000 pawns) to the display bound", () => {
    // Backend mate scores are ±(100000 − ply) cp ≈ ±1000 pawns.
    expect(clampTreePawns(999.99)).toBe(TREE_MATE_PAWNS);
    expect(clampTreePawns(-999.99)).toBe(-TREE_MATE_PAWNS);
  });

  it("matches tier-0's MATE_PAWNS bound so the readout scale is consistent", async () => {
    const { MATE_PAWNS } = await import("@/lib/human-eval");
    expect(TREE_MATE_PAWNS).toBe(MATE_PAWNS);
  });
});

import { describe, it, expect } from "vitest";
import type { Role } from "chessops";
import {
  validate960BackRank,
  complete960Fen,
  random960BackRank,
  type BackRankSlots,
} from "@chessgui/core/chess960-setup";
import { GameTree } from "@chessgui/core/game-tree";

// Standard placement SP518 = RNBQKBNR (files a..h).
const SP518: Role[] = ["rook", "knight", "bishop", "queen", "king", "bishop", "knight", "rook"];

// A deterministic PRNG (mulberry32) so the "always valid" sweep is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("validate960BackRank", () => {
  it("accepts the standard placement", () => {
    expect(validate960BackRank(SP518)).toEqual({ valid: true });
  });

  it("names a wrong piece count", () => {
    // Two queens, no rook — wrong multiset.
    const bad: BackRankSlots = ["queen", "knight", "bishop", "queen", "king", "bishop", "knight", "rook"];
    const r = validate960BackRank(bad);
    expect(r.valid).toBe(false);
    expect(r.problem).toMatch(/exactly one king/i);
  });

  it("names an incomplete rank (nulls present)", () => {
    const bad: BackRankSlots = ["rook", "knight", "bishop", "queen", "king", "bishop", "knight", null];
    const r = validate960BackRank(bad);
    expect(r.valid).toBe(false);
    expect(r.problem).toMatch(/exactly one king/i);
  });

  it("names bishops on the same color", () => {
    // Bishops on a (file 0, dark) and c (file 2, dark) — same color.
    const bad: Role[] = ["bishop", "rook", "bishop", "queen", "king", "knight", "knight", "rook"];
    const r = validate960BackRank(bad);
    expect(r.valid).toBe(false);
    expect(r.problem).toMatch(/opposite-colored/i);
  });

  it("names a king not between the rooks", () => {
    // Rooks on a (0) and c (2), king on e (4) — not between them. Bishops on
    // opposite colors (b light, f light... need opposite). b=1 light, g=6 dark.
    const bad: Role[] = ["rook", "bishop", "rook", "king", "queen", "knight", "bishop", "knight"];
    const r = validate960BackRank(bad);
    expect(r.valid).toBe(false);
    expect(r.problem).toMatch(/between the two rooks/i);
  });
});

describe("complete960Fen", () => {
  it("produces HAha castling for the standard placement", () => {
    const fen = complete960Fen(SP518);
    expect(fen).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w HAha - 0 1");
  });

  it("derives Shredder castling letters from the rook files (rooks on b/d)", () => {
    // Rooks on b (1) and d (3), king on c (2) between them; bishops on
    // opposite colors (a=0 dark, f=5 light); queen g, knights e/h.
    const rank: Role[] = ["bishop", "rook", "king", "rook", "knight", "bishop", "queen", "knight"];
    expect(validate960BackRank(rank)).toEqual({ valid: true });
    const fen = complete960Fen(rank);
    // White uppercase higher-file-first "DB", Black lowercase "db".
    expect(fen.split(" ")[2]).toBe("DBdb");
  });

  it("emits White to move, mirrored black rank, pawns on 2 and 7", () => {
    const fen = complete960Fen(SP518);
    const [board, turn] = fen.split(" ");
    const ranks = board.split("/");
    expect(turn).toBe("w");
    expect(ranks[0]).toBe("rnbqkbnr"); // rank 8, mirrored (lowercase)
    expect(ranks[1]).toBe("pppppppp"); // rank 7
    expect(ranks[6]).toBe("PPPPPPPP"); // rank 2
    expect(ranks[7]).toBe("RNBQKBNR"); // rank 1
  });
});

describe("game-tree chess960 auto-detection", () => {
  it("flags a completed 960 FEN as the chess960 variant", () => {
    const fen = complete960Fen(SP518);
    expect(GameTree.create(fen).variant).toBe("chess960");
  });

  it("flags a non-standard rook-file placement as chess960", () => {
    const rank: Role[] = ["bishop", "rook", "king", "rook", "knight", "bishop", "queen", "knight"];
    expect(GameTree.create(complete960Fen(rank)).variant).toBe("chess960");
  });
});

describe("random960BackRank", () => {
  it("is always valid across 200 seeded draws", () => {
    const rng = mulberry32(0x5eed);
    for (let i = 0; i < 200; i++) {
      const rank = random960BackRank(rng);
      const v = validate960BackRank(rank);
      expect(v, `draw ${i}: ${rank.join(",")} — ${v.problem}`).toEqual({ valid: true });
    }
  });

  it("completes into a chess960-detected tree", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 20; i++) {
      const fen = complete960Fen(random960BackRank(rng));
      expect(GameTree.create(fen).variant).toBe("chess960");
    }
  });
});

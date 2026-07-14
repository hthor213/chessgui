import { describe, it, expect } from "vitest";
import { computeMaterial } from "@/lib/material";
import { INITIAL_FEN } from "@/lib/game-tree";

describe("computeMaterial — standard captures", () => {
  it("reports nothing captured at the start position", () => {
    const m = computeMaterial(INITIAL_FEN, INITIAL_FEN);
    expect(m.capturedByWhite).toEqual({});
    expect(m.capturedByBlack).toEqual({});
    expect(m.advantage).toBeNull();
    expect(m.points).toBe(0);
  });

  it("after 1.e4 d5 2.exd5: White captured a pawn, +1", () => {
    // Position after 1.e4 d5 2.exd5
    const fen = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
    const m = computeMaterial(INITIAL_FEN, fen);
    expect(m.capturedByWhite).toEqual({ pawn: 1 });
    expect(m.capturedByBlack).toEqual({});
    expect(m.advantage).toBe("white");
    expect(m.points).toBe(1);
  });

  it("after 1.e4 d5 2.exd5 Qxd5: one pawn each way, tie shows no badge", () => {
    const fen = "rnb1kbnr/ppp1pppp/8/3q4/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3";
    const m = computeMaterial(INITIAL_FEN, fen);
    expect(m.capturedByWhite).toEqual({ pawn: 1 });
    expect(m.capturedByBlack).toEqual({ pawn: 1 });
    expect(m.advantage).toBeNull();
    expect(m.points).toBe(0);
  });

  it("Black up a queen for a knight: advantage black, +6", () => {
    // White is missing its queen; Black is missing a knight.
    const fen = "r1bqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 5";
    const m = computeMaterial(INITIAL_FEN, fen);
    expect(m.capturedByWhite).toEqual({ knight: 1 });
    expect(m.capturedByBlack).toEqual({ queen: 1 });
    expect(m.advantage).toBe("black");
    expect(m.points).toBe(6);
  });

  it("groups multiple captures of the same role", () => {
    // White missing 3 pawns and a rook; Black missing 2 bishops.
    const fen = "rn1qk1nr/pppppppp/8/8/8/8/PPPP1P2/1NBQKBNR w Kkq - 0 9";
    const m = computeMaterial(INITIAL_FEN, fen);
    expect(m.capturedByWhite).toEqual({ bishop: 2 });
    expect(m.capturedByBlack).toEqual({ pawn: 3, rook: 1 });
    expect(m.advantage).toBe("black");
    expect(m.points).toBe(2); // 8 - 6
  });
});

describe("computeMaterial — custom start positions", () => {
  it("a pre-existing imbalance in the start position counts as zero", () => {
    // Rook-odds start: White begins without the a1 rook. No moves played.
    const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/1NBQKBNR w Kkq - 0 1";
    const m = computeMaterial(start, start);
    expect(m.capturedByWhite).toEqual({});
    expect(m.capturedByBlack).toEqual({});
    expect(m.advantage).toBeNull();
    expect(m.points).toBe(0);
  });

  it("diffs against the custom start, not the standard one", () => {
    // Endgame study start: K+R+P vs K+N+P. Then White wins the knight.
    const start = "8/4k3/2n5/6p1/8/2R3P1/4K3/8 w - - 0 1";
    const after = "8/4k3/8/6p1/8/2R3P1/4K3/8 b - - 0 2";
    const m = computeMaterial(start, after);
    expect(m.capturedByWhite).toEqual({ knight: 1 });
    expect(m.capturedByBlack).toEqual({});
    expect(m.advantage).toBe("white");
    expect(m.points).toBe(3);
  });
});

describe("computeMaterial — promotion edge cases", () => {
  it("white promotes without capturing: no phantom pawn credit, White +8", () => {
    // White's a-pawn ran to a8 and became a queen (nothing was captured).
    // Board diff: white pawns 8→7, white queens 1→2.
    const fen = "Qnbqkbnr/1ppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR b KQk - 0 9";
    const start = "1nbqkbnr/1ppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQk - 0 1";
    const m = computeMaterial(start, fen);
    // The multiset diff can't distinguish "promoted away" from "captured";
    // the clamped per-role view stays sane (one pawn, never negative counts).
    expect(m.capturedByBlack).toEqual({ pawn: 1 });
    expect(m.capturedByWhite).toEqual({});
    // Points come from board totals, so promotion is +8 for White (9 - 1),
    // not a -1 credit for Black.
    expect(m.advantage).toBe("white");
    expect(m.points).toBe(8);
  });

  it("black promotes symmetrically: Black +8", () => {
    const start = "rnbqkbn1/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN1 w Qq - 0 1";
    const fen = "rnbqkbn1/1ppppppp/8/8/8/8/PPPPPPPP/RNBQKBNq w Qq - 0 9";
    const m = computeMaterial(start, fen);
    expect(m.capturedByWhite).toEqual({ pawn: 1 });
    expect(m.capturedByBlack).toEqual({});
    expect(m.advantage).toBe("black");
    expect(m.points).toBe(8);
  });

  it("promotion with capture: extra appearing queen never goes negative", () => {
    // White played bxa8=Q (captured Black's rook while promoting).
    // White: pawns 8→7, queens 1→2. Black: rooks 2→1.
    const fen = "Qnbqkbnr/2pppppp/8/8/8/8/P1PPPPPP/RNBQKBNR b KQk - 0 5";
    const start = "rnbqkbnr/2pppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const m = computeMaterial(start, fen);
    expect(m.capturedByWhite).toEqual({ rook: 1 });
    expect(m.capturedByBlack).toEqual({ pawn: 1 });
    // Board totals: White +8 (promotion), Black -5 (lost rook) → White +13.
    expect(m.advantage).toBe("white");
    expect(m.points).toBe(13);
  });
});

describe("computeMaterial — malformed input", () => {
  it("returns an empty summary for garbage FENs instead of throwing", () => {
    const m = computeMaterial("not a fen", "");
    expect(m.capturedByWhite).toEqual({});
    expect(m.capturedByBlack).toEqual({});
    expect(m.advantage).toBeNull();
    expect(m.points).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import { computeMaterial } from "@/lib/material";
import { INITIAL_FEN } from "@/lib/game-tree";

// New semantics (board-only): each tray is the opponent's pieces MISSING FROM A
// FULL STANDARD SET (8P 2N 2B 2R 1Q), and the +x badge is the direct
// material-point difference on the board. The start position is irrelevant.

describe("computeMaterial — standard captures", () => {
  it("reports nothing captured at the start position", () => {
    const m = computeMaterial(INITIAL_FEN);
    expect(m.capturedByWhite).toEqual({});
    expect(m.capturedByBlack).toEqual({});
    expect(m.advantage).toBeNull();
    expect(m.points).toBe(0);
  });

  it("after 1.e4 d5 2.exd5: White is up a pawn, +1", () => {
    const fen = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
    const m = computeMaterial(fen);
    expect(m.capturedByWhite).toEqual({ pawn: 1 }); // Black is short one pawn
    expect(m.capturedByBlack).toEqual({});
    expect(m.advantage).toBe("white");
    expect(m.points).toBe(1);
  });

  it("after 1.e4 d5 2.exd5 Qxd5: one pawn each way, tie shows no badge", () => {
    const fen = "rnb1kbnr/ppp1pppp/8/3q4/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3";
    const m = computeMaterial(fen);
    expect(m.capturedByWhite).toEqual({ pawn: 1 });
    expect(m.capturedByBlack).toEqual({ pawn: 1 });
    expect(m.advantage).toBeNull();
    expect(m.points).toBe(0);
  });

  it("Black up a queen for a knight: advantage black, +6", () => {
    // White is missing its queen; Black is missing a knight.
    const fen = "r1bqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 5";
    const m = computeMaterial(fen);
    expect(m.capturedByWhite).toEqual({ knight: 1 });
    expect(m.capturedByBlack).toEqual({ queen: 1 });
    expect(m.advantage).toBe("black");
    expect(m.points).toBe(6);
  });

  it("groups multiple missing pieces of the same role", () => {
    // White missing 3 pawns and a rook; Black missing both bishops.
    const fen = "rn1qk1nr/pppppppp/8/8/8/8/PPPP1P2/1NBQKBNR w Kkq - 0 9";
    const m = computeMaterial(fen);
    expect(m.capturedByWhite).toEqual({ bishop: 2 });
    expect(m.capturedByBlack).toEqual({ pawn: 3, rook: 1 });
    expect(m.advantage).toBe("black");
    expect(m.points).toBe(2); // white 31 vs black 33
  });
});

describe("computeMaterial — board-only counting (custom starts & imbalances)", () => {
  it("shows a custom start's missing piece immediately (rook odds)", () => {
    // White begins without the a1 rook. No moves played — but the board is
    // already down a rook, so Black's tray shows it and Black is +5.
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/1NBQKBNR w Kkq - 0 1";
    const m = computeMaterial(fen);
    expect(m.capturedByWhite).toEqual({});
    expect(m.capturedByBlack).toEqual({ rook: 1 });
    expect(m.advantage).toBe("black");
    expect(m.points).toBe(5);
  });

  it("the user's scenario: custom start with 7 white pawns, then White captures a black pawn", () => {
    // Before: White has 7 pawns (one short), Black 8. The board is down a white
    // pawn from move one → Black's tray shows it, Black +1. White's tray empty.
    const before = "rnbqkbnr/pppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR w KQkq - 0 1";
    const mBefore = computeMaterial(before);
    expect(mBefore.capturedByWhite).toEqual({});
    expect(mBefore.capturedByBlack).toEqual({ pawn: 1 });
    expect(mBefore.advantage).toBe("black");
    expect(mBefore.points).toBe(1);

    // After White's knight takes a black pawn: 7 pawns each. Both trays show one
    // enemy pawn, and the material is dead even → NO badge.
    const after = "rnbqkbnr/1ppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR b KQkq - 0 1";
    const mAfter = computeMaterial(after);
    expect(mAfter.capturedByWhite).toEqual({ pawn: 1 });
    expect(mAfter.capturedByBlack).toEqual({ pawn: 1 });
    expect(mAfter.advantage).toBeNull();
    expect(mAfter.points).toBe(0);
  });
});

describe("computeMaterial — promotion clamping", () => {
  it("a second queen never shows a negative capture; points stay a board sum", () => {
    // White promoted a pawn to a second queen (extra Q on a6, one fewer pawn).
    // White: 7P 2N 2B 2R 2Q; Black: full army.
    const fen = "rnbqkbnr/pppppppp/Q7/8/8/8/1PPPPPPP/RNBQKBNR b KQkq - 0 9";
    const m = computeMaterial(fen);
    // Black lost nothing; White is only "missing" the pawn it promoted — the
    // extra queen is clamped out (no negative queen entry).
    expect(m.capturedByWhite).toEqual({});
    expect(m.capturedByBlack).toEqual({ pawn: 1 });
    expect(m.capturedByBlack.queen).toBeUndefined();
    // Board totals: White 47 vs Black 39 → White +8.
    expect(m.advantage).toBe("white");
    expect(m.points).toBe(8);
  });
});

describe("computeMaterial — malformed input", () => {
  it("returns an empty summary for garbage FENs instead of throwing", () => {
    const m = computeMaterial("not a fen");
    expect(m.capturedByWhite).toEqual({});
    expect(m.capturedByBlack).toEqual({});
    expect(m.advantage).toBeNull();
    expect(m.points).toBe(0);
  });
});

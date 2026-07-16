import { describe, it, expect } from "vitest";
import {
  materialSignatureFromFen,
  parseMaterialQuery,
} from "@chessgui/core/material-signature";

const FULL_SIDE = "KQRRBBNNPPPPPPPP";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("materialSignatureFromFen", () => {
  it("emits both full armies for the start position", () => {
    expect(materialSignatureFromFen(START_FEN)).toBe(FULL_SIDE + FULL_SIDE);
  });

  it("emits KRPKR for a rook-and-pawn-vs-rook ending", () => {
    // White: Ke3, Re1, Pe2 — Black: Ke8, Re7 (mirrors the Rust db test).
    expect(materialSignatureFromFen("4k3/4r3/8/8/8/3K4/4P3/4R3 w - - 0 1")).toBe("KRPKR");
  });

  it("orders pieces canonically (KQRBNP) regardless of board layout", () => {
    // Knight before bishop on the board must still emit B before N.
    expect(materialSignatureFromFen("4k3/8/8/8/8/8/8/2N1KB2 w - - 0 1")).toBe("KBNK");
  });

  it("rejects malformed FENs instead of miscounting", () => {
    expect(materialSignatureFromFen("not a fen")).toBeNull();
    expect(materialSignatureFromFen("")).toBeNull();
  });
});

describe("parseMaterialQuery", () => {
  it("canonicalizes the friendly forms to the same signature", () => {
    for (const q of ["KRP vs KR", "krp-kr", "KRPKR", "RP v R", "PRK / RK"]) {
      expect(parseMaterialQuery(q)).toEqual({ signature: "KRPKR", flipped: "KRKRP" });
    }
  });

  it("flips orientation symmetrically", () => {
    expect(parseMaterialQuery("KR vs KRP")).toEqual({ signature: "KRKRP", flipped: "KRPKR" });
  });

  it("handles the bare-kings and full-army extremes", () => {
    expect(parseMaterialQuery("K vs K")).toEqual({ signature: "KK", flipped: "KK" });
    const full = `${FULL_SIDE} vs ${FULL_SIDE}`;
    expect(parseMaterialQuery(full)).toEqual({
      signature: FULL_SIDE + FULL_SIDE,
      flipped: FULL_SIDE + FULL_SIDE,
    });
  });

  it("rejects inputs that are not a material description", () => {
    for (const q of ["", "   ", "K", "xyz!", "KK vs K", "KRP vs KR vs K"]) {
      expect(parseMaterialQuery(q)).toBeNull();
    }
  });
});

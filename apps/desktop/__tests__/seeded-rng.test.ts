import { describe, expect, it } from "vitest";
import { mulberry32, rivalTurnRng } from "@/lib/seeded-rng";

// Spec 214 realism audit wave R1.4: the frontend's rival-turn draws (book
// reply choice, think-time) come from this seeded stream so the whole turn is
// reproducible under the logged game seed. The stream deliberately does NOT
// match the Rust splitmix64 stream — each side only has to be deterministic
// under the same seed, never to agree on individual draws.

describe("mulberry32", () => {
  it("is deterministic: the same seed yields the same sequence", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 20; i++) expect(a()).toBe(b());
  });

  it("stays in [0, 1)", () => {
    const rng = mulberry32(0xdeadbeef);
    for (let i = 0; i < 1000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("different seeds yield different sequences", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 8 }, a);
    const seqB = Array.from({ length: 8 }, b);
    expect(seqA).not.toEqual(seqB);
  });
});

describe("rivalTurnRng (per-turn stream from (gameSeed, ply))", () => {
  it("reproduces the same stream for the same (gameSeed, ply)", () => {
    const a = rivalTurnRng(987654321, 12);
    const b = rivalTurnRng(987654321, 12);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });

  it("a different ply under the same game seed is a different stream", () => {
    const a = rivalTurnRng(987654321, 12);
    const b = rivalTurnRng(987654321, 13);
    expect(Array.from({ length: 8 }, a)).not.toEqual(Array.from({ length: 8 }, b));
  });

  it("mixes the high 32 bits of a 2^53-scale game seed (spar's newGameSeed)", () => {
    // Both seeds have identical LOW 32 bits (zero) — only bit 35+ differs.
    const a = rivalTurnRng(2 ** 40, 0);
    const b = rivalTurnRng(2 ** 40 + 2 ** 35, 0);
    expect(Array.from({ length: 8 }, a)).not.toEqual(Array.from({ length: 8 }, b));
  });

  it("handles the maximum JSON-safe seed (2^53 - 1) without degenerating", () => {
    const rng = rivalTurnRng(2 ** 53 - 1, 7);
    const x = rng();
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(1);
  });
});

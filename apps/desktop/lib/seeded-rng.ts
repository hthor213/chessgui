// Seeded frontend RNG (spec 214 realism audit, wave R1.4).
//
// The Rust persona engine derives its own splitmix64 stream from (seed, ply)
// for out-of-book sampling (contract step 8). The frontend's draws — the book
// reply choice and the think-time model — previously used bare Math.random,
// which broke the step-8 determinism story from move 1 (the book phase was
// unreproducible under the logged seed). This mulberry32 stream folds the
// same (gameSeed, ply) pair into a 32-bit seed so the WHOLE rival turn is
// reproducible given the game seed.
//
// It deliberately does NOT match the Rust splitmix64 stream: the two sides
// never need to agree on individual draws, only to each be deterministic
// under the same logged seed (the decision log stores the seed; either side
// replays its own draws from it).

/** Tiny 32-bit seeded PRNG (mulberry32) — returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The seeded stream for one rival turn. `gameSeed` may be up to 2^53
 * (spar-tab's newGameSeed keeps it JSON-safe), so both 32-bit halves are
 * mixed in — a seed differing only above bit 32 still yields a different
 * stream. `ply` is the half-move index the reply occupies, matching the
 * (seed, ply) pair the Rust engine seeds from.
 */
export function rivalTurnRng(gameSeed: number, ply: number): () => number {
  const lo = gameSeed >>> 0;
  const hi = Math.floor(gameSeed / 0x100000000) >>> 0;
  const mixed =
    (Math.imul(lo, 0x9e3779b9) ^ Math.imul(hi, 0x85ebca6b) ^ Math.imul(ply + 1, 0xc2b2ae35)) >>> 0;
  return mulberry32(mixed);
}

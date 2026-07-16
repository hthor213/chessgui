import { describe, it, expect } from "vitest";
import {
  buildRivalMoveMap,
  lookupRivalReply,
  normalizeFenKey,
  replySanToUci,
  START_FEN,
} from "@/lib/rival-book-lookup";
import type { RivalBookEntry } from "@/lib/rival-book";

// A small hand-built book exercising both rival colours and shared prefixes.
// rival = White: his very first move is ply 1 (before-position = the game
// start) — the "black-first" case in reverse, since it's Black (the user)
// who replies to him, not the other way round.
const RIVAL_WHITE: RivalBookEntry[] = [
  { fen: "n/a", line: "1.e4", ply: 1, rival_color: "white", weight: 22 },
  { fen: "n/a", line: "1.d4", ply: 1, rival_color: "white", weight: 15 },
  { fen: "n/a", line: "1.e4 c5 2.Nf3", ply: 3, rival_color: "white", weight: 7 },
  { fen: "n/a", line: "1.e4 c5 2.Nc3", ply: 3, rival_color: "white", weight: 3 },
  // Same node reached again in a different (fictional) game -> weight merges
  // with the "1.e4 c5 2.Nf3" entry above rather than creating a second node.
  { fen: "n/a", line: "1.e4 c5 2.Nf3", ply: 3, rival_color: "white", weight: 2 },
];

// rival = Black: his first move replies to the user's ply-1 move, so his
// first book node sits one ply deeper than a White rival's.
const RIVAL_BLACK: RivalBookEntry[] = [
  { fen: "n/a", line: "1.e4 c5", ply: 2, rival_color: "black", weight: 4 },
  { fen: "n/a", line: "1.d4 d5", ply: 2, rival_color: "black", weight: 6 },
];

describe("normalizeFenKey", () => {
  it("drops the halfmove clock and fullmove number", () => {
    const a = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const b = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 3 17";
    expect(normalizeFenKey(a)).toBe(normalizeFenKey(b));
  });

  it("distinguishes different positions", () => {
    const a = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const b = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";
    expect(normalizeFenKey(a)).not.toBe(normalizeFenKey(b));
  });
});

describe("buildRivalMoveMap — White rival (his own first move is ply 1)", () => {
  const map = buildRivalMoveMap(RIVAL_WHITE, "white");

  it("indexes the start position with every ply-1 reply, weights intact", () => {
    const replies = map.get(normalizeFenKey(START_FEN));
    expect(replies).toBeDefined();
    const bySan = Object.fromEntries(replies!.map((r) => [r.san, r.weight]));
    expect(bySan).toEqual({ e4: 22, d4: 15 });
  });

  it("shared-prefix weight summing: two entries landing on the same node merge", () => {
    // Both "1.e4 c5 2.Nf3" entries (weight 7 and 2) share the same "before"
    // node (after 1.e4 c5) and the same reply "Nf3" -> weights sum to 9.
    const beforeFen = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    const replies = map.get(normalizeFenKey(beforeFen));
    expect(replies).toBeDefined();
    const bySan = Object.fromEntries(replies!.map((r) => [r.san, r.weight]));
    expect(bySan).toEqual({ Nf3: 9, Nc3: 3 });
  });

  it("out-of-book detection: an unvisited position has no entry", () => {
    // After 1.d4 d5 — never recorded for this rival colour.
    const outOfBook = "rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2";
    expect(map.get(normalizeFenKey(outOfBook))).toBeUndefined();
    expect(lookupRivalReply(map, outOfBook, () => 0.5)).toBeNull();
  });
});

describe("buildRivalMoveMap — Black rival (his first move replies to the user)", () => {
  const map = buildRivalMoveMap(RIVAL_BLACK, "black");

  it("indexes the position after the user's first move, not the start position", () => {
    expect(map.get(normalizeFenKey(START_FEN))).toBeUndefined();
    const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const replies = map.get(normalizeFenKey(afterE4));
    expect(replies).toEqual([{ san: "c5", weight: 4 }]);
    const afterD4 = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";
    expect(map.get(normalizeFenKey(afterD4))).toEqual([{ san: "d5", weight: 6 }]);
  });
});

describe("lookupRivalReply — deterministic weighted sampling", () => {
  const map = buildRivalMoveMap(RIVAL_WHITE, "white");

  it("samples by cumulative weight (rng in [0,1))", () => {
    // At the start node, e4 (weight 22) then d4 (weight 15), total 37.
    expect(lookupRivalReply(map, START_FEN, () => 0.0)!.san).toBe("e4"); // target 0
    expect(lookupRivalReply(map, START_FEN, () => 0.9)!.san).toBe("d4"); // target 33.3
  });
});

describe("replySanToUci", () => {
  it("converts a normal SAN move to UCI at a given position", () => {
    expect(replySanToUci(START_FEN, "e4")).toBe("e2e4");
  });

  it("converts kingside castling to classical UCI (e1g1)", () => {
    // White to move, ready to castle kingside.
    const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
    expect(replySanToUci(fen, "O-O")).toBe("e1g1");
  });

  it("returns null for a SAN that doesn't apply at that position", () => {
    expect(replySanToUci(START_FEN, "Nf6")).toBeNull();
  });
});

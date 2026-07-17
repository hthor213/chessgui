import { describe, it, expect } from "vitest";
import {
  buildRivalMoveMap,
  lookupRivalReply,
  normalizeFenKey,
  pliesSinceBookExit,
  replySanToUci,
  START_FEN,
} from "@/lib/rival-book-lookup";
import type { RivalBookEntry } from "@/lib/rival-book";
import { applyUci, type SparPly } from "@/lib/spar";

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

describe("pliesSinceBookExit — book-exit ply for the persona engine", () => {
  // Play a SAN line from the start position into the spar loop's ply shape.
  function playLine(...sans: string[]): SparPly[] {
    const out: SparPly[] = [];
    let fen = START_FEN;
    for (const san of sans) {
      const uci = replySanToUci(fen, san);
      const ply = uci ? applyUci(fen, uci) : null;
      if (!ply) throw new Error(`illegal test line at ${san}`);
      out.push(ply);
      fen = ply.fen;
    }
    return out;
  }

  const whiteMap = buildRivalMoveMap(RIVAL_WHITE, "white");
  const blackMap = buildRivalMoveMap(RIVAL_BLACK, "black");

  it("returns 0 before any ply (a White rival's own first move is the exit-or-book point)", () => {
    expect(pliesSinceBookExit(whiteMap, "white", START_FEN, [])).toBe(0);
  });

  it("returns 0 while every played ply is still in book (exit is happening now)", () => {
    // 1.e4 (his recorded reply) c5 (lands on the "1.e4 c5" node — 2.Nf3/2.Nc3
    // are recorded there). The move being computed for this call is the first
    // to leave book, so the style-bias window opens fully.
    expect(pliesSinceBookExit(whiteMap, "white", START_FEN, playLine("e4", "c5"))).toBe(0);
  });

  it("returns 0 when the user's novelty was the last ply played", () => {
    // 2...d6 leaves his recorded games (no node after it): the exit ply is the
    // final one, so the rival's first out-of-book reply still sees 0.
    expect(
      pliesSinceBookExit(whiteMap, "white", START_FEN, playLine("e4", "c5", "Nf3", "d6")),
    ).toBe(0);
  });

  it("counts plies played after the exit ply", () => {
    // Exit at index 3 (2...d6), then 3.d4 cxd4 played — two plies since.
    expect(
      pliesSinceBookExit(
        whiteMap,
        "white",
        START_FEN,
        playLine("e4", "c5", "Nf3", "d6", "d4", "cxd4"),
      ),
    ).toBe(2);
  });

  it("treats the rival's own deviation from a book node as the exit ply", () => {
    // At the start node his book has e4/d4 only; 1.a3 deviates (index 0), then
    // 1...e5 is one ply since.
    expect(pliesSinceBookExit(whiteMap, "white", START_FEN, playLine("a3", "e5"))).toBe(1);
  });

  it("handles a Black rival (user plies checked by resulting-position node)", () => {
    // 1.e4 c5 both in his book; 2.Nf3 has no node after it -> exit at index 2;
    // 2...Nc6 3.d4 are the two plies since.
    expect(pliesSinceBookExit(blackMap, "black", START_FEN, playLine("e4", "c5"))).toBe(0);
    expect(
      pliesSinceBookExit(
        blackMap,
        "black",
        START_FEN,
        playLine("e4", "c5", "Nf3", "Nc6", "d4"),
      ),
    ).toBe(2);
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

import { describe, it, expect } from "vitest";
import { parsePgnToTrees, treeToPgn } from "@chessgui/core/pgn";
import { GameTree, type MoveNode } from "@chessgui/core/game-tree";

// Structural comparison of two trees: headers, start position, and the move
// graph with all annotations. Node ids and generated fields aside, two trees
// are "equal" when they'd render and export identically.
function nodesEqual(a: GameTree, an: MoveNode, b: GameTree, bn: MoveNode): void {
  expect(bn.san).toBe(an.san);
  expect(bn.fen).toBe(an.fen);
  expect(bn.comment).toBe(an.comment);
  expect([...bn.nags].sort()).toEqual([...an.nags].sort());
  expect(bn.arrows).toEqual(an.arrows);
  expect(bn.eval).toEqual(an.eval);
  expect(bn.clock).toBe(an.clock);
  expect(bn.children.length).toBe(an.children.length);
  an.children.forEach((cid, i) => {
    nodesEqual(a, a.get(cid)!, b, b.get(bn.children[i])!);
  });
}

function treesEqual(a: GameTree, b: GameTree): void {
  expect(b.startFen).toBe(a.startFen);
  expect(b.headers).toEqual(a.headers);
  expect(b.root().comment).toBe(a.root().comment);
  nodesEqual(a, a.root(), b, b.root());
}

function roundTrip(pgn: string): { first: GameTree; second: GameTree; pgn2: string } {
  const first = parsePgnToTrees(pgn)[0];
  expect(first).toBeDefined();
  const pgn2 = treeToPgn(first);
  const second = parsePgnToTrees(pgn2)[0];
  expect(second).toBeDefined();
  return { first, second, pgn2 };
}

describe("PGN round-trip", () => {
  it("simple mainline game with headers and result", () => {
    const pgn = `[Event "Test"]
[Site "?"]
[Date "2026.07.13"]
[Round "1"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;
    const { first, second } = roundTrip(pgn);
    treesEqual(first, second);
    first.goToEnd();
    expect(first.currentLine().map((n) => n.san)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
    expect(first.headers.White).toBe("Alice");
    expect(first.headers.Result).toBe("1-0");
  });

  it("nested variations", () => {
    const pgn = `[Event "?"]
[Site "?"]
[Date "????.??.??"]
[Round "?"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 e5 (1... c5 2. Nf3 d6 (2... Nc6 3. d4)) 2. Nf3 Nc6 *`;
    const { first, second } = roundTrip(pgn);
    treesEqual(first, second);
    // e4 node should have two children: e5 (mainline) and c5 (variation)
    const e4 = first.get(first.root().children[0])!;
    expect(e4.children.length).toBe(2);
    expect(first.get(e4.children[1])!.san).toBe("c5");
    // c5 -> Nf3 -> d6 (mainline) + Nc6 (nested variation)
    const c5 = first.get(e4.children[1])!;
    const nf3 = first.get(c5.children[0])!;
    const d6 = first.get(nf3.children[0])!;
    expect(d6.san).toBe("d6");
    expect(nf3.children.length).toBe(2);
    expect(first.get(nf3.children[1])!.san).toBe("Nc6");
  });

  it("comments and NAGs", () => {
    const pgn = `[Event "?"]
[Site "?"]
[Date "????.??.??"]
[Round "?"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 { King's pawn } e5 2. Nf3 $1 Nc6 $6 *`;
    const { first, second } = roundTrip(pgn);
    treesEqual(first, second);
    const e4 = first.get(first.root().children[0])!;
    expect(e4.comment).toBe("King's pawn");
    const e5 = first.get(e4.children[0])!;
    const nf3 = first.get(e5.children[0])!;
    expect(nf3.san).toBe("Nf3");
    expect(nf3.nags).toEqual([1]);
  });

  it("lichess study-style tags: eval, clk, cal, csl", () => {
    const pgn = `[Event "Study"]
[Site "?"]
[Date "????.??.??"]
[Round "?"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 { [%eval 0.24] [%clk 0:05:00] } e5 { [%eval 0.19] [%cal Gd2d4,Rf1c4] [%csl Ye5] } *`;
    const { first, second } = roundTrip(pgn);
    treesEqual(first, second);
    const e4 = first.get(first.root().children[0])!;
    expect(e4.eval).toEqual({ cp: 24, depth: undefined });
    expect(e4.clock).toBe(300);
    const e5 = first.get(e4.children[0])!;
    expect(e5.eval).toEqual({ cp: 19, depth: undefined });
    // csl circles (dest-less) are stored before cal arrows (canonical order)
    expect(e5.arrows).toEqual([
      { orig: "e5", brush: "yellow" },
      { orig: "d2", dest: "d4", brush: "green" },
      { orig: "f1", dest: "c4", brush: "red" },
    ]);
  });

  it("mate eval tag", () => {
    const pgn = `[Event "?"]
[Site "?"]
[Date "????.??.??"]
[Round "?"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 { [%eval #3] } e5 *`;
    const { first, second } = roundTrip(pgn);
    treesEqual(first, second);
    const e4 = first.get(first.root().children[0])!;
    expect(e4.eval).toEqual({ mate: 3, depth: undefined });
  });

  it("headers with escaped quotes and backslashes", () => {
    const pgn = `[Event "The \\"Big\\" Match"]
[Site "?"]
[Date "????.??.??"]
[Round "?"]
[White "O'Brien"]
[Black "?"]
[Result "*"]

1. d4 d5 *`;
    const { first, second } = roundTrip(pgn);
    treesEqual(first, second);
    expect(first.headers.Event).toBe('The "Big" Match');
  });

  it("game from a custom FEN (SetUp/FEN headers)", () => {
    const pgn = `[Event "?"]
[Site "?"]
[Date "????.??.??"]
[Round "?"]
[White "?"]
[Black "?"]
[Result "*"]
[SetUp "1"]
[FEN "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"]

3. Bb5 a6 4. Ba4 *`;
    const { first, second } = roundTrip(pgn);
    treesEqual(first, second);
    expect(first.startFen).toContain("r1bqkbnr");
    first.goToEnd();
    expect(first.currentLine().map((n) => n.san)).toEqual(["Bb5", "a6", "Ba4"]);
  });

  it("multi-game PGN yields one tree per game", () => {
    const pgn = `[Event "Game A"]
[Result "1-0"]

1. e4 e5 1-0

[Event "Game B"]
[Result "0-1"]

1. d4 d5 0-1`;
    const trees = parsePgnToTrees(pgn);
    expect(trees.length).toBe(2);
    expect(trees[0].headers.Event).toBe("Game A");
    expect(trees[1].headers.Event).toBe("Game B");
  });

  it("castling and promotion survive the round-trip", () => {
    const pgn = `[Event "?"]
[Site "?"]
[Date "????.??.??"]
[Round "?"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 *`;
    const { first, second } = roundTrip(pgn);
    treesEqual(first, second);
    first.goToEnd();
    expect(first.currentLine().map((n) => n.san)).toContain("O-O");
  });
});

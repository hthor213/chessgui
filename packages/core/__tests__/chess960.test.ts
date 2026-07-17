import { describe, it, expect } from "vitest";
import { parseFen } from "chessops/fen";
import { parsePgnToTrees, treeToPgn } from "@chessgui/core/pgn";
import { GameTree, makeVariantFen, type MoveNode } from "@chessgui/core/game-tree";
import { castlingFieldHasFileLetters } from "@chessgui/core/fen";

// Chess960 parse/replay/export (shared variant contract). The start position
// (SP-393-ish: RQKRBNNB) has its king on c1 and castling rooks on a1/d1, so
// the Shredder castling field is "DAda" — exactly the shape chessops' plain
// makeFen rewrites to "KQkq", which is the normalization bug these tests
// pin down. All fixtures are synthetic.
const START_960 = "rqkrbnnb/pppppppp/8/8/8/8/PPPPPPPP/RQKRBNNB w DAda - 0 1";

// 10 plies, both sides clear e1/f1/g1 (resp. e8/f8/g8) then h-side castle:
// king c1→g1, rook d1→f1 — castling that only resolves with the true rights.
const MOVES_960 = ["d4", "d5", "Ne3", "Ne6", "Nf3", "Nf6", "Bd2", "Bd7", "O-O", "O-O"];

const PGN_960 = `[Event "Synthetic 960"]
[Site "?"]
[Date "????.??.??"]
[Round "?"]
[White "?"]
[Black "?"]
[Result "*"]
[Variant "Chess960"]
[SetUp "1"]
[FEN "${START_960}"]

1. d4 d5 2. Ne3 Ne6 3. Nf3 Nf6 4. Bd2 Bd7 5. O-O O-O *`;

const castlingField = (fen: string): string => fen.split(" ")[2];

// Same structural comparison as pgn.test.ts, plus the variant flag.
function nodesEqual(a: GameTree, an: MoveNode, b: GameTree, bn: MoveNode): void {
  expect(bn.san).toBe(an.san);
  expect(bn.fen).toBe(an.fen);
  expect(bn.uci).toBe(an.uci);
  expect(bn.children.length).toBe(an.children.length);
  an.children.forEach((cid, i) => {
    nodesEqual(a, a.get(cid)!, b, b.get(bn.children[i])!);
  });
}

function treesEqual(a: GameTree, b: GameTree): void {
  expect(b.variant).toBe(a.variant);
  expect(b.startFen).toBe(a.startFen);
  expect(b.headers).toEqual(a.headers);
  nodesEqual(a, a.root(), b, b.root());
}

describe("chess960 parse & replay", () => {
  it("parses a 960 game: full ply count, variant flag, true start FEN", () => {
    const [tree] = parsePgnToTrees(PGN_960);
    expect(tree.variant).toBe("chess960");
    // The bug this pins down: with "DAda" normalized to "KQkq" the replay
    // used to drop plies; the whole mainline must come through.
    const mainline = tree.mainlineNodes();
    expect(mainline.length - 1).toBe(MOVES_960.length);
    expect(mainline.slice(1).map((n) => n.san)).toEqual(MOVES_960);
    expect(tree.startFen).toBe(START_960);
  });

  it("node FENs keep Shredder castling letters through the game", () => {
    const [tree] = parsePgnToTrees(PGN_960);
    const mainline = tree.mainlineNodes();
    // After 1. d4 both sides still hold all four rights — as file letters.
    expect(castlingField(mainline[1].fen)).toBe("DAda");
    // After White castles only Black's rights remain; after Black's, none.
    expect(castlingField(mainline[9].fen)).toBe("da");
    expect(castlingField(mainline[10].fen)).toBe("-");
  });

  it("castling SAN resolves to king-takes-rook UCI (chessops native 960 form)", () => {
    const [tree] = parsePgnToTrees(PGN_960);
    const mainline = tree.mainlineNodes();
    expect(mainline[9].san).toBe("O-O");
    expect(mainline[9].uci).toBe("c1d1"); // king c1 takes own rook d1
    expect(mainline[10].uci).toBe("c8d8");
  });

  it("a mid-game 960 FEN round-trips through parseFen + makeVariantFen", () => {
    const [tree] = parsePgnToTrees(PGN_960);
    for (const node of tree.mainlineNodes()) {
      const setup = parseFen(node.fen).unwrap();
      expect(makeVariantFen(setup, "chess960")).toBe(node.fen);
    }
  });

  it("treeToPgn emits Variant/SetUp/FEN and re-imports to an equal tree", () => {
    const [first] = parsePgnToTrees(PGN_960);
    const pgn2 = treeToPgn(first);
    expect(pgn2).toContain('[Variant "Chess960"]');
    expect(pgn2).toContain('[SetUp "1"]');
    expect(pgn2).toContain(`[FEN "${START_960}"]`);
    const [second] = parsePgnToTrees(pgn2);
    treesEqual(first, second);
  });

  it("detects 960 from the FEN castling field when [Variant] is missing", () => {
    const pgn = PGN_960.replace('[Variant "Chess960"]\n', "");
    const [tree] = parsePgnToTrees(pgn);
    expect(tree.variant).toBe("chess960");
    expect(tree.mainlineNodes().length - 1).toBe(MOVES_960.length);
    // Export restores the missing variant header.
    expect(treeToPgn(tree)).toContain('[Variant "Chess960"]');
  });

  it("accepts Variant header aliases", () => {
    for (const alias of ["chess960", "Chess 960", "Fischerandom", "Fischer Random", "FISCHERRANDOM"]) {
      const pgn = PGN_960.replace('[Variant "Chess960"]', `[Variant "${alias}"]`);
      expect(parsePgnToTrees(pgn)[0].variant).toBe("chess960");
    }
  });
});

describe("chess960 tree construction & serialization", () => {
  it("GameTree auto-detects a Shredder start FEN and keeps its rights", () => {
    const tree = GameTree.fromMoves(["d4"], START_960);
    expect(tree.variant).toBe("chess960");
    tree.goToEnd();
    expect(castlingField(tree.currentNode().fen)).toBe("DAda");
    // A tree built by play (no imported headers) still exports the variant.
    const pgn = treeToPgn(tree);
    expect(pgn).toContain('[Variant "Chess960"]');
    expect(pgn).toContain(`[FEN "${START_960}"]`);
    expect(pgn).toContain('[SetUp "1"]');
  });

  it("variant survives toJSON/fromJSON/clone; moves added after restore keep letters", () => {
    const [tree] = parsePgnToTrees(PGN_960);
    const json = tree.toJSON();
    expect(json.variant).toBe("chess960");
    const restored = GameTree.fromJSON(JSON.parse(JSON.stringify(json)));
    treesEqual(tree, restored);
    expect(restored.clone().variant).toBe("chess960");
    // addMove on a restored 960 tree still emits Shredder FENs.
    restored.goTo(restored.root().children[0]); // after 1. d4
    const id = restored.addMoveSan("c5");
    expect(id).not.toBeNull();
    expect(castlingField(restored.get(id!)!.fen)).toBe("DAda");
  });
});

describe("standard-game regression", () => {
  const STANDARD_PGN = `[Event "Test"]
[Site "?"]
[Date "2026.07.13"]
[Round "1"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. O-O 1-0`;

  it("standard games are untouched: no variant, K/Q castling, no Variant header", () => {
    const [tree] = parsePgnToTrees(STANDARD_PGN);
    expect(tree.variant).toBeUndefined();
    expect(castlingField(tree.startFen)).toBe("KQkq");
    const afterE4 = tree.mainlineNodes()[1];
    // (chessops omits a non-capturable ep square — the pre-change behavior.)
    expect(afterE4.fen).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
    // No variant key in the serialized shape — pre-existing saves' shape.
    expect("variant" in tree.toJSON()).toBe(false);
    const pgn2 = treeToPgn(tree);
    expect(pgn2).not.toContain("[Variant");
    expect(pgn2).not.toContain("[FEN");
    const [second] = parsePgnToTrees(pgn2);
    treesEqual(tree, second);
  });

  it("castlingFieldHasFileLetters distinguishes Shredder from standard fields", () => {
    expect(castlingFieldHasFileLetters(START_960)).toBe(true);
    expect(castlingFieldHasFileLetters("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toBe(false);
    expect(castlingFieldHasFileLetters("8/8/8/8/8/8/8/K6k w - - 0 1")).toBe(false);
  });
});

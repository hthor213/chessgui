import { describe, it, expect } from "vitest";
import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { GameTree, INITIAL_FEN } from "@/lib/game-tree";

// Replay a SAN line and return the FEN after the last move — an independent
// oracle for the FENs the tree stores per node.
function fenAfter(sans: string[], startFen = INITIAL_FEN): string {
  const chess = Chess.fromSetup(parseFen(startFen).unwrap()).unwrap();
  for (const san of sans) {
    chess.play(parseSan(chess, san)!);
  }
  return makeFen(chess.toSetup());
}

function line(sans: string[]): GameTree {
  const t = GameTree.create();
  for (const san of sans) {
    const id = t.addMoveSan(san);
    expect(id).not.toBeNull();
  }
  return t;
}

describe("GameTree — construction", () => {
  it("starts at the root with the normalized start FEN", () => {
    const t = GameTree.create();
    expect(t.atStart()).toBe(true);
    expect(t.atEnd()).toBe(true);
    expect(t.currentNode().fen).toBe(INITIAL_FEN);
    expect(t.root().children).toHaveLength(0);
  });

  it("can start from an arbitrary FEN", () => {
    const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
    const t = GameTree.create(fen);
    expect(t.currentNode().fen).toBe(fen);
    expect(t.startFen).toBe(fen);
  });
});

describe("GameTree — addMove (mainline)", () => {
  it("appends moves to the mainline and advances the cursor", () => {
    const t = line(["e4", "e5", "Nf3"]);
    const lineNodes = t.currentLine();
    expect(lineNodes.map((n) => n.san)).toEqual(["e4", "e5", "Nf3"]);
    expect(t.currentIndex()).toBe(2);
    expect(t.atEnd()).toBe(true);
  });

  it("stores the correct FEN after every node", () => {
    const t = line(["e4", "c5", "Nf3", "d6"]);
    const nodes = t.currentLine();
    const sans = ["e4", "c5", "Nf3", "d6"];
    nodes.forEach((n, i) => {
      expect(n.fen).toBe(fenAfter(sans.slice(0, i + 1)));
    });
  });

  it("assigns increasing ply", () => {
    const t = line(["e4", "e5", "Nf3"]);
    expect(t.currentLine().map((n) => n.ply)).toEqual([1, 2, 3]);
  });

  it("rejects an illegal move", () => {
    const t = GameTree.create();
    expect(t.addMoveSan("e5")).toBeNull(); // black can't move first
    expect(t.root().children).toHaveLength(0);
  });
});

describe("GameTree — variations", () => {
  it("creates a variation when a different move is played mid-game", () => {
    const t = line(["e4", "e5", "Nf3"]);
    t.goToStart();
    t.forward(); // after 1. e4, cursor on the e4 node
    const varId = t.addMoveSan("c5"); // Sicilian instead of 1...e5
    expect(varId).not.toBeNull();

    const e4 = t.pathToNode(varId!)[1];
    expect(e4.children).toHaveLength(2); // e5 (mainline) + c5 (variation)
    expect(t.get(e4.children[0])!.san).toBe("e5");
    expect(t.get(e4.children[1])!.san).toBe("c5");
    // The original mainline is untouched (not truncated).
    expect(t.get(e4.children[0])!.children).toHaveLength(1);
  });

  it("does not create duplicate children for the same move", () => {
    const t = line(["e4", "e5"]);
    t.goToStart();
    t.forward();
    const e4 = t.currentNode();
    const before = e4.children.length;
    const again = t.addMoveSan("e5"); // same move already exists
    expect(e4.children.length).toBe(before); // no new branch on the e4 node
    // cursor jumped onto the existing node
    expect(t.get(again!)!.san).toBe("e5");
  });

  it("supports nested variations", () => {
    const t = line(["e4", "e5", "Nf3"]);
    t.goToStart();
    t.forward();
    t.addMoveSan("c5"); // variation at ply 1
    t.addMoveSan("Nf3"); // continue the variation
    const nested = t.addMoveSan("Nc6"); // ply-3 within the variation
    expect(nested).not.toBeNull();
    expect(t.pathToNode(nested!).map((n) => n.san)).toEqual(["", "e4", "c5", "Nf3", "Nc6"]);
  });
});

describe("GameTree — navigation", () => {
  it("walks forward/backward and to start/end along the mainline", () => {
    const t = line(["e4", "e5", "Nf3", "Nc6"]);
    t.goToStart();
    expect(t.atStart()).toBe(true);
    expect(t.forward()).toBe(true);
    expect(t.currentNode().san).toBe("e4");
    t.goToEnd();
    expect(t.currentNode().san).toBe("Nc6");
    expect(t.backward()).toBe(true);
    expect(t.currentNode().san).toBe("Nf3");
  });

  it("forward/backward report false at the boundaries", () => {
    const t = line(["e4"]);
    t.goToStart();
    expect(t.backward()).toBe(false);
    t.goToEnd();
    expect(t.forward()).toBe(false);
  });

  it("enterVariation moves into a sideline", () => {
    const t = line(["e4", "e5"]);
    t.goToStart();
    t.forward();
    t.addMoveSan("c5");
    t.backward(); // back on the e4 node
    expect(t.enterVariation(1)).toBe(true);
    expect(t.currentNode().san).toBe("c5");
  });

  it("currentLine follows the active variation's continuation", () => {
    const t = line(["e4", "e5", "Nf3"]);
    t.goToStart();
    t.forward();
    t.addMoveSan("c5");
    t.addMoveSan("Nf3");
    t.addMoveSan("d6");
    t.backward();
    t.backward(); // cursor on the c5 node
    expect(t.currentLine().map((n) => n.san)).toEqual(["e4", "c5", "Nf3", "d6"]);
    expect(t.currentIndex()).toBe(1);
  });

  it("isMainline distinguishes the mainline from a sideline", () => {
    const t = line(["e4", "e5"]);
    t.goToEnd();
    expect(t.isMainline()).toBe(true);
    t.goToStart();
    t.forward();
    const c5 = t.addMoveSan("c5");
    t.goTo(c5!);
    expect(t.isMainline()).toBe(false);
  });
});

describe("GameTree — promoteVariation", () => {
  it("swaps a variation into the mainline slot", () => {
    const t = line(["e4", "e5"]);
    t.goToStart();
    t.forward();
    const c5 = t.addMoveSan("c5");
    const e4 = t.get(t.get(c5!)!.parent!)!;
    expect(t.get(e4.children[0])!.san).toBe("e5");
    t.promoteVariation(c5!);
    expect(t.get(e4.children[0])!.san).toBe("c5");
    expect(t.get(e4.children[1])!.san).toBe("e5");
  });

  it("promotes a deep sideline node by its branch head", () => {
    const t = line(["e4", "e5", "Nf3"]);
    t.goToStart();
    t.forward();
    t.addMoveSan("c5");
    const deep = t.addMoveSan("Nf3");
    const e4 = t.root().children[0];
    t.promoteVariation(deep!); // deep is inside the c5 line
    expect(t.get(t.get(e4)!.children[0])!.san).toBe("c5");
  });
});

describe("GameTree — deleteVariation", () => {
  it("removes a subtree and detaches it from the parent", () => {
    const t = line(["e4", "e5"]);
    t.goToStart();
    t.forward();
    const c5 = t.addMoveSan("c5");
    const e4 = t.get(t.get(c5!)!.parent!)!;
    expect(e4.children).toHaveLength(2);
    t.deleteVariation(c5!);
    expect(e4.children).toHaveLength(1);
    expect(t.get(c5!)).toBeUndefined();
  });

  it("removes the whole subtree, not just the head", () => {
    const t = line(["e4", "e5", "Nf3", "Nc6"]);
    const nf3 = t.currentLine()[2].id;
    const nc6 = t.currentLine()[3].id;
    t.deleteVariation(nf3);
    expect(t.get(nf3)).toBeUndefined();
    expect(t.get(nc6)).toBeUndefined();
  });

  it("retreats the cursor to the parent when it deletes the current subtree", () => {
    const t = line(["e4", "e5", "Nf3"]);
    const e5 = t.currentLine()[1].id;
    t.goToEnd(); // cursor on Nf3, inside the e5 subtree
    t.deleteVariation(e5);
    expect(t.currentNode().san).toBe("e4");
  });

  it("never deletes the root", () => {
    const t = line(["e4"]);
    expect(t.deleteVariation(t.rootId)).toBe(false);
  });
});

describe("GameTree — annotations", () => {
  it("stores comments and NAGs per node", () => {
    const t = line(["e4"]);
    const id = t.currentNode().id;
    t.setComment(id, "best by test");
    t.setNags(id, [1, 14]);
    expect(t.get(id)!.comment).toBe("best by test");
    expect(t.get(id)!.nags).toEqual([1, 14]);
  });
});

describe("GameTree — serialization", () => {
  it("round-trips through JSON preserving structure and cursor", () => {
    const t = line(["e4", "e5", "Nf3"]);
    t.goToStart();
    t.forward();
    t.addMoveSan("c5"); // add a variation
    t.setComment(t.currentNode().id, "Sicilian");
    t.goToEnd();

    const restored = GameTree.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
    expect(restored.currentId).toBe(t.currentId);
    expect(restored.rootId).toBe(t.rootId);
    expect(restored.nodes.size).toBe(t.nodes.size);
    expect(restored.currentLine().map((n) => n.san)).toEqual(t.currentLine().map((n) => n.san));
    // FENs survive intact
    for (const [id, node] of t.nodes) {
      expect(restored.get(id)!.fen).toBe(node.fen);
    }
  });

  it("continues id allocation after a round-trip without collisions", () => {
    const t = line(["e4", "e5"]);
    const restored = GameTree.fromJSON(t.toJSON());
    restored.goToEnd();
    const newId = restored.addMoveSan("Nf3");
    expect(newId).not.toBeNull();
    expect(restored.nodes.size).toBe(4); // root + 3 moves, no overwrite
  });

  it("clone produces an independent copy", () => {
    const t = line(["e4", "e5"]);
    const c = t.clone();
    c.goToEnd();
    c.addMoveSan("Nf3");
    // mutating the clone must not touch the original
    expect(t.currentLine().map((n) => n.san)).toEqual(["e4", "e5"]);
    expect(c.currentLine().map((n) => n.san)).toEqual(["e4", "e5", "Nf3"]);
  });
});

describe("GameTree — fromMoves (legacy flat list)", () => {
  it("builds a mainline and rests the cursor at the start", () => {
    const t = GameTree.fromMoves(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
    expect(t.atStart()).toBe(true);
    t.goToEnd();
    expect(t.currentLine().map((n) => n.san)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
  });

  it("stops at the first illegal move instead of throwing", () => {
    const t = GameTree.fromMoves(["e4", "e5", "Zz9", "Nf3"]);
    t.goToEnd();
    expect(t.currentLine().map((n) => n.san)).toEqual(["e4", "e5"]);
  });

  it("handles UCI moves including castling", () => {
    const t = GameTree.create();
    for (const uci of ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1g1"]) {
      expect(t.addMoveUci(uci)).not.toBeNull();
    }
    expect(t.currentNode().san).toBe("O-O");
  });
});

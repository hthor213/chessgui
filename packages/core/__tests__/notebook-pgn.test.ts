import { describe, it, expect } from "vitest";
import { GameTree, type MoveNode } from "@chessgui/core/game-tree";
import { parsePgnToTrees, treeToPgn } from "@chessgui/core/pgn";
import { splitComment } from "@chessgui/core/annotations";
import { backupTree } from "@chessgui/core/notebook";

// A notebook is worth nothing if it doesn't survive being written down, so the
// bar here is the same as the rest of spec 013: import → export → import is
// byte-identical, with the human judgement intact on the far side.

function roundTrip(tree: GameTree): { pgn: string; again: GameTree } {
  // A freshly built tree has no headers, which the first export fills in, so
  // stability is measured from the second pass onward — the same convention
  // the existing spec 013 round-trip tests use.
  const pgn = treeToPgn(parsePgnToTrees(treeToPgn(tree))[0]);
  const again = parsePgnToTrees(pgn)[0];
  expect(treeToPgn(again)).toBe(pgn);
  return { pgn, again };
}

function mainline(tree: GameTree): MoveNode[] {
  const out: MoveNode[] = [];
  let id: string | undefined = tree.root().children[0];
  while (id) {
    const node: MoveNode = tree.get(id)!;
    out.push(node);
    id = node.children[0];
  }
  return out;
}

describe("notebook — PGN round trip", () => {
  it("carries assessments, likelihoods and provenance through export/import", () => {
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    const e5 = t.addMoveSan("e5")!;
    t.goTo(e4);
    const c5 = t.addMoveSan("c5")!;

    t.setAssessment(e4, 1, "human-live", 1_784_505_600);
    t.setAssessment(e5, 0, "human", 1_784_505_700);
    t.setAssessment(c5, -1, "human-live", 1_784_505_800);
    t.setLikelihood(e5, 3);
    t.setLikelihood(c5, 1);

    const { pgn, again } = roundTrip(t);
    expect(pgn).toContain("[%lik 3]");
    expect(pgn).toContain("[%prov human-live,1784505600]");

    const [a, b] = mainline(again);
    expect(a!.nags).toEqual([14]);
    expect(a!.assessedBy).toBe("human-live");
    expect(a!.assessedAt).toBe(1_784_505_600);
    expect(b!.nags).toEqual([10]);
    expect(b!.lik).toBe(3);
    expect(b!.assessedBy).toBe("human");

    const alt = again.get(a!.children[1])!;
    expect(alt.san).toBe("c5");
    expect(alt.nags).toEqual([15]);
    expect(alt.lik).toBe(1);

    // And the backed-up value is the same on the far side: min over Black's
    // two judged replies.
    expect(backupTree(again, "white").get(a!.id)!.objective).toBe(-1);
  });

  it("keeps a book move from becoming one of my candidates on re-import", () => {
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    t.goTo(t.rootId);
    t.addMoveUciFromDatabase("d2d4");
    t.setAssessment(e4, 1, "human", 1_784_505_600);

    const { pgn, again } = roundTrip(t);
    expect(pgn).toContain("[%src db]");
    const alt = again.get(again.root().children[1])!;
    expect(alt.san).toBe("d4");
    expect(alt.src).toBe("database");
    expect(backupTree(again, "white").get(again.rootId)!.named).toBe(1);
  });

  it("shares a comment with text, arrows, a clock and an engine eval", () => {
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    t.setComment(e4, "the only move I trust here");
    t.setArrows(e4, [
      { orig: "e4", brush: "green" },
      { orig: "d2", dest: "d4", brush: "red" },
    ]);
    t.setEval(e4, { cp: 31, depth: 20 });
    t.get(e4)!.clock = 3600;
    t.setAssessment(e4, 2, "human", 1_784_505_600);
    t.setLikelihood(e4, 2);

    const { again } = roundTrip(t);
    const node = again.root().children.map((id) => again.get(id)!)[0];
    expect(node.comment).toBe("the only move I trust here");
    expect(node.lik).toBe(2);
    expect(node.assessedBy).toBe("human");
    expect(node.nags).toEqual([16]);
    // The engine verdict rides in its own field and is untouched by any of it.
    expect(node.eval).toEqual({ cp: 31, depth: 20 });
    expect(node.clock).toBe(3600);
    expect(node.arrows).toHaveLength(2);
  });

  it("hides both tags from the comment editor", () => {
    const { text, tags } = splitComment("looks winning [%lik 3] [%prov human-live,1784505600]");
    expect(text).toBe("looks winning");
    expect(tags).toEqual(["[%lik 3]", "[%prov human-live,1784505600]"]);
  });

  it("survives a localStorage round trip", () => {
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    t.setAssessment(e4, -3, "human-live", 99);
    t.setLikelihood(e4, 1);
    const back = GameTree.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
    const node = back.get(e4)!;
    expect(node.nags).toEqual([19]);
    expect(node.lik).toBe(1);
    expect(node.assessedBy).toBe("human-live");
    expect(node.assessedAt).toBe(99);
  });
});

import { describe, it, expect } from "vitest";
import { GameTree, type SerializedTree } from "@chessgui/core/game-tree";
import {
  toggleNag,
  nagsToGlyphs,
  glyphToNag,
  splitComment,
  joinComment,
  parseEvalTag,
  nodeEval,
  evalToUnit,
  formatEval,
  judgeMove,
} from "@chessgui/core/annotations";

function line(sans: string[]): GameTree {
  const t = GameTree.create();
  for (const san of sans) {
    const id = t.addMoveSan(san);
    expect(id).not.toBeNull();
  }
  return t;
}

describe("GameTree — per-node eval storage (spec 202)", () => {
  it("stores an eval on a node and returns true", () => {
    const t = line(["e4", "e5"]);
    const id = t.currentId;
    expect(t.setEval(id, { cp: 25, depth: 18 })).toBe(true);
    expect(t.get(id)!.eval).toEqual({ cp: 25, depth: 18 });
  });

  it("refuses to overwrite a deeper eval with a shallower one", () => {
    const t = line(["e4"]);
    const id = t.currentId;
    t.setEval(id, { cp: 30, depth: 20 });
    expect(t.setEval(id, { cp: 90, depth: 12 })).toBe(false);
    expect(t.get(id)!.eval).toEqual({ cp: 30, depth: 20 });
  });

  it("updates when depth is equal-or-deeper and value changed; no-ops on identical", () => {
    const t = line(["e4"]);
    const id = t.currentId;
    t.setEval(id, { cp: 30, depth: 20 });
    expect(t.setEval(id, { cp: 35, depth: 20 })).toBe(true); // same depth, new value
    expect(t.setEval(id, { cp: 35, depth: 20 })).toBe(false); // identical → unchanged
    expect(t.setEval(id, { mate: 3, depth: 25 })).toBe(true); // deeper, mate replaces cp
    expect(t.get(id)!.eval).toEqual({ mate: 3, depth: 25 });
  });

  it("returns false for unknown node ids", () => {
    const t = line(["e4"]);
    expect(t.setEval("nope", { cp: 0, depth: 10 })).toBe(false);
  });
});

describe("GameTree — serialization compatibility", () => {
  it("round-trips evals, comments, NAGs and shapes through toJSON/fromJSON", () => {
    const t = line(["e4", "e5", "Nf3"]);
    const id = t.currentId;
    t.setEval(id, { cp: 42, depth: 15 });
    t.setComment(id, "A natural developing move. [%eval 0.42]");
    t.setNags(id, [1]);
    t.setArrows(id, [
      { orig: "f3", dest: "e5", brush: "green" },
      { orig: "d4", brush: "red" }, // circle: no dest
    ]);

    const restored = GameTree.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
    const node = restored.get(id)!;
    expect(node.eval).toEqual({ cp: 42, depth: 15 });
    expect(node.comment).toBe("A natural developing move. [%eval 0.42]");
    expect(node.nags).toEqual([1]);
    expect(node.arrows).toEqual([
      { orig: "f3", dest: "e5", brush: "green" },
      { orig: "d4", brush: "red" },
    ]);
  });

  it("loads older saves whose nodes have no eval field", () => {
    const t = line(["e4", "e5"]);
    // Simulate a pre-eval save: serialize, then strip the key the way an old
    // blob simply wouldn't have it.
    const blob: SerializedTree = JSON.parse(JSON.stringify(t.toJSON()));
    for (const node of Object.values(blob.nodes)) {
      delete (node as unknown as Record<string, unknown>).eval;
    }
    const restored = GameTree.fromJSON(blob);
    expect(restored.currentNode().eval).toBeUndefined();
    expect(restored.currentNode().san).toBe("e5");
    // and the tree is still fully mutable
    expect(restored.setEval(restored.currentId, { cp: 10, depth: 12 })).toBe(true);
  });

  it("normalizes nodes from saves missing annotation arrays entirely", () => {
    const t = line(["e4"]);
    const blob: SerializedTree = JSON.parse(JSON.stringify(t.toJSON()));
    for (const node of Object.values(blob.nodes)) {
      const n = node as unknown as Record<string, unknown>;
      delete n.comment;
      delete n.nags;
      delete n.arrows;
      delete n.eval;
    }
    const restored = GameTree.fromJSON(blob);
    const node = restored.currentNode();
    expect(node.comment).toBe("");
    expect(node.nags).toEqual([]);
    expect(node.arrows).toEqual([]);
    expect(node.eval).toBeUndefined();
  });
});

describe("GameTree — mainlineNodes", () => {
  it("returns root plus the children[0] chain, ignoring variations", () => {
    const t = line(["e4", "e5", "Nf3"]);
    // add a variation at move 2 for black
    t.goToStart();
    t.forward(); // after e4
    t.addMoveSan("c5"); // variation
    const main = t.mainlineNodes();
    expect(main.map((n) => n.san)).toEqual(["", "e4", "e5", "Nf3"]);
  });
});

describe("NAG helpers", () => {
  it("toggles a NAG on and off", () => {
    expect(toggleNag([], 1)).toEqual([1]);
    expect(toggleNag([1], 1)).toEqual([]);
  });

  it("move NAGs are mutually exclusive; positional NAGs coexist with them", () => {
    expect(toggleNag([1], 4)).toEqual([4]); // ! replaced by ??
    expect(toggleNag([1], 14)).toEqual([1, 14]); // ! + ⩲ coexist
    expect(toggleNag([1, 14], 18)).toEqual([1, 18]); // ⩲ replaced by +−
  });

  it("maps glyph buffers to move NAGs", () => {
    expect(glyphToNag("!")).toBe(1);
    expect(glyphToNag("?")).toBe(2);
    expect(glyphToNag("!!")).toBe(3);
    expect(glyphToNag("??")).toBe(4);
    expect(glyphToNag("!?")).toBe(5);
    expect(glyphToNag("?!")).toBe(6);
    expect(glyphToNag("x")).toBeNull();
  });

  it("renders glyphs with move-quality symbols first", () => {
    expect(nagsToGlyphs([14, 1])).toBe("!⩲");
    expect(nagsToGlyphs([99])).toBe("$99");
  });
});

describe("comment tag handling", () => {
  it("splits text from [%...] tags and rejoins them", () => {
    const c = "The Ruy Lopez. [%cal Gb5c6,Gb5a4] [%eval 0.25]";
    const { text, tags } = splitComment(c);
    expect(text).toBe("The Ruy Lopez.");
    expect(tags).toEqual(["[%cal Gb5c6,Gb5a4]", "[%eval 0.25]"]);
    expect(joinComment("New text.", tags)).toBe("New text. [%cal Gb5c6,Gb5a4] [%eval 0.25]");
  });

  it("handles comments with no tags and tags with no text", () => {
    expect(splitComment("just words")).toEqual({ text: "just words", tags: [] });
    expect(splitComment("[%clk 0:05:00]")).toEqual({ text: "", tags: ["[%clk 0:05:00]"] });
    expect(joinComment("", ["[%clk 0:05:00]"])).toBe("[%clk 0:05:00]");
    expect(joinComment("", [])).toBe("");
  });
});

describe("[%eval] parsing and eval display", () => {
  it("parses pawn evals into centipawns", () => {
    expect(parseEvalTag("[%eval 0.25]")).toEqual({ cp: 25, depth: 0 });
    expect(parseEvalTag("nice [%eval -1.5] move")).toEqual({ cp: -150, depth: 0 });
  });

  it("parses mate evals", () => {
    expect(parseEvalTag("[%eval #5]")).toEqual({ mate: 5, depth: 0 });
    expect(parseEvalTag("[%eval #-3]")).toEqual({ mate: -3, depth: 0 });
  });

  it("returns null when absent or malformed", () => {
    expect(parseEvalTag("no tag here")).toBeNull();
    expect(parseEvalTag("[%eval abc]")).toBeNull();
  });

  it("nodeEval prefers the stored engine eval over the comment tag", () => {
    const withBoth = { eval: { cp: 50, depth: 20 }, comment: "[%eval -1.0]" };
    expect(nodeEval(withBoth)).toEqual({ cp: 50, depth: 20 });
    const tagOnly = { comment: "[%eval -1.0]" };
    expect(nodeEval(tagOnly)).toEqual({ cp: -100, depth: 0 });
    expect(nodeEval({ comment: "" })).toBeNull();
  });

  it("squashes evals into [-1, 1] with mates at the extremes", () => {
    expect(evalToUnit({ cp: 0, depth: 1 })).toBe(0);
    expect(evalToUnit({ cp: 200, depth: 1 })).toBeGreaterThan(0);
    expect(evalToUnit({ cp: -200, depth: 1 })).toBeLessThan(0);
    expect(evalToUnit({ cp: 10000, depth: 1 })).toBeLessThanOrEqual(1);
    expect(evalToUnit({ mate: 2, depth: 1 })).toBe(1);
    expect(evalToUnit({ mate: -2, depth: 1 })).toBe(-1);
  });

  it("formats evals for the tooltip", () => {
    expect(formatEval({ cp: 42, depth: 1 })).toBe("+0.4");
    expect(formatEval({ cp: -130, depth: 1 })).toBe("-1.3");
    expect(formatEval({ mate: -3, depth: 1 })).toBe("#-3");
  });
});

describe("judgeMove — blunder detection thresholds (spec 202)", () => {
  const cp = (v: number) => ({ cp: v, depth: 10 });
  const mate = (v: number) => ({ mate: v, depth: 10 });

  it("classifies white drops at the spec boundaries", () => {
    expect(judgeMove(cp(0), cp(-49), true)).toBeNull(); // under 0.5 pawns
    expect(judgeMove(cp(0), cp(-50), true)).toBe("inaccuracy"); // 0.5 exactly
    expect(judgeMove(cp(0), cp(-99), true)).toBe("inaccuracy");
    expect(judgeMove(cp(0), cp(-100), true)).toBe("mistake"); // 1.0 → worse tier
    expect(judgeMove(cp(0), cp(-300), true)).toBe("mistake"); // 3.0 still mistake
    expect(judgeMove(cp(0), cp(-301), true)).toBe("blunder"); // >3.0
  });

  it("orients the drop for the black mover", () => {
    // white-perspective eval rising after a black move is black's loss
    expect(judgeMove(cp(0), cp(150), false)).toBe("mistake");
    expect(judgeMove(cp(-50), cp(300), false)).toBe("blunder");
    // and a rise after a white move is no drop at all
    expect(judgeMove(cp(0), cp(150), true)).toBeNull();
  });

  it("never flags improvements or holds, however large", () => {
    expect(judgeMove(cp(-400), cp(400), true)).toBeNull();
    expect(judgeMove(cp(30), cp(30), true)).toBeNull();
    expect(judgeMove(cp(300), cp(-500), false)).toBeNull();
  });

  it("treats a thrown-away mate as a blunder", () => {
    expect(judgeMove(mate(3), cp(0), true)).toBe("blunder");
    expect(judgeMove(mate(-2), cp(-20), false)).toBe("blunder");
    expect(judgeMove(mate(2), mate(-2), true)).toBe("blunder");
  });

  it("does not flag swings that stay decisively won", () => {
    expect(judgeMove(mate(2), mate(8), true)).toBeNull(); // longer mate, still mate
    expect(judgeMove(cp(2000), cp(1200), true)).toBeNull(); // both beyond the cap
    expect(judgeMove(mate(3), cp(1500), true)).toBeNull(); // mate → crushing eval
  });
});

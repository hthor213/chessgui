// Spec 226 E: sharpness — how many of the user's own candidates reach the
// node's backed-up value.
//
// "9 bad and 1 brilliant" and "10 good" back up to the same number and are
// completely different positions to sit in front of. The load-bearing claims
// here are the same shape as branch width's: the number is reported, it is
// silent whenever it could mislead, and NOTHING sorts on it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GameTree } from "@chessgui/core/game-tree";
import {
  backupTree,
  compareSiblings,
  sharpnessLabel,
  sortedChildren,
  type Assessment,
} from "@chessgui/core/notebook";

// Same idiom as the other notebook suites: trees are built by playing real
// moves, because that is the only way a candidate comes into existence.
function addAt(t: GameTree, parentId: string, san: string): string {
  t.goTo(parentId);
  const id = t.addMoveSan(san);
  expect(id, `illegal test move ${san}`).not.toBeNull();
  return id!;
}

function assess(t: GameTree, id: string, a: Assessment): void {
  t.setAssessment(id, a, "human", 1_700_000_000);
}

/** Ten first moves the user named themselves, judged as `values` says. */
function tenCandidates(values: Assessment[]): GameTree {
  const sans = ["e4", "d4", "c4", "Nf3", "Nc3", "e3", "d3", "b3", "g3", "a3"];
  const t = GameTree.create();
  sans.forEach((san, i) => assess(t, addAt(t, t.rootId, san), values[i]));
  return t;
}

describe("sharpness — the second axis on the same value", () => {
  it("reads 1 of 10 when nine are bad and one is brilliant", () => {
    // The question that prompted the whole spec: the tenth move IS the value,
    // and the other nine tell you not what the position is worth but what it
    // costs to get it wrong.
    const t = tenCandidates([-2, -2, -2, -2, -2, -2, -2, -2, -2, 3]);
    const v = backupTree(t, "white").get(t.rootId)!;
    expect(v.objective).toBe(3);
    expect(v.sharpness).toEqual({ reaching: 1, of: 10 });
    expect(sharpnessLabel(v)).toBe("1 of my 10 reach it");
  });

  it("reads 10 of 10 when every candidate is equally good", () => {
    // Same shape of tree, same kind of value, opposite position to play.
    const t = tenCandidates([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const v = backupTree(t, "white").get(t.rootId)!;
    expect(v.objective).toBe(1);
    expect(v.sharpness).toEqual({ reaching: 10, of: 10 });
    expect(sharpnessLabel(v)).toBe("10 of my 10 reach it");
  });

  it("counts the opponent's replies that hold his best, at his nodes", () => {
    // Minimax runs the other way for him, so "reaching" means reaching the min
    // — the replies that actually refute, which is the count that matters when
    // deciding whether he has to find something.
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    for (const [san, a] of [["e5", 1], ["c5", -2], ["e6", 1], ["c6", 1]] as const) {
      assess(t, addAt(t, e4, san), a);
    }
    const v = backupTree(t, "white").get(e4)!;
    expect(v.objective).toBe(-2);
    expect(v.sharpness).toEqual({ reaching: 1, of: 4 });
  });
});

describe("sharpness stays silent rather than saying something it cannot mean", () => {
  it("says nothing on a single judged candidate — '1 of 1' is not sharpness", () => {
    // Every move of a played game has exactly one child. "1 of 1" there would
    // stamp the entire history maximally sharp on the strength of the user
    // having judged one move, which is a statement about effort wearing the
    // clothes of a statement about the position.
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    assess(t, e4, 1);
    const v = backupTree(t, "white").get(t.rootId)!;
    expect(v.objective).toBe(1);
    expect(v.sharpness).toBeNull();
    expect(sharpnessLabel(v)).toBe("");
  });

  it("says nothing while the user's own list is still unjudged", () => {
    // Five of six judged: the sixth could double the number that reach the
    // value, or raise the value and knock every one of them off it. Sharpness
    // inherits width's confound — "only one works" and "I only looked at one"
    // are indistinguishable without coverage — so it waits.
    const sans = ["e4", "d4", "c4", "Nf3", "Nc3", "e3"];
    const t = GameTree.create();
    const ids = sans.map((san) => addAt(t, t.rootId, san));
    ids.slice(0, 5).forEach((id, i) => assess(t, id, i === 0 ? 2 : -1));
    let v = backupTree(t, "white").get(t.rootId)!;
    expect(v.examined).toBe(5);
    expect(v.named).toBe(6);
    expect(v.sharpness).toBeNull();
    expect(sharpnessLabel(v)).toBe("");

    // Closing the list is what makes the count sayable.
    assess(t, ids[5], -1);
    v = backupTree(t, "white").get(t.rootId)!;
    expect(v.sharpness).toEqual({ reaching: 1, of: 6 });
  });

  it("says nothing at a node with no judged candidate at all", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    assess(t, e4, 1);
    expect(backupTree(t, "white").get(e4)!.sharpness).toBeNull();
  });
});

describe("sharpness is measured over the user's own candidates only", () => {
  it("excludes a move the app supplied, and reports 0 when only that one reaches", () => {
    // The book move holds the value and none of the user's own do. "0 of my 3"
    // is the honest reading and the most valuable thing the number ever says:
    // the best line here was not one they named.
    const t = GameTree.create();
    for (const [san, a] of [["e4", -1], ["d4", -1], ["c4", -1]] as const) {
      assess(t, addAt(t, t.rootId, san), a);
    }
    t.goTo(t.rootId);
    const nf3 = t.addMoveUciFromDatabase("g1f3")!;
    assess(t, nf3, 3);

    const v = backupTree(t, "white").get(t.rootId)!;
    expect(v.objective).toBe(3);
    // Coverage counts the user's three, so sharpness counts out of the same
    // three — the two numbers are only readable side by side if they share a
    // denominator.
    expect(v.named).toBe(3);
    expect(v.sharpness).toEqual({ reaching: 0, of: 3 });
    expect(sharpnessLabel(v)).toBe("0 of my 3 reach it");
  });
});

describe("nothing sorts on sharpness", () => {
  /**
   * Two branches of the user's that agree on BOTH ranking keys and disagree on
   * sharpness: after 1.e4 Black's four replies are judged −2/0/0/+2 (one reply
   * holds the min), after 1.d4 they are −2/−2/+1/+3 (two do). Same min, same
   * weighted mean, so objective and practical are identical and only sharpness
   * separates them. `first` decides which was explored first.
   */
  function twoBranches(first: "e4" | "d4"): { t: GameTree; e4: string; d4: string } {
    const t = GameTree.create();
    const build = (san: string, replies: [string, Assessment][]) => {
      const id = addAt(t, t.rootId, san);
      for (const [r, a] of replies) assess(t, addAt(t, id, r), a);
      return id;
    };
    const e4Replies: [string, Assessment][] = [["e5", -2], ["c5", 0], ["e6", 0], ["c6", 2]];
    const d4Replies: [string, Assessment][] = [["d5", -2], ["Nf6", -2], ["e6", 1], ["f5", 3]];
    if (first === "e4") {
      const e4 = build("e4", e4Replies);
      return { t, e4, d4: build("d4", d4Replies) };
    }
    const d4 = build("d4", d4Replies);
    return { t, e4: build("e4", e4Replies), d4 };
  }

  it("leaves objectively-and-practically tied siblings in exploration order", () => {
    for (const first of ["e4", "d4"] as const) {
      const { t, e4, d4 } = twoBranches(first);
      const values = backupTree(t, "white");
      expect(values.get(e4)!.objective).toBe(values.get(d4)!.objective);
      expect(values.get(e4)!.practical).toBe(values.get(d4)!.practical);
      expect(values.get(e4)!.sharpness).toEqual({ reaching: 1, of: 4 });
      expect(values.get(d4)!.sharpness).toEqual({ reaching: 2, of: 4 });
      // The sharper branch neither climbs nor sinks: whichever was played
      // first stays first, exactly as it would with no sharpness at all.
      expect(sortedChildren(t, values, t.rootId)).toEqual(
        first === "e4" ? [e4, d4] : [d4, e4],
      );
    }
  });

  it("is invisible to compareSiblings in both directions", () => {
    const { t, e4, d4 } = twoBranches("e4");
    const values = backupTree(t, "white");
    expect(compareSiblings(values.get(e4), values.get(d4), true)).toBe(0);
    expect(compareSiblings(values.get(e4), values.get(d4), false)).toBe(0);
  });

  it("no ranking code reads the field", () => {
    // The prohibition is structural, not a property of the fixtures above: the
    // sort keys are objective → practical → Copeland → exploration order, and
    // sharpness appears in none of them.
    const src = readFileSync(
      path.join(process.cwd(), "packages/core/src/notebook.ts"),
      "utf8",
    );
    // compareSiblings, copelandScores and sortedChildren — every key the
    // display order is built from, and nothing else.
    const ranking = src.slice(
      src.indexOf("export function compareSiblings"),
      src.indexOf("export const MOST_LIKELY_MAX_PLY"),
    );
    expect(ranking.includes("sharpness")).toBe(false);
  });
});

describe("sharpness waits for the candidates themselves to stop moving", () => {
  it("says nothing while a counted candidate rests on one of its own named replies", () => {
    // 1.e4 with nine replies named and only e5 judged, beside 1.d4 judged
    // directly and 1.c4 equal. The list at the root is closed, so the old
    // guard let "2 of my 3 reach it" through — asserting two of the user's
    // moves win when the record supports one, since e4's value rests on a
    // ninth of what they themselves named. Judging any of the other eight
    // lower would move the count with nothing else on screen changing.
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const replies = ["e5", "c5", "e6", "c6", "d5", "Nf6", "d6", "g6", "b6"];
    const ids = replies.map((san) => addAt(t, e4, san));
    assess(t, ids[0], 3);
    assess(t, addAt(t, t.rootId, "d4"), 3);
    assess(t, addAt(t, t.rootId, "c4"), 0);

    let v = backupTree(t, "white").get(t.rootId)!;
    expect(v.objective).toBe(3);
    expect(v.examined).toBe(3);
    expect(v.named).toBe(3);
    expect(v.sharpness).toBeNull();
    expect(sharpnessLabel(v)).toBe("");

    // Closing e4's own list is what makes the root's count sayable — and the
    // honest count is one, not two.
    ids.slice(1).forEach((id) => assess(t, id, 0));
    v = backupTree(t, "white").get(t.rootId)!;
    expect(v.objective).toBe(3);
    expect(v.sharpness).toEqual({ reaching: 1, of: 3 });
  });

  it("says nothing when every candidate is judged but each is one reply deep", () => {
    // Six candidates, all judged, each explored one of three replies: the
    // count looks settled and is not. One more reply under the leading branch
    // drops its value and moves the count to a different candidate.
    const t = GameTree.create();
    const openings: [string, string[]][] = [
      ["e4", ["e5", "c5", "e6"]],
      ["d4", ["d5", "Nf6", "f5"]],
      ["c4", ["e5", "c5", "Nf6"]],
      ["Nf3", ["d5", "Nf6", "c5"]],
      ["Nc3", ["d5", "e5", "c5"]],
      ["g3", ["d5", "e5", "g6"]],
    ];
    for (const [san, replies] of openings) {
      const id = addAt(t, t.rootId, san);
      const kids = replies.map((r) => addAt(t, id, r));
      assess(t, kids[0], san === "e4" ? 2 : 0);
    }
    const v = backupTree(t, "white").get(t.rootId)!;
    expect(v.examined).toBe(6);
    expect(v.named).toBe(6);
    expect(v.allCandidatesExamined).toBe(false);
    expect(v.sharpness).toBeNull();
  });
});

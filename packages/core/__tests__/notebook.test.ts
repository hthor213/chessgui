import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { GameTree } from "@chessgui/core/game-tree";
import {
  assessmentGlyph,
  assessmentNag,
  assessmentOf,
  assessmentSymbolOf,
  backupAt,
  backupTree,
  compareSiblings,
  coverageChip,
  coverageLabel,
  formatValue,
  sortedChildren,
  type Assessment,
} from "@chessgui/core/notebook";

// Trees are built by playing real moves, because that is exactly how the user
// builds them — a candidate at a node IS a child of that node, and there is no
// other way for one to come into existence.
function addAt(t: GameTree, parentId: string, san: string): string {
  t.goTo(parentId);
  const id = t.addMoveSan(san);
  expect(id, `illegal test move ${san}`).not.toBeNull();
  return id!;
}

function assess(t: GameTree, id: string, a: Assessment | null): void {
  t.setAssessment(id, a, "human", 1_700_000_000);
}

describe("notebook — the assessment scale", () => {
  it("maps the seven symbols onto position-assessment NAGs", () => {
    expect([-3, -2, -1, 0, 1, 2, 3].map((a) => assessmentNag(a as Assessment))).toEqual([
      19, 17, 15, 10, 14, 16, 18,
    ]);
    expect(assessmentGlyph(3)).toBe("+−");
    expect(assessmentGlyph(0)).toBe("=");
    expect(assessmentGlyph(-3)).toBe("−+");
  });

  it("treats $13 (unclear) as explored-but-unassessed, not as equal", () => {
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    t.setNags(e4, [13]);
    expect(assessmentOf(t.get(e4)!)).toBeNull();
    expect(backupAt(t, e4, "white")!.objective).toBeNull();
  });

  it("setAssessment replaces the previous symbol and stamps provenance", () => {
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    expect(t.setAssessment(e4, 1, "human-live", 42)).toBe(true);
    expect(t.get(e4)!.nags).toEqual([14]);
    expect(t.get(e4)!.assessedBy).toBe("human-live");
    expect(t.get(e4)!.assessedAt).toBe(42);

    t.setAssessment(e4, -2, "human", 43);
    expect(t.get(e4)!.nags).toEqual([17]);

    // Clearing drops the stamp too — an unjudged node has no provenance.
    expect(t.setAssessment(e4, null, "human", 44)).toBe(true);
    expect(t.get(e4)!.nags).toEqual([]);
    expect(t.get(e4)!.assessedBy).toBeUndefined();
    expect(t.setAssessment(e4, null, "human", 44)).toBe(false);
  });

  it("setAssessment leaves move-quality NAGs alone", () => {
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    t.setNags(e4, [1]); // "!"
    t.setAssessment(e4, 2, "human", 1);
    expect(t.get(e4)!.nags).toEqual([1, 16]);
  });

  it("setLikelihood stores and clears the bucket", () => {
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    expect(t.setLikelihood(e4, 3)).toBe(true);
    expect(t.get(e4)!.lik).toBe(3);
    expect(t.setLikelihood(e4, 3)).toBe(false);
    expect(t.setLikelihood(e4, null)).toBe(true);
    expect(t.get(e4)!.lik).toBeUndefined();
  });
});

describe("notebook — only the user's own judgements count", () => {
  it("ignores a position symbol nobody stamped as human", () => {
    // How an imported game arrives: NAGs, no provenance. It may well be the
    // user's own game re-imported after a machine review, so reading it would
    // be that verdict re-entering the notebook at machine speed.
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    t.setNags(e4, [16]); // "±" from wherever
    expect(assessmentSymbolOf(t.get(e4)!)).toBe(2); // still visible as an annotation
    expect(assessmentOf(t.get(e4)!)).toBeNull(); // but nobody's judgement
    expect(backupAt(t, e4, "white")!.objective).toBeNull();

    // The user can adopt it as their own — that is a change, stamp and all,
    // even though the NAG list is already what they want.
    expect(t.setAssessment(e4, 2, "human-live", 7)).toBe(true);
    expect(t.get(e4)!.assessedBy).toBe("human-live");
    expect(backupAt(t, e4, "white")!.objective).toBe(2);
  });

  it("drops the stamp when the annotation bar rewrites the symbol", () => {
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    t.setAssessment(e4, 2, "human-live", 7);
    // A NAG edit that leaves the assessment alone keeps the stamp.
    t.setNags(e4, [1, 16]);
    expect(t.get(e4)!.assessedBy).toBe("human-live");
    // Changing the assessment through a path that cannot say who judged it
    // must not leave the old stamp vouching for the new symbol.
    t.setNags(e4, [1, 14]);
    expect(t.get(e4)!.assessedBy).toBeUndefined();
    expect(t.get(e4)!.assessedAt).toBeUndefined();
    expect(backupAt(t, e4, "white")!.objective).toBeNull();
  });

  it("never counts a book move as one of the user's candidates", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    t.goTo(t.rootId);
    const d4 = t.addMoveUciFromDatabase("d2d4")!; // clicked in the explorer
    assess(t, e4, 0);
    assess(t, d4, 3);

    expect(t.get(d4)!.src).toBe("database");
    const v = backupAt(t, t.rootId, "white")!;
    // The user judged it, so it still feeds the backup…
    expect(v.objective).toBe(3);
    // …but "my candidates" means the moves they found themselves.
    expect(v.named).toBe(1);
    expect(v.examined).toBe(1);
    // And with a single candidate there is no coverage story to tell — see
    // "coverage is silent when it has nothing to say" below.
    expect(coverageLabel(v)).toBe("");
  });

  it("leaves a move the user found first as their own", () => {
    const t = GameTree.create();
    const d4 = addAt(t, t.rootId, "d4");
    t.goTo(t.rootId);
    expect(t.addMoveUciFromDatabase("d2d4")).toBe(d4);
    expect(t.get(d4)!.src).toBeUndefined();
    expect(backupAt(t, t.rootId, "white")!.named).toBe(1);
  });
});

describe("notebook — minimax backup", () => {
  it("takes the brilliant move's value out of nine bad ones", () => {
    // The question that prompted the spec: you only have to find one good move.
    const t = GameTree.create();
    const sans = ["a3", "a4", "b3", "b4", "c3", "c4", "d3", "d4", "e3", "e4"];
    const ids = sans.map((san) => addAt(t, t.rootId, san));
    for (const id of ids) assess(t, id, -2);
    assess(t, ids[9], 3);

    const v = backupTree(t, "white").get(t.rootId)!;
    expect(v.objective).toBe(3);
    expect(v.examined).toBe(10);
    expect(v.named).toBe(10);
    // The other nine contribute nothing at all — averaging would destroy
    // exactly the information that matters.
    expect(v.range).toEqual({ lo: 3, hi: 3 });
  });

  it("maxes at the user's nodes and mins at the opponent's", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const e5 = addAt(t, e4, "e5");
    const c5 = addAt(t, e4, "c5");
    assess(t, e5, 1);
    assess(t, c5, -1);

    const values = backupTree(t, "white");
    // Black to move after 1.e4 → min.
    expect(values.get(e4)!.objective).toBe(-1);
    // White to move at the root → max, over a single child here.
    expect(values.get(t.rootId)!.objective).toBe(-1);
  });

  it("lets children override the node's own assessment", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    assess(t, e4, 2);
    const e5 = addAt(t, e4, "e5");
    assess(t, e5, -1);
    expect(backupTree(t, "white").get(e4)!.objective).toBe(-1);
  });

  it("propagates a deep judgement up an unassessed line", () => {
    const t = GameTree.create();
    let id = t.rootId;
    for (const san of ["e4", "e5", "Nf3", "Nc6", "Bb5"]) id = addAt(t, id, san);
    assess(t, id, 1);
    const values = backupTree(t, "white");
    expect(values.get(t.rootId)!.objective).toBe(1);
    expect(values.get(t.rootId)!.allCandidatesExamined).toBe(true);
  });
});

describe("notebook — the decay property, in both directions", () => {
  it("lowers a line's value when one more losing opponent reply is examined", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const e5 = addAt(t, e4, "e5");
    assess(t, e5, 2);
    expect(backupAt(t, e4, "white")!.objective).toBe(2);

    const c5 = addAt(t, e4, "c5");
    assess(t, c5, -1);
    expect(backupAt(t, e4, "white")!.objective).toBe(-1);
  });

  it("raises the value when one more good move for the user is examined", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    assess(t, e4, 0);
    expect(backupAt(t, t.rootId, "white")!.objective).toBe(0);

    const d4 = addAt(t, t.rootId, "d4");
    assess(t, d4, 2);
    expect(backupAt(t, t.rootId, "white")!.objective).toBe(2);
  });

  it("counts an unassessed child as nothing, never as equal", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const e5 = addAt(t, e4, "e5");
    assess(t, e5, 2);
    addAt(t, e4, "c5"); // explored, not yet judged

    const v = backupAt(t, e4, "white")!;
    // A min against a phantom 0 would read -0; the unjudged reply contributes
    // to coverage only.
    expect(v.objective).toBe(2);
    expect(v.examined).toBe(1);
    expect(v.named).toBe(2);
    expect(v.allCandidatesExamined).toBe(false);
  });
});

describe("notebook — coverage and the vision-bounded range", () => {
  it("counts examined against the candidates the user named", () => {
    const t = GameTree.create();
    const sans = ["a3", "b3", "c3", "d3", "e3", "f3"];
    const ids = sans.map((san) => addAt(t, t.rootId, san));
    assess(t, ids[0], 1);
    assess(t, ids[1], 0);

    const v = backupAt(t, t.rootId, "white")!;
    expect(v.named).toBe(6);
    expect(v.examined).toBe(2);
    expect(coverageLabel(v)).toBe("2 of my 6 candidates");
    expect(coverageChip(v)).toBe("2/6");
  });

  it("says nothing at all when the user named no candidates", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    assess(t, e4, 1);
    const v = backupAt(t, e4, "white")!;
    expect(v.named).toBe(0);
    expect(coverageLabel(v)).toBe("");
    expect(coverageChip(v)).toBe("");
  });

  it("opens the ceiling at the user's nodes while candidates are unexamined", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    assess(t, e4, 0);
    addAt(t, t.rootId, "d4"); // named, not examined

    const v = backupAt(t, t.rootId, "white")!;
    expect(v.objective).toBe(0); // a floor
    expect(v.range).toEqual({ lo: 0, hi: 3 });
    expect(formatValue(v)).toBe("= … +−");
  });

  it("opens the floor at opponent nodes while replies are unexamined", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const e5 = addAt(t, e4, "e5");
    assess(t, e5, 2);
    addAt(t, e4, "c5");

    const v = backupAt(t, e4, "white")!;
    expect(v.objective).toBe(2); // a ceiling
    expect(v.range).toEqual({ lo: -3, hi: 2 });
  });

  it("does not read as settled when candidates are named but none judged", () => {
    // 0 of 3 must never look MORE certain than 1 of 3 does.
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    assess(t, e4, 0);
    for (const san of ["e5", "c5", "e6"]) addAt(t, e4, san);

    const v = backupAt(t, e4, "white")!;
    expect(v.named).toBe(3);
    expect(v.examined).toBe(0);
    // Black to move, three replies unlooked-at: the floor is wide open.
    expect(v.range).toEqual({ lo: -3, hi: 0 });
    expect(formatValue(v)).toBe("−+ … =");
  });

  it("keeps the user's own judgement in the bound when a child disagrees", () => {
    // Two independent human readings of the same node. Deleting one of them
    // would make examining one of MY OWN moves lower the value — and would
    // print a point value the search does not support.
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const e5 = addAt(t, e4, "e5");
    const nf3 = addAt(t, e5, "Nf3");
    assess(t, e5, 0); // "the position after 1.e4 e5 is equal"
    assess(t, nf3, -2); // "…but the only move I looked at is bad for me"

    const v = backupAt(t, e5, "white")!;
    expect(v.objective).toBe(-2); // strict minimax over the children
    expect(v.range).toEqual({ lo: -2, hi: 0 }); // the disagreement, surfaced
    expect(formatValue(v)).toBe("∓ … =");
  });

  it("collapses the range to a point once every named candidate is examined", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const d4 = addAt(t, t.rootId, "d4");
    assess(t, e4, 1);
    assess(t, d4, 0);

    const v = backupAt(t, t.rootId, "white")!;
    expect(v.range).toEqual({ lo: 1, hi: 1 });
    expect(v.allCandidatesExamined).toBe(true);
    expect(formatValue(v)).toBe("⩲");
    expect(coverageLabel(v)).toBe("all candidates examined");
  });
});

describe("notebook — practical chances", () => {
  it("normalises likelihood across the replies actually assessed", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const e5 = addAt(t, e4, "e5");
    const c5 = addAt(t, e4, "c5");
    assess(t, e5, 0);
    assess(t, c5, 2);
    t.setLikelihood(e5, 1); // unlikely
    t.setLikelihood(c5, 3); // likely
    // An unjudged third reply must not dilute the normalisation.
    addAt(t, e4, "e6");

    const v = backupAt(t, e4, "white")!;
    expect(v.objective).toBe(0);
    expect(v.practical).toBeCloseTo((1 * 0 + 3 * 2) / 4, 10);
  });

  it("defaults an unbucketed reply to 'possible'", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const e5 = addAt(t, e4, "e5");
    const c5 = addAt(t, e4, "c5");
    assess(t, e5, 0);
    assess(t, c5, 2);
    expect(backupAt(t, e4, "white")!.practical).toBeCloseTo(1, 10);
  });

  it("lets a likely error five plies down raise an ancestor's practical value", () => {
    // Same objective value in both branches; only the opponent model differs.
    const build = (likelyError: boolean): number => {
      const t = GameTree.create();
      let id = t.rootId;
      for (const san of ["e4", "e5", "Nf3", "Nc6"]) id = addAt(t, id, san);
      // White to move at ply 4; the user picks Bb5, and the opponent then has
      // two replies five plies deep.
      const bb5 = addAt(t, id, "Bb5");
      const a6 = addAt(t, bb5, "a6");
      const f6 = addAt(t, bb5, "f6"); // the error
      assess(t, a6, 0);
      assess(t, f6, 3);
      t.setLikelihood(a6, likelyError ? 1 : 3);
      t.setLikelihood(f6, likelyError ? 3 : 1);
      const v = backupAt(t, t.rootId, "white")!;
      expect(v.objective).toBe(0); // unchanged by the opponent model
      return v.practical!;
    };
    expect(build(true)).toBeGreaterThan(build(false));
  });

  it("never carries up chances from a move the user would not play", () => {
    // At my own node the choice is mine, so the practical value has to come
    // from a line I would actually choose. Borrowing it from a losing
    // alternative is hope-chess arriving through the back door.
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const e5 = addAt(t, e4, "e5");
    const nf3 = addAt(t, e5, "Nf3");
    assess(t, nf3, 0);
    // A move I would never play, whose only virtue is that he might go wrong.
    const na3 = addAt(t, e5, "Na3");
    const d5 = addAt(t, na3, "d5");
    const h6 = addAt(t, na3, "h6");
    assess(t, d5, -3);
    assess(t, h6, 3);
    t.setLikelihood(d5, 1); // the refutation, unlikely
    t.setLikelihood(h6, 3); // the slip, likely

    const values = backupTree(t, "white");
    expect(values.get(na3)!.practical).toBeCloseTo(1.5, 10);
    const v = values.get(e5)!;
    expect(v.objective).toBe(0); // I play Nf3
    expect(v.practical).toBe(0); // …so Na3's chances are not mine to bank
  });

  it("breaks the user's own tie in THEIR favour when they are Black", () => {
    // The practical axis is White-positive like everything else, so a Black
    // user picks the LOWEST of it among their objectively-tied moves. Taking
    // the max unconditionally inverted the tie-break for Black only — the user
    // was handed the line their opponent was least likely to go wrong in.
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4"); // my decision node: Black to move
    const e5 = addAt(t, e4, "e5");
    const nf3 = addAt(t, e5, "Nf3"); // my node again, deeper
    const nc6 = addAt(t, nf3, "Nc6");
    const nf6 = addAt(t, nf3, "Nf6");
    for (const [parent, refutation, slip] of [
      [nc6, "Bb5", "Bc4"],
      [nf6, "Nxe5", "Bc4"],
    ] as const) {
      const r = addAt(t, parent, refutation);
      const s = addAt(t, parent, slip);
      assess(t, r, -2); // good for White, i.e. bad for me
      assess(t, s, 0);
      // He is likelier to find the refutation after 2…Nf6 than after 2…Nc6.
      t.setLikelihood(r, parent === nf6 ? 3 : 1);
      t.setLikelihood(s, parent === nf6 ? 1 : 3);
    }
    const c5 = addAt(t, e4, "c5");
    const c5nf3 = addAt(t, c5, "Nf3");
    const c5d4 = addAt(t, c5, "d4");
    assess(t, c5nf3, -1);
    assess(t, c5d4, 0);
    t.setLikelihood(c5nf3, 3);
    t.setLikelihood(c5d4, 1);

    const values = backupTree(t, "black");
    expect(values.get(nc6)!.practical).toBeCloseTo(-0.5, 10);
    expect(values.get(nf6)!.practical).toBeCloseTo(-1.5, 10);
    // My node: I take the line that is best for ME, which is the lower number.
    expect(values.get(nf3)!.practical).toBeCloseTo(-1.5, 10);
    // All three tie objectively at "=", so the practical key decides.
    expect(values.get(e5)!.objective).toBe(0);
    expect(values.get(c5)!.objective).toBe(0);
    expect(sortedChildren(t, values, e4)).toEqual([e5, c5]);
  });

  it("takes the user's own best line rather than averaging it", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const d4 = addAt(t, t.rootId, "d4");
    assess(t, e4, 1);
    assess(t, d4, 1);
    t.setLikelihood(e4, 1);
    // Likelihood on the user's own moves is meaningless — they choose.
    expect(backupAt(t, t.rootId, "white")!.practical).toBe(1);
  });
});

describe("notebook — lexicographic ordering", () => {
  it("never promotes an objectively worse move, whatever its likelihood", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const e5 = addAt(t, e4, "e5");
    assess(t, e5, 0); // 1.e4 is worth "="

    const d4 = addAt(t, t.rootId, "d4");
    const d5 = addAt(t, d4, "d5");
    const nf6 = addAt(t, d4, "Nf6");
    assess(t, d5, -1); // the refutation → 1.d4 is worth "⩱"
    assess(t, nf6, 3);
    t.setLikelihood(d5, 1); // …and he probably won't find it
    t.setLikelihood(nf6, 3);

    const values = backupTree(t, "white");
    expect(values.get(d4)!.practical!).toBeGreaterThan(values.get(e4)!.practical!);
    // Hope-chess is structurally impossible: the clean "=" still sorts first.
    expect(sortedChildren(t, values, t.rootId)).toEqual([e4, d4]);
  });

  it("uses practical chances only to break an objective tie", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const d4 = addAt(t, t.rootId, "d4");
    for (const [parent, good, bad] of [
      [e4, "e5", "c5"],
      [d4, "d5", "Nf6"],
    ] as const) {
      const g = addAt(t, parent, good);
      const b = addAt(t, parent, bad);
      assess(t, g, 0);
      assess(t, b, 2);
      // The opponent is likelier to go wrong after 1.d4 in this fixture.
      t.setLikelihood(g, parent === d4 ? 1 : 3);
      t.setLikelihood(b, parent === d4 ? 3 : 1);
    }
    const values = backupTree(t, "white");
    expect(values.get(e4)!.objective).toBe(0);
    expect(values.get(d4)!.objective).toBe(0);
    expect(sortedChildren(t, values, t.rootId)).toEqual([d4, e4]);
  });

  it("sorts unjudged siblings last, keeping the order they were explored in", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const d4 = addAt(t, t.rootId, "d4");
    const c4 = addAt(t, t.rootId, "c4");
    assess(t, c4, 1);
    const values = backupTree(t, "white");
    expect(sortedChildren(t, values, t.rootId)).toEqual([c4, e4, d4]);
  });

  it("flips direction at opponent nodes", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const e5 = addAt(t, e4, "e5");
    const c5 = addAt(t, e4, "c5");
    assess(t, e5, 2);
    assess(t, c5, -1);
    const values = backupTree(t, "white");
    // Black is choosing, so the move that is worst for White sorts first.
    expect(sortedChildren(t, values, e4)).toEqual([c5, e5]);
  });

  it("compareSiblings puts unjudged last in both directions", () => {
    const judged = { objective: 0, range: null, practical: 0, examined: 0, named: 0, allCandidatesExamined: true, likelyReplies: 0 };
    expect(compareSiblings(judged, undefined, true)).toBeLessThan(0);
    expect(compareSiblings(undefined, judged, false)).toBeGreaterThan(0);
  });

  it("sorting is display-only: the stored tree is untouched", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const d4 = addAt(t, t.rootId, "d4");
    assess(t, d4, 3);
    const before = JSON.stringify(t.toJSON());
    const values = backupTree(t, "white");
    expect(sortedChildren(t, values, t.rootId)).toEqual([d4, e4]);
    expect(t.root().children).toEqual([e4, d4]);
    expect(JSON.stringify(t.toJSON())).toBe(before);
  });
});

// ---- source-level gates --------------------------------------------------
//
// These are the spec's own acceptance criteria, and they are cheaper to
// enforce than to re-argue every time someone tries to be helpful.

const REPO = process.cwd();

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "target") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|rs|md)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("notebook — the app never supplies chess the user did not", () => {
  it("does no move generation: the module cannot even reach a board", () => {
    const src = readFileSync(path.join(REPO, "packages/core/src/notebook.ts"), "utf8");
    for (const token of ["chessops", "legal", "dests", "Chess"]) {
      expect(src.includes(token), `notebook.ts must not mention "${token}"`).toBe(false);
    }
  });

  it("never reads the engine field", () => {
    const src = readFileSync(path.join(REPO, "packages/core/src/notebook.ts"), "utf8");
    expect(src.includes("eval")).toBe(false);
  });

  it('never claims "fully examined" anywhere in the product', () => {
    const offenders = [
      ...sourceFiles(path.join(REPO, "packages/core/src")),
      ...sourceFiles(path.join(REPO, "packages/ui/src")),
      ...sourceFiles(path.join(REPO, "apps/desktop/app")),
      ...sourceFiles(path.join(REPO, "apps/desktop/lib")),
      ...sourceFiles(path.join(REPO, "apps/desktop/hooks")),
    ].filter((f) => /fully\s+examined/i.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("coverage is silent when it has nothing to say (user-reported 2026-07-20)", () => {
  it("shows no coverage on the played game, where every move has one child", () => {
    const tree = GameTree.create()
    tree.addMoveSan("e4")
    tree.addMoveSan("e5")
    const nf3 = tree.addMoveSan("Nf3")!
    tree.setAssessment(nf3, 1, "human")

    const vals = backupTree(tree, "white")
    // Each played move has exactly one continuation — that is history, not a
    // candidate set, and it used to render "1/1" down the whole game.
    for (const node of tree.mainlineNodes()) {
      const v = vals.get(node.id)
      if (!v || v.named > 1) continue
      expect(coverageChip(v)).toBe("")
      expect(coverageLabel(v)).toBe("")
    }
  })

  it("still reports coverage once there is a real choice to report", () => {
    const tree = GameTree.create()
    const e4 = tree.addMoveSan("e4")!
    tree.setAssessment(e4, 0, "human")
    tree.goToStart()
    const d4 = tree.addMoveSan("d4")!
    tree.setAssessment(d4, 1, "human")
    tree.goToStart()
    tree.addMoveSan("c4")

    const v = backupTree(tree, "white").get(tree.rootId)!
    expect(v.named).toBe(3)
    expect(coverageChip(v)).toBe("2/3")
    expect(coverageLabel(v)).toBe("2 of my 3 candidates")
  })
})

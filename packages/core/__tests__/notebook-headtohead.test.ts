// Spec 226 I: branch width, the most-likely walk, and the head-to-head.
//
// The load-bearing claims here are negative ones — width changes no order, a
// preference never crosses an objective boundary, an intransitive triangle
// produces the same order whichever way round it was recorded — so most of
// these tests assert that something did NOT move.

import { describe, it, expect } from "vitest";
import { GameTree } from "@chessgui/core/game-tree";
import {
  MOST_LIKELY_MAX_PLY,
  backupTree,
  copelandScores,
  mostLikelyPath,
  sortedChildren,
  widthLabel,
  type Assessment,
} from "@chessgui/core/notebook";

// Same idiom as notebook.test.ts: trees are built by playing real moves,
// because that is the only way a candidate comes into existence.
function addAt(t: GameTree, parentId: string, san: string): string {
  t.goTo(parentId);
  const id = t.addMoveSan(san);
  expect(id, `illegal test move ${san}`).not.toBeNull();
  return id!;
}

function assess(t: GameTree, id: string, a: Assessment | null): void {
  t.setAssessment(id, a, "human", 1_700_000_000);
}

/**
 * Three sibling candidates that tie on BOTH objective keys — each answered by
 * a single reply judged "=". Everything below that needs a tie group uses it,
 * so the tie is never an accident of the fixture.
 */
function tiedTriple(): { t: GameTree; ids: [string, string, string] } {
  const t = GameTree.create();
  const ids = (["e4", "d4", "c4"] as const).map((san) => {
    const id = addAt(t, t.rootId, san);
    const reply = addAt(t, id, san === "c4" ? "e5" : "d5");
    assess(t, reply, 0);
    return id;
  }) as [string, string, string];
  return { t, ids };
}

describe("branch width — reported, never ranked on", () => {
  it("counts only the replies marked likely", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const e5 = addAt(t, e4, "e5");
    const c5 = addAt(t, e4, "c5");
    const e6 = addAt(t, e4, "e6");
    t.setLikelihood(e5, 3);
    t.setLikelihood(c5, 3);
    t.setLikelihood(e6, 1);
    // The fourth reply stays unbucketed: "possible" by default, and a default
    // is emphatically not the user calling it likely.
    addAt(t, e4, "c6");

    const v = backupTree(t, "white").get(e4)!;
    expect(v.likelyReplies).toBe(2);
    expect(widthLabel(v)).toBe("2 likely");
  });

  it("says nothing at all when the user has marked none", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    addAt(t, e4, "e5");
    const v = backupTree(t, "white").get(e4)!;
    expect(v.likelyReplies).toBe(0);
    expect(widthLabel(v)).toBe("");
  });

  it("does not move a candidate up the order, however narrow it is", () => {
    // Two candidates the user judged identically, one of them a one-reply
    // branch. Narrowness is a real practical fact and it is displayed — but
    // ranking on it would let an under-explored branch win for being
    // under-explored, so the order must not budge.
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    for (const san of ["e5", "c5", "e6"]) {
      const reply = addAt(t, e4, san);
      assess(t, reply, 0);
      t.setLikelihood(reply, 3);
    }
    const d4 = addAt(t, t.rootId, "d4");
    const d5 = addAt(t, d4, "d5");
    assess(t, d5, 0);
    t.setLikelihood(d5, 3);

    const values = backupTree(t, "white");
    expect(values.get(e4)!.likelyReplies).toBe(3);
    expect(values.get(d4)!.likelyReplies).toBe(1);
    expect(values.get(e4)!.objective).toBe(values.get(d4)!.objective);
    expect(values.get(e4)!.practical).toBe(values.get(d4)!.practical);
    expect(sortedChildren(t, values, t.rootId)).toEqual([e4, d4]);
  });
});

describe("the most-likely walk — the representative position", () => {
  // 1.d4 is the user's choice; Black's replies carry his likelihoods; after
  // 1.d4 Nf6 the user chooses again. One tree exercises both rules.
  function walkTree() {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const e5 = addAt(t, e4, "e5");
    assess(t, e5, 0);

    const d4 = addAt(t, t.rootId, "d4");
    const d5 = addAt(t, d4, "d5");
    assess(t, d5, 1);
    const nf6 = addAt(t, d4, "Nf6");
    const c4 = addAt(t, nf6, "c4");
    const nc3 = addAt(t, nf6, "Nc3");
    assess(t, c4, 1);
    assess(t, nc3, 3);
    return { t, e4, d4, d5, nf6, c4, nc3 };
  }

  it("takes his likeliest reply at his nodes and my best move at mine", () => {
    const { t, d4, d5, nf6, nc3 } = walkTree();
    // He is much likelier to answer 1.d4 with Nf6 — even though d5 is the
    // move that holds White to the smaller edge. The walk follows what he
    // will probably do, not what he ought to do.
    t.setLikelihood(d5, 1);
    t.setLikelihood(nf6, 3);

    const values = backupTree(t, "white");
    const walk = mostLikelyPath(t, values, t.rootId, "white");
    expect(walk.path).toEqual([d4, nf6, nc3]);
    expect(walk.leafId).toBe(nc3);
    expect(walk.truncated).toBe(false);
  });

  it("follows the likelihoods rather than the assessments at his nodes", () => {
    const { t, d4, d5, nf6 } = walkTree();
    t.setLikelihood(d5, 3);
    t.setLikelihood(nf6, 1);
    const walk = mostLikelyPath(t, backupTree(t, "white"), t.rootId, "white");
    // Same tree, one label changed, and the representative position moves.
    expect(walk.path).toEqual([d4, d5]);
    expect(walk.leafId).toBe(d5);
  });

  it("stops where the line runs out rather than inventing a continuation", () => {
    const { t, nc3 } = walkTree();
    const walk = mostLikelyPath(t, backupTree(t, "white"), nc3, "white");
    expect(walk.path).toEqual([]);
    expect(walk.leafId).toBe(nc3);
    expect(walk.truncated).toBe(false);
  });

  it("is bounded: the cap stops it and says so", () => {
    const { t, d4, nf6 } = walkTree();
    t.setLikelihood(nf6, 3);
    const walk = mostLikelyPath(t, backupTree(t, "white"), t.rootId, "white", 2);
    expect(walk.path).toEqual([d4, nf6]);
    expect(walk.leafId).toBe(nf6);
    expect(walk.truncated).toBe(true);
    expect(MOST_LIKELY_MAX_PLY).toBeGreaterThan(2);
  });

  it("terminates on a line longer than the cap", () => {
    // A long forced-looking sequence, walked with a deliberately tiny cap:
    // the guarantee is that it returns at all, and returns exactly the cap.
    const t = GameTree.create();
    for (const san of ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6"]) {
      expect(t.addMoveSan(san)).not.toBeNull();
    }
    const walk = mostLikelyPath(t, backupTree(t, "white"), t.rootId, "white", 3);
    expect(walk.path).toHaveLength(3);
    expect(walk.truncated).toBe(true);
  });
});

describe("head-to-head preferences — storage", () => {
  it("records the reason and the tags, and survives a round trip", () => {
    const { t, ids } = tiedTriple();
    const [e4, d4] = ids;
    const pref = t.recordPreference(d4, e4, {
      reason: "safer king, and I know the structures",
      tags: ["safer king", "fewer ways to go wrong"],
      at: 1_700_000_123,
    });
    expect(pref).not.toBeNull();
    expect(pref!.parentId).toBe(t.rootId);

    const loaded = GameTree.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
    expect(loaded.preferences).toEqual([
      {
        parentId: t.rootId,
        winnerId: d4,
        loserId: e4,
        reason: "safer king, and I know the structures",
        tags: ["safer king", "fewer ways to go wrong"],
        at: 1_700_000_123,
      },
    ]);
    expect(loaded.preferenceBetween(e4, d4)!.winnerId).toBe(d4);
  });

  it("stays out of the save entirely when nothing was compared", () => {
    const { t } = tiedTriple();
    expect(t.toJSON().preferences).toBeUndefined();
  });

  it("refuses a comparison between moves that are not siblings", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const e5 = addAt(t, e4, "e5");
    expect(t.recordPreference(e4, e5)).toBeNull();
    expect(t.recordPreference(e4, e4)).toBeNull();
    expect(t.preferences).toEqual([]);
  });

  it("replaces the earlier record when the user changes their mind", () => {
    const { t, ids } = tiedTriple();
    const [e4, d4] = ids;
    t.recordPreference(e4, d4, { reason: "first thought", at: 1 });
    t.recordPreference(d4, e4, { reason: "on reflection", at: 2 });
    expect(t.preferences).toHaveLength(1);
    expect(t.preferenceBetween(e4, d4)).toMatchObject({
      winnerId: d4,
      reason: "on reflection",
    });
    expect(t.removePreference(d4, e4)).toBe(true);
    expect(t.preferenceBetween(e4, d4)).toBeNull();
  });

  it("forgets comparisons against a candidate that was deleted", () => {
    const { t, ids } = tiedTriple();
    const [e4, d4] = ids;
    t.recordPreference(d4, e4, { at: 1 });
    t.deleteVariation(e4);
    expect(t.preferences).toEqual([]);
  });
});

describe("head-to-head preferences — Copeland ordering", () => {
  it("orders objectively-tied siblings by head-to-head wins", () => {
    const { t, ids } = tiedTriple();
    const [e4, d4, c4] = ids;
    t.recordPreference(c4, e4, { at: 1 });
    t.recordPreference(c4, d4, { at: 2 });
    t.recordPreference(d4, e4, { at: 3 });
    const values = backupTree(t, "white");
    expect(sortedChildren(t, values, t.rootId)).toEqual([c4, d4, e4]);
  });

  it("produces a stable order for an intransitive 3-cycle", () => {
    // A > B, B > C, C > A is an ordinary thing for a person to feel. Copeland
    // scores it 1-1-1 and falls through to exploration order, so the answer
    // cannot depend on which comparison was made first.
    const [e4, d4, c4] = [0, 1, 2];
    const orders: [number, number][][] = [
      [[e4, d4], [d4, c4], [c4, e4]],
      [[c4, e4], [e4, d4], [d4, c4]],
      [[d4, c4], [c4, e4], [e4, d4]],
    ];
    const results = orders.map((sequence) => {
      const { t, ids } = tiedTriple();
      sequence.forEach(([w, l], i) => t.recordPreference(ids[w], ids[l], { at: i }));
      const scores = copelandScores(t.preferencesAt(t.rootId), ids);
      expect([...scores.values()]).toEqual([1, 1, 1]);
      // Reported as indices so the three runs are comparable across trees.
      return sortedChildren(t, backupTree(t, "white"), t.rootId).map((id) => ids.indexOf(id));
    });
    expect(results[0]).toEqual([e4, d4, c4]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it("never promotes a candidate over one with a better objective value", () => {
    const t = GameTree.create();
    const e4 = addAt(t, t.rootId, "e4");
    const e5 = addAt(t, e4, "e5");
    assess(t, e5, 1); // 1.e4 backs up to "⩲"

    const d4 = addAt(t, t.rootId, "d4");
    const d5 = addAt(t, d4, "d5");
    assess(t, d5, 0); // 1.d4 only to "="

    t.recordPreference(d4, e4, { reason: "I just like these positions", at: 1 });
    const values = backupTree(t, "white");
    // The reason is recorded and readable; it simply cannot outrank chess.
    expect(t.preferenceBetween(d4, e4)!.reason).toBe("I just like these positions");
    expect(sortedChildren(t, values, t.rootId)).toEqual([e4, d4]);
  });

  it("does not disturb the objective ordering of the other siblings", () => {
    const { t, ids } = tiedTriple();
    const [e4, d4, c4] = ids;
    // Give c4 a worse value, then try to prefer it. It sinks regardless.
    const c4reply = t.get(c4)!.children[0];
    assess(t, c4reply, -2);
    t.recordPreference(c4, e4, { at: 1 });
    t.recordPreference(c4, d4, { at: 2 });
    const values = backupTree(t, "white");
    expect(sortedChildren(t, values, t.rootId)).toEqual([e4, d4, c4]);
  });

  it("leaves the stored tree alone: ordering is display only", () => {
    const { t, ids } = tiedTriple();
    const [e4, , c4] = ids;
    t.recordPreference(c4, e4, { at: 1 });
    const before = JSON.stringify(t.toJSON());
    expect(sortedChildren(t, backupTree(t, "white"), t.rootId)[0]).toBe(c4);
    expect(t.root().children).toEqual(ids);
    expect(JSON.stringify(t.toJSON())).toBe(before);
  });
});

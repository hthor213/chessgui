// Board navigation over the player's own tree (spec 226 L).

import { describe, expect, it } from "vitest";
import { GameTree } from "../src/game-tree";
import { backupTree } from "../src/notebook";
import {
  bestPeerHead,
  branchHead,
  depthPastLive,
  isAncestor,
  myContinuation,
  stepToward,
} from "../src/notebook-nav";

/**
 * live = e5. Two peers off it: Bc4 (deep, 3 plies) and d4. The user is 8 —
 * well, 3 — moves down the Bc4 line.
 */
function tree() {
  const t = GameTree.create();
  t.addMoveSan("e4");
  const live = t.addMoveSan("e5")!; // the live position
  const bc4 = t.addMoveSan("Bc4")!; // peer 1, played first
  const bc5 = t.addMoveSan("Bc5")!;
  const deep = t.addMoveSan("Qh5")!; // 3 plies into the Bc4 line
  t.goTo(live);
  const d4 = t.addMoveSan("d4")!; // peer 2
  return { t, live, bc4, bc5, deep, d4 };
}

describe("branchHead — the retreat target", () => {
  it("climbs from deep in a line to the move first played off live", () => {
    const { t, live, bc4, deep } = tree();
    expect(branchHead(t, live, deep)).toBe(bc4);
    expect(branchHead(t, live, bc4)).toBe(bc4); // already at the head
  });

  it("is null at or behind the live position", () => {
    const { t, live } = tree();
    expect(branchHead(t, live, live)).toBeNull();
    expect(branchHead(t, live, t.rootId)).toBeNull(); // behind
  });

  it("is null for a cursor not descending from live", () => {
    const { t, deep } = tree();
    // A live pointer on a node the cursor is not under.
    expect(branchHead(t, "nonexistent", deep)).toBeNull();
  });
});

describe("stepToward — one step down the walk I actually took", () => {
  it("returns the child of `from` on the path to a deeper target", () => {
    const { t, live, bc4, bc5, deep } = tree();
    // From live toward the 3-ply-deep node, the first step is the branch head.
    expect(stepToward(t, live, deep)).toBe(bc4);
    // From one node in, the next step continues down the same line.
    expect(stepToward(t, bc4, deep)).toBe(bc5);
  });
  it("is null when the target is not a strict descendant", () => {
    const { t, live, deep, d4 } = tree();
    expect(stepToward(t, deep, live)).toBeNull(); // target is behind
    expect(stepToward(t, live, live)).toBeNull(); // target is self
    expect(stepToward(t, deep, d4)).toBeNull(); // off a different branch
  });
});

describe("isAncestor", () => {
  it("is true only strictly above on the path to the root", () => {
    const { t, live, bc4, deep } = tree();
    expect(isAncestor(t, live, deep)).toBe(true);
    expect(isAncestor(t, bc4, deep)).toBe(true);
    expect(isAncestor(t, deep, live)).toBe(false); // below, not above
    expect(isAncestor(t, deep, deep)).toBe(false); // not itself
  });
});

describe("myContinuation — the fallback when no walk is being retraced", () => {
  it("is the FRESHEST child (last added), not the oldest branch", () => {
    const { t, live, d4 } = tree();
    // live's children were added Bc4-first, then d4 — d4 is the freshest, so a
    // cold re-walk from live retraces the newer branch, not the older one.
    expect(myContinuation(t, live)).toBe(d4);
  });
  it("is null at a leaf", () => {
    const { t, deep } = tree();
    expect(myContinuation(t, deep)).toBeNull();
  });
});

describe("bestPeerHead — jump to my own conclusion", () => {
  it("goes to the head of the top-ranked peer, by the player's own value", () => {
    const { t, live, bc4, d4 } = tree();
    // The peers off e5 are WHITE's moves, so the ranking maximizes White.
    t.setAssessment(d4, 2, "human"); // better for White → ranks first
    t.setAssessment(bc4, -1, "human");
    expect(bestPeerHead(t, backupTree(t, "white"), live)).toBe(d4);
  });

  it("is null when nothing has been explored past live", () => {
    const t = GameTree.create();
    t.addMoveSan("e4");
    const live = t.addMoveSan("e5")!;
    expect(bestPeerHead(t, backupTree(t, "white"), live)).toBeNull();
  });
});

describe("depthPastLive — the breadcrumb number", () => {
  it("counts plies from live to the cursor", () => {
    const { t, live, bc4, deep } = tree();
    expect(depthPastLive(t, live, bc4)).toBe(1);
    expect(depthPastLive(t, live, deep)).toBe(3);
    expect(depthPastLive(t, live, live)).toBe(0);
  });
});

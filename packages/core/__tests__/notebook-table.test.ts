// The Candidates table's sorting rules (spec 226) — the "excel" view. The
// reader sorts; the app does not. These tests hold that line, plus the two
// invariants the sort has to keep under every column.

import { describe, it, expect } from "vitest";
import { GameTree } from "@chessgui/core/game-tree";
import { backupTree, sortedChildren } from "@chessgui/core/notebook";
import {
  candidateRows,
  defaultSortDir,
  sortCandidateRows,
} from "@chessgui/core/notebook-table";
import type { CandidateSortKey } from "@chessgui/core/notebook-table";

/**
 * Four candidates of White's at the root, explored e4 → d4 → c4 → Nf3:
 *
 *   e4  ⩲, two replies of Black's judged of the three named, one marked likely
 *   d4  ⩱
 *   c4  +−, and it came out of the book rather than off the user's own list
 *   Nf3 named and never judged
 */
function tableTree(): GameTree {
  const t = GameTree.create();
  const e4 = t.addMoveSan("e4")!;
  t.goTo(t.rootId);
  const d4 = t.addMoveSan("d4")!;
  t.goTo(t.rootId);
  const c4 = t.addMoveSan("c4")!;
  t.goTo(t.rootId);
  t.addMoveSan("Nf3");

  t.setAssessment(e4, 1, "human-live", 1000);
  t.setAssessment(d4, -1, "human-live", 1000);
  t.setAssessment(c4, 3, "human-live", 1000);
  t.get(c4)!.src = "database";

  t.goTo(e4);
  const e5 = t.addMoveSan("e5")!;
  t.goTo(e4);
  const c5 = t.addMoveSan("c5")!;
  t.goTo(e4);
  t.addMoveSan("e6"); // named, never judged
  t.setAssessment(e5, 1, "human-live", 1000);
  t.setAssessment(c5, 1, "human-live", 1000);
  t.setLikelihood(e5, 3);
  t.setLikelihood(c5, 2);
  t.goTo(t.rootId);
  return t;
}

function rowsOf(t: GameTree, key: CandidateSortKey | null, dir?: "asc" | "desc") {
  const values = backupTree(t, "white");
  const rows = candidateRows(t, values, t.root().children);
  return sortCandidateRows(rows, key, dir ?? (key ? defaultSortDir(key) : "asc"), "white").map(
    (r) => r.san,
  );
}

describe("the candidates table's default order", () => {
  it("is the order it was handed, inside each group and nothing else", () => {
    const t = tableTree();
    // Exploration order in, exploration order out — no column is consulted.
    // c4 trails because it is the app's chess, not because a column ranked it:
    // the three groups are the whole of the app's opinion here.
    expect(rowsOf(t, null)).toEqual(["e4", "d4", "Nf3", "c4"]);
  });

  it("takes the existing lexicographic ranking when that is what it is given", () => {
    const t = tableTree();
    const values = backupTree(t, "white");
    const ranked = sortedChildren(t, values, t.rootId);
    const rows = sortCandidateRows(candidateRows(t, values, ranked), null, "asc", "white");
    // The ranking hands c4 (+−) in first — and it is a book move, so it still
    // may not lead a list headed "my candidates" (spec 226 C). The user's own
    // moves keep the ranking's order among themselves.
    expect(rows.map((r) => r.san)).toEqual(["e4", "d4", "Nf3", "c4"]);
    expect(ranked.map((id) => t.get(id)!.san)[0]).toBe("c4");
  });

  it("never lets a move the app supplied reach the top, under any column", () => {
    const t = tableTree();
    const keys: CandidateSortKey[] = ["move", "mine", "value", "coverage", "likelihood"];
    for (const key of keys) {
      for (const dir of ["asc", "desc"] as const) {
        const sans = rowsOf(t, key, dir);
        // c4 is +− and alphabetically first: it would lead half of these.
        expect(sans[sans.length - 1], `${key}/${dir}`).toBe("c4");
      }
    }
  });
});

describe("the reader's own sort", () => {
  it("sorts by the backed-up value, best for the reader first", () => {
    const t = tableTree();
    // c4 is the best value on the board and stays in its own group at the
    // bottom: it is a book move, and the reader's list is the user's own.
    expect(rowsOf(t, "value")).toEqual(["e4", "d4", "Nf3", "c4"]);
    expect(rowsOf(t, "value", "asc")).toEqual(["d4", "e4", "Nf3", "c4"]);
  });

  it("reads the value from the reader's side of the board", () => {
    const t = tableTree();
    const values = backupTree(t, "black");
    const rows = candidateRows(t, values, t.root().children);
    // Same White-positive numbers; a Black reader's "best first" is the other
    // end of the scale, so d4 (⩱) leads and c4 (+−) trails.
    const black = sortCandidateRows(rows, "value", "desc", "black").map((r) => r.san);
    expect(black[0]).toBe("d4");
    expect(black.indexOf("c4")).toBeGreaterThan(black.indexOf("e4"));
  });

  it("sorts by coverage and by likelihood when asked", () => {
    const t = tableTree();
    // e4 is the only move with a coverage story (2 of my 3); everything else
    // has nothing to say and sorts last in both directions.
    expect(rowsOf(t, "coverage")[0]).toBe("e4");
    expect(rowsOf(t, "coverage", "asc")[0]).toBe("e4");
    // Alphabetical is alphabetical, inside the user's own group.
    expect(rowsOf(t, "move")).toEqual(["d4", "e4", "Nf3", "c4"]);
  });

  it("has no width key at all — width is displayed, never ranked on", () => {
    // Spec 226 I is unconditional and its Done-When reads "nothing anywhere
    // sorts on that count". A click is not an exemption: width is drawn from
    // the user's own likelihood labels, so it inherits their effort, and an
    // under-explored branch would win for being under-explored. The guarantee
    // is that the key does not exist rather than that it is off by default.
    const keys: string[] = ["move", "mine", "value", "coverage", "likelihood"];
    expect(keys).not.toContain("width");
    // @ts-expect-error — "width" is not a CandidateSortKey, and this line is
    // the assertion: the type is what holds the rule.
    const bad: CandidateSortKey = "width";
    expect(bad).toBe("width");
  });

  it("keeps a move that was never judged out of the judged rows, under every column", () => {
    const t = tableTree();
    const keys: CandidateSortKey[] = ["move", "mine", "value", "coverage", "likelihood"];
    for (const key of keys) {
      for (const dir of ["asc", "desc"] as const) {
        // Nf3 is named and unexamined: it belongs on the page and never above a
        // line that has actually been looked at. (c4 trails everything: it is
        // the app's chess and sits in the last group.)
        const sans = rowsOf(t, key, dir);
        expect(sans.indexOf("Nf3"), `${key}/${dir}`).toBeGreaterThan(sans.indexOf("e4"));
        expect(sans.indexOf("Nf3"), `${key}/${dir}`).toBeGreaterThan(sans.indexOf("d4"));
      }
    }
  });

  it("breaks every tie with the order the rows arrived in", () => {
    const t = tableTree();
    // Nothing at the root has a likelihood bucket, so the whole column is null
    // and the sort must be a no-op rather than an arbitrary shuffle.
    expect(rowsOf(t, "likelihood")).toEqual(["e4", "d4", "Nf3", "c4"]);
  });

  it("never mutates the rows it was given", () => {
    const t = tableTree();
    const values = backupTree(t, "white");
    const rows = candidateRows(t, values, t.root().children);
    const before = rows.map((r) => r.san);
    sortCandidateRows(rows, "value", "desc", "white");
    expect(rows.map((r) => r.san)).toEqual(before);
  });
});

describe("the table adds no chess of its own", () => {
  it("has exactly one row per move already on the board, and no more", () => {
    const t = tableTree();
    const rows = candidateRows(t, backupTree(t, "white"), t.root().children);
    // Twenty legal first moves exist. Four are on the page, because four is
    // what the user put there.
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.san).sort()).toEqual(["Nf3", "c4", "d4", "e4"]);
  });

  it("reports the book move's source rather than counting it as a candidate", () => {
    const t = tableTree();
    const rows = candidateRows(t, backupTree(t, "white"), t.root().children);
    const c4 = rows.find((r) => r.san === "c4")!;
    expect(c4.src).toBe("database");
    // Coverage at the root still counts only the three moves the user named.
    expect(rows[0].value.objective).not.toBeNull();
    const root = backupTree(t, "white").get(t.rootId)!;
    expect(root.named).toBe(3);
  });
});

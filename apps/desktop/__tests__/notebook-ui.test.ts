// The Notebook's UI surface (spec 226): entry, display, ordering — and the
// three things it must never do (name a move the user didn't, recommend one,
// or read the engine).

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";

import { GameTree } from "@chessgui/core/game-tree";
import { backupTree, sortedChildren } from "@chessgui/core/notebook";
import { treeToPgn } from "@chessgui/core/pgn";
import { MoveTable } from "@chessgui/ui/move-table";
import {
  ASSESSMENT_KEY_CHARS,
  assessmentKeys,
  LIKELIHOOD_KEYS,
  NOTEBOOK_SHORTCUTS,
  NotebookPanel,
  isOpponentReply,
} from "@chessgui/ui/notebook-panel";

const ROOT = path.resolve(__dirname, "../../..");

/**
 * 1. e4 (1. c4) (1. d4) — three candidates the user named themselves, judged
 * so that the ranked order differs from the explored order.
 */
function candidateTree(): GameTree {
  const t = GameTree.create();
  const e4 = t.addMoveSan("e4")!;
  t.goTo(t.rootId);
  const d4 = t.addMoveSan("d4")!;
  t.goTo(t.rootId);
  const c4 = t.addMoveSan("c4")!;
  t.setAssessment(e4, 1, "human-live", 1000);
  t.setAssessment(d4, -1, "human-live", 1000);
  t.setAssessment(c4, 3, "human-live", 1000);
  t.goTo(e4);
  return t;
}

function panelHtml(t: GameTree, nodeId: string, sortByRank = false): string {
  return renderToStaticMarkup(
    createElement(NotebookPanel, {
      tree: t,
      node: t.get(nodeId)!,
      values: backupTree(t, "white"),
      myColor: "white",
      onSetAssessment: () => {},
      onSetLikelihood: () => {},
      onGoToNode: () => {},
      sortByRank,
      onToggleSort: () => {},
      active: true,
    }),
  );
}

function tableHtml(t: GameTree, sortByRank: boolean): string {
  return renderToStaticMarkup(
    createElement(MoveTable, {
      tree: t,
      currentId: t.rootId,
      onGoToNode: () => {},
      notebook: { values: backupTree(t, "white"), sortByRank },
    }),
  );
}

describe("notebook keystrokes", () => {
  it("claims no key the board shortcuts already own", () => {
    const page = readFileSync(path.join(ROOT, "apps/desktop/app/page.tsx"), "utf8");
    // Every bare `e.key === "x"` in the page's handler — the meta-modified
    // ones can't collide, since the notebook ignores modified keys.
    const claimed = new Set(
      [...page.matchAll(/e\.key === "([^"]+)"/g)].map((m) => m[1]),
    );
    for (const key of NOTEBOOK_SHORTCUTS) {
      expect(claimed.has(key), `page.tsx already owns "${key}"`).toBe(false);
    }
    // The annotation bar's manual NAG keys are the other document-level
    // listener in the board view.
    const bar = readFileSync(path.join(ROOT, "packages/ui/src/annotation-bar.tsx"), "utf8");
    for (const key of NOTEBOOK_SHORTCUTS) {
      expect(bar.includes(`e.key === "${key}"`), `annotation-bar owns "${key}"`).toBe(false);
    }
  });

  it("binds all seven assessment symbols and all three buckets", () => {
    // Keys are always 1…7; White keeps the White-positive stored order.
    expect(ASSESSMENT_KEY_CHARS).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(assessmentKeys("white").map((k) => k.value)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    // Black's 1…7 is the reader's own perspective: key 7 stores −3 (Black
    // winning), key 1 stores +3 (White winning) — high always means good for me.
    expect(assessmentKeys("black").map((k) => k.value)).toEqual([3, 2, 1, 0, -1, -2, -3]);
    expect(LIKELIHOOD_KEYS.map((k) => k.value)).toEqual([3, 2, 1]);
    expect(new Set(NOTEBOOK_SHORTCUTS).size).toBe(NOTEBOOK_SHORTCUTS.length);
  });
});

describe("notebook panel", () => {
  it("marks the assessment the user gave this node", () => {
    const t = candidateTree();
    const e4 = t.root().children[0];
    const html = panelHtml(t, e4);
    expect(html).toContain('data-testid="notebook-assess-1"');
    // Seven symbols plus the clear button.
    expect(html.match(/data-testid="notebook-assess-/g)).toHaveLength(8);
  });

  it("offers likelihood buckets on the opponent's moves only", () => {
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    const e5 = t.addMoveSan("e5")!;
    expect(isOpponentReply(t.get(e4)!, "white")).toBe(false);
    expect(isOpponentReply(t.get(e5)!, "white")).toBe(true);
    expect(panelHtml(t, e4)).not.toContain('data-testid="notebook-likelihood"');
    expect(panelHtml(t, e5)).toContain('data-testid="notebook-likelihood"');
  });

  it("counts coverage against the user's own candidates and never claims completeness", () => {
    const t = candidateTree();
    const e4 = t.root().children[0];
    t.goTo(e4);
    const e5 = t.addMoveSan("e5")!;
    t.goTo(e4);
    t.addMoveSan("c5"); // named, unjudged
    t.setAssessment(e5, 0, "human-live", 1000);
    const html = panelHtml(t, e4);
    expect(html).toContain("1 of my 2 candidates");
    expect(html).not.toMatch(/fully\s+examined/i);
  });

  it("says 'all candidates examined', never anything implying objective completeness", () => {
    const t = candidateTree();
    const html = panelHtml(t, t.rootId);
    expect(html).toContain("all candidates examined");
  });

  it("lists only the candidates the user named", () => {
    const t = candidateTree();
    const html = panelHtml(t, t.rootId);
    for (const san of ["e4", "d4", "c4"]) expect(html).toContain(san);
    // Nothing was invented: 20 legal first moves exist, three are on the page.
    expect(html.match(/data-testid="notebook-candidates"/g)).toHaveLength(1);
    expect(html).not.toContain("Nf3");
  });

  it("ranks the candidate list only when asked, and by objective value", () => {
    const t = candidateTree();
    const explored = panelHtml(t, t.rootId, false);
    const ranked = panelHtml(t, t.rootId, true);
    // Index on the row marker, not the bare SAN: a hex colour like #e8e4dd
    // contains "e4" and made this assertion match the stylesheet.
    const at = (html: string, san: string) => html.indexOf(`data-san="${san}"`);
    expect(at(explored, "e4")).toBeLessThan(at(explored, "c4"));
    expect(at(ranked, "c4")).toBeLessThan(at(ranked, "e4"));
    expect(at(ranked, "e4")).toBeLessThan(at(ranked, "d4"));
  });
});

describe("notebook display in the move table", () => {
  it("states the value ONCE on the header line, as a point and never as a range", () => {
    // The rejected pair, verbatim: a range spanning four bands beside a
    // coverage fraction that is the REASON the range is wide, with the words
    // glossing a third number. The range only ever got wide because candidates
    // were unexamined, so it restated the fraction — "that is truly confusing"
    // (user 2026-07-21). The header now reads one point, its words, and the
    // fraction that says how settled it is.
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    const e5 = t.addMoveSan("e5")!;
    t.goTo(e4);
    t.addMoveSan("c5"); // named but unjudged: Black may yet do better
    t.setAssessment(e5, 1, "human-live", 1000);
    const html = panelHtml(t, e4);
    const backed = html.match(
      /data-testid="notebook-backed-value"[^>]*>([^<]*)</,
    );
    expect(backed).not.toBeNull();
    expect(backed![1]).not.toContain("…");
    expect(backed![1].trim().length).toBeLessThanOrEqual(2); // one glyph
    // Coverage still sits beside it — spec 226 C wants it prominent — and it
    // is now the ONLY statement of how settled the value is.
    expect(html).toContain('data-testid="notebook-coverage-label"');
    expect(html).toContain("1 of my 2 candidates");
  });

  it("reorders variations without touching the tree or the PGN", () => {
    const t = candidateTree();
    const before = { json: JSON.stringify(t.toJSON()), pgn: treeToPgn(t) };
    const explored = tableHtml(t, false);
    const ranked = tableHtml(t, true);
    expect(explored.indexOf("d4")).toBeLessThan(explored.indexOf("c4"));
    expect(ranked.indexOf("c4")).toBeLessThan(ranked.indexOf("d4"));
    // Byte-identical: display order is not an edit (spec 226 F).
    expect(JSON.stringify(t.toJSON())).toBe(before.json);
    expect(treeToPgn(t)).toBe(before.pgn);
    // The played move keeps its column whatever the ranking says.
    expect(ranked).toContain("e4");
  });

  it("renders every move exactly once, in either order", () => {
    // Re-ordering decides where a branch is printed, never how many times.
    // The head of a ranked variation is siblings[0] of its parent, which is
    // also the test for "owns the variation block" — so it can very easily
    // emit its own siblings a second time, nested inside itself.
    const t = candidateTree();
    const count = (html: string, san: string) =>
      (html.match(new RegExp(`>${san}(?![a-zA-Z0-9])`, "g")) ?? []).length;
    const explored = tableHtml(t, false);
    const ranked = tableHtml(t, true);
    for (const san of ["e4", "d4", "c4"]) {
      expect(count(explored, san), `${san} in explored order`).toBe(1);
      expect(count(ranked, san), `${san} in ranked order`).toBe(1);
    }
  });

  it("stays silent on an unannotated game record", () => {
    const t = GameTree.create();
    t.addMoveSan("e4");
    t.addMoveSan("e5");
    const html = tableHtml(t, false);
    expect(html).not.toContain('data-testid="notebook-coverage"');
    expect(html).not.toContain('data-testid="notebook-value"');
  });
});

describe("the notebook UI supplies no chess of its own", () => {
  const files = [
    "packages/ui/src/notebook-panel.tsx",
    "packages/ui/src/notebook-value.tsx",
    "packages/ui/src/notebook-table.tsx",
    "packages/core/src/notebook-table.ts",
  ];

  it("never generates, counts or names a move", () => {
    for (const f of files) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      for (const token of ["chessops", "dests", "legalMoves", "Chess("]) {
        expect(src.includes(token), `${f} mentions ${token}`).toBe(false);
      }
    }
  });

  it("never reads the engine's field", () => {
    for (const f of files) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      // The engine's verdict lives on node.eval; the notebook never touches it.
      expect(/\.eval\b/.test(src), `${f} reads the engine field`).toBe(false);
    }
  });
});

// ---- Section I: width, and the head-to-head ----

const { NotebookCompare, PREFERENCE_TAGS, lineText } = await import(
  "@chessgui/ui/notebook-compare"
);

/**
 * 1. e4 (1. d4) with a reply apiece: e4 gets three answers of Black's, two of
 * them marked likely; d4 gets one. Both back up to the same value, so nothing
 * but a head-to-head can separate them.
 */
function widthTree(): GameTree {
  const t = GameTree.create();
  const e4 = t.addMoveSan("e4")!;
  const e5 = t.addMoveSan("e5")!;
  t.goTo(e4);
  const c5 = t.addMoveSan("c5")!;
  t.goTo(e4);
  const e6 = t.addMoveSan("e6")!;
  t.goTo(t.rootId);
  const d4 = t.addMoveSan("d4")!;
  const d5 = t.addMoveSan("d5")!;
  for (const id of [e5, c5, e6, d5]) t.setAssessment(id, 1, "human-live", 1000);
  t.setLikelihood(e5, 3);
  t.setLikelihood(c5, 3);
  t.setLikelihood(e6, 1);
  t.setLikelihood(d5, 3);
  t.goTo(t.rootId);
  return t;
}

function compareHtml(t: GameTree, aId: string, bId: string): string {
  return renderToStaticMarkup(
    createElement(NotebookCompare, {
      tree: t,
      values: backupTree(t, "white"),
      myColor: "white",
      aId,
      bId,
      onRecord: () => {},
      onCancel: () => {},
    }),
  );
}

describe("branch width in the candidate list", () => {
  it("reports how many replies the user marked likely, beside the confidence dots", () => {
    const t = widthTree();
    const html = panelHtml(t, t.rootId);
    expect(html).toContain('data-testid="notebook-width"');
    expect(html).toContain("2 likely"); // e4
    expect(html).toContain("1 likely"); // d4
  });

  it("never sorts on it — the narrow branch does not climb", () => {
    const t = widthTree();
    const at = (html: string, san: string) => html.indexOf(`data-san="${san}"`);
    // e4 (2 likely) and d4 (1 likely) are objectively and practically tied, so
    // with nothing else to go on the ranked order is the explored order.
    const ranked = panelHtml(t, t.rootId, true);
    expect(at(ranked, "e4")).toBeLessThan(at(ranked, "d4"));
  });

  it("says nothing at all when no reply is marked likely", () => {
    const t = candidateTree();
    expect(panelHtml(t, t.rootId)).not.toContain('data-testid="notebook-width"');
  });
});

describe("sharpness beside coverage (spec 226 E)", () => {
  it("reports how many of the named candidates reach the value", () => {
    // candidateTree's three first moves are all judged, and only c4 holds the
    // max — so the whole list is closed and the count is sayable.
    const t = candidateTree();
    const html = panelHtml(t, t.rootId);
    expect(html).toContain('data-testid="notebook-sharpness"');
    expect(html).toContain("1 of my 3 reach it");
    // Bounded by vision like every other number in the panel — the list was
    // the user's own, so never a phrasing like "only one move works".
    expect(html).toContain("as far as I could see");
  });

  it("says nothing while a named candidate is still unjudged", () => {
    const t = candidateTree();
    t.goTo(t.rootId);
    t.addMoveSan("Nf3");
    expect(panelHtml(t, t.rootId)).not.toContain('data-testid="notebook-sharpness"');
  });
});

describe("the head-to-head entry point", () => {
  it("appears only when the shell can host a comparison", () => {
    const t = widthTree();
    const values = backupTree(t, "white");
    const withOut = renderToStaticMarkup(
      createElement(NotebookPanel, {
        tree: t,
        node: t.root(),
        values,
        myColor: "white",
        onSetAssessment: () => {},
        onSetLikelihood: () => {},
        onGoToNode: () => {},
        sortByRank: false,
        onToggleSort: () => {},
        active: true,
      }),
    );
    expect(withOut).not.toContain('data-testid="notebook-compare-pick"');
    const withIt = renderToStaticMarkup(
      createElement(NotebookPanel, {
        tree: t,
        node: t.root(),
        values,
        myColor: "white",
        onSetAssessment: () => {},
        onSetLikelihood: () => {},
        onGoToNode: () => {},
        sortByRank: false,
        onToggleSort: () => {},
        onCompare: () => {},
        active: true,
      }),
    );
    // One marker per judged candidate, and NO pair proposed for them: the
    // "compare these two" button only exists once the user has picked two.
    expect(withIt.match(/data-testid="notebook-compare-pick"/g)).toHaveLength(2);
    expect(withIt).not.toContain('data-testid="notebook-compare-open"');
  });
});

describe("compare mode", () => {
  it("puts both representative positions up as full boards", () => {
    const t = widthTree();
    const [e4, d4] = t.root().children;
    const html = compareHtml(t, e4, d4);
    expect(html.match(/data-testid="compare-side"/g)).toHaveLength(2);
    // cg-board is Chessground's own root element — two real boards, not two
    // thumbnails of one.
    expect(html.match(/cg-board|data-testid="compare-line"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('data-san="e4"');
    expect(html).toContain('data-san="d4"');
  });

  it("labels each side with the move and the line walked to reach it", () => {
    const t = widthTree();
    const [e4, d4] = t.root().children;
    const html = compareHtml(t, e4, d4);
    // e5 and c5 are both "likely"; the tie keeps exploration order, so the
    // walk takes e5 — the user's own label, never a generated choice.
    expect(html).toContain("1... e5");
    expect(html).toContain("1... d5");
    expect(html).not.toContain("Nf3");
  });

  it("offers a reason and one-tap tags, and records the pair the user picked", () => {
    const t = widthTree();
    const [e4, d4] = t.root().children;
    const html = compareHtml(t, e4, d4);
    expect(html).toContain('data-testid="compare-reason"');
    for (const tag of PREFERENCE_TAGS) expect(html).toContain(tag);
    // Neither side is marked before the user says so.
    expect(html).not.toContain("✓ I&#x27;d rather have this");
  });

  it("reopens with what the user said last time, not a blank slate", () => {
    const t = widthTree();
    const [e4, d4] = t.root().children;
    t.recordPreference(d4, e4, { reason: "queenside space", tags: ["clearer plan"] });
    const html = compareHtml(t, e4, d4);
    expect(html).toContain("queenside space");
    expect(html).toContain("✓ I&#x27;d rather have this");
  });

  it("numbers a line that starts on Black's move", () => {
    const t = widthTree();
    const e4 = t.root().children[0];
    const e5 = t.get(e4)!.children[0];
    expect(lineText(t, [e5])).toBe("1... e5");
    expect(lineText(t, [e4, e5])).toBe("1. e4 e5");
  });
});

describe("compare mode supplies no chess of its own", () => {
  const src = readFileSync(path.join(ROOT, "packages/ui/src/notebook-compare.tsx"), "utf8");

  it("generates nothing and reads no engine field", () => {
    for (const token of ["chessops", "dests", "Chess("]) {
      expect(src.includes(token), `notebook-compare mentions ${token}`).toBe(false);
    }
    expect(/\.eval\b/.test(src)).toBe(false);
    // The boards take a Board prop named legalMoves; the only value it can
    // ever be handed here is the empty map declared beside it.
    expect(src.match(/legalMoves/g)).toHaveLength(1);
    expect(src).toContain("legalMoves={NO_MOVES}");
    expect(src).toContain("const NO_MOVES = new Map<Key, Key[]>()");
  });

  it("claims no completeness it cannot support", () => {
    expect(src).not.toMatch(/fully\s+examined/i);
  });
});

// ---- The Candidates table: the "excel" reading surface ----

const { NotebookTable, CANDIDATE_COLUMNS } = await import("@chessgui/ui/notebook-table");
const { FairPlayPanel } = await import("@chessgui/ui/fair-play-panel");

function candidateTableHtml(t: GameTree, nodeId: string): string {
  const values = backupTree(t, "white");
  return renderToStaticMarkup(
    createElement(NotebookTable, {
      tree: t,
      node: t.get(nodeId)!,
      values,
      myColor: "white",
      order: t.get(nodeId)!.children,
      onGoToNode: () => {},
    }),
  );
}

describe("the candidates table", () => {
  it("gives every named move one row and invents none", () => {
    const t = candidateTree();
    t.goTo(t.rootId);
    t.addMoveSan("Nf3"); // named, never judged
    const html = candidateTableHtml(t, t.rootId);
    const rows = html.match(/data-testid="notebook-table-row(-unjudged)?"/g) ?? [];
    expect(rows).toHaveLength(4);
    for (const san of ["e4", "d4", "c4", "Nf3"]) expect(html).toContain(`data-san="${san}"`);
    // Twenty first moves are legal; the table knows about the four on the board.
    expect(html).not.toContain('data-san="a3"');
  });

  it("gives a folder disclosure only to candidates with explored sub-lines", () => {
    const t = GameTree.create();
    t.addMoveSan("e4"); // a candidate with a continuation under it
    t.addMoveSan("e5"); // e4 → e5, so e4 is an openable folder
    t.goTo(t.rootId);
    t.addMoveSan("d4"); // a leaf candidate — nothing explored under it
    const html = candidateTableHtml(t, t.rootId);
    // Exactly one disclosure: e4 has a sub-line, the leaf d4 gets none.
    const toggles = html.match(/data-testid="notebook-tree-toggle"/g) ?? [];
    expect(toggles).toHaveLength(1);
    // Collapsed by default — the child move is not drawn until the reader opens
    // the folder, so the top level still reads as the plain candidate list.
    expect(html).not.toContain('data-san="e5"');
  });

  it("renders in the order it was handed — no sort of its own", () => {
    const t = candidateTree();
    const html = candidateTableHtml(t, t.rootId);
    const at = (san: string) => html.indexOf(`data-san="${san}"`);
    // c4 is the best move here and stays third, because exploration order is
    // what came in. The reader ranks; the app does not.
    expect(at("e4")).toBeLessThan(at("d4"));
    expect(at("d4")).toBeLessThan(at("c4"));
  });

  it("offers a sort control on every column and marks none of them active", () => {
    const t = candidateTree();
    const html = candidateTableHtml(t, t.rootId);
    for (const c of CANDIDATE_COLUMNS) {
      expect(html).toContain(`data-testid="notebook-table-sort-${c.key}"`);
    }
    // No arrow on first paint: nothing is sorted until the reader says so.
    expect(html).not.toContain("▼");
    expect(html).not.toContain("▲");
  });

  it("gives width no control to click — it is displayed, never ranked on", () => {
    // Spec 226 I is unconditional: width is "displayed beside coverage and
    // never ranked on", and the Done-When is "nothing anywhere sorts on that
    // count". A header the reader can click would still be the app building
    // the ordering out of their own likelihood labels, so there is no header
    // button and no key.
    const t = widthTree();
    const html = candidateTableHtml(t, t.rootId);
    expect(html).toContain('data-testid="notebook-table-width-header"');
    expect(html).not.toContain("notebook-table-sort-width");
    expect(CANDIDATE_COLUMNS.map((c) => c.key)).not.toContain("width");
    const src = readFileSync(path.join(ROOT, "packages/core/src/notebook-table.ts"), "utf8");
    expect(src).not.toMatch(/case "width"/);
  });

  it("keeps a move the app supplied out of the user's ranked list", () => {
    // A book move is on the board and carries the user's judgement, so it has
    // a row — but it is not one of "my candidates" and can never be rendered
    // as the user's own best next move (spec 226 C).
    const t = candidateTree();
    const c4 = t.root().children.find((id) => t.get(id)!.san === "c4")!;
    t.get(c4)!.src = "database";
    const values = backupTree(t, "white");
    const html = renderToStaticMarkup(
      createElement(NotebookTable, {
        tree: t,
        node: t.root(),
        values,
        myColor: "white",
        // c4 is the best move here, so the ranking hands it in FIRST — and it
        // still may not lead the list.
        order: sortedChildren(t, values, t.rootId),
        onGoToNode: () => {},
      }),
    );
    const at = (san: string) => html.indexOf(`data-san="${san}"`);
    expect(at("c4")).toBeGreaterThan(at("e4"));
    expect(at("c4")).toBeGreaterThan(at("d4"));
    expect(html).toContain('data-testid="notebook-table-group-2"');
    expect(html).toContain("not my own list");
  });

  it("marks a never-judged move as the quiet kind of row", () => {
    const t = candidateTree();
    t.goTo(t.rootId);
    t.addMoveSan("Nf3");
    const html = candidateTableHtml(t, t.rootId);
    expect(html.match(/data-testid="notebook-table-row-unjudged"/g)).toHaveLength(1);
    // And it is the last row, whatever else is on the page.
    expect(html.lastIndexOf('data-san="Nf3"')).toBeGreaterThan(html.lastIndexOf('data-san="c4"'));
  });

  it("reports coverage, width and source in the user's own handwriting", () => {
    const t = widthTree();
    const html = candidateTableHtml(t, t.rootId);
    expect(html).toContain("2 likely"); // e4's branch width
    expect(html).toContain("3/3"); // e4's coverage, as a fraction and once
    // Provenance speaks only when the app put the move there. Nothing here was
    // handed over, so the whole column stays silent rather than printing
    // "mine" down a page whose heading already says so.
    expect(html).not.toContain("From the book, not my own list");
    expect(html).not.toContain(">mine<");
  });

  it("spends no column on a fact it does not have", () => {
    // The panel is clamp(320px, 30vw, 460px). A column that only speaks on
    // some nodes is rendered only on those nodes, because a table the reader
    // has to scroll sideways cannot show a move and its coverage at once.
    const t = candidateTree();
    const html = candidateTableHtml(t, t.rootId);
    const headers = html.match(/<th\b/g) ?? [];
    expect(headers.length).toBeLessThanOrEqual(4);
    // Nothing at the root carries a likelihood bucket, and no reply is marked
    // likely, so neither column is drawn at all.
    expect(html).not.toContain("He plays it");
    expect(html).not.toContain("notebook-table-width-header");
    // Every candidate here is childless, so "Mine" would print the identical
    // glyph the value column already carries — "d4 | ⩱ | ⩱ worse".
    expect(html).not.toContain("notebook-table-sort-mine");
  });

  it("caps what it draws even when every column has something to say", () => {
    // The worst case on the screen: the user's own symbol disagrees with the
    // backed-up value, replies are bucketed, replies are marked likely, and the
    // head-to-head is on offer. Seven nowrap columns did not fit a 320px panel
    // and scrolled sideways at every real width — the illegibility complaint
    // arriving through a different door.
    const t = widthTree();
    const e4 = t.root().children[0];
    const html = renderToStaticMarkup(
      createElement(NotebookTable, {
        tree: t,
        node: t.get(e4)!,
        values: backupTree(t, "white"),
        myColor: "white",
        order: t.get(e4)!.children,
        onGoToNode: () => {},
        onCompare: () => {},
      }),
    );
    expect((html.match(/<th\b/g) ?? []).length).toBeLessThanOrEqual(6);
  });

  it("states coverage once — the fraction, not the fraction and a marker", () => {
    // The badge's "?" is true exactly when examined < named, which is exactly
    // what the Seen column says. Two drawings of one number is the value /
    // coverage restatement in miniature.
    const t = candidateTree();
    const e4 = t.root().children[0];
    t.goTo(e4);
    const e5 = t.addMoveSan("e5")!;
    t.goTo(e4);
    t.addMoveSan("c5"); // named, unjudged — e4's value is provisional
    t.setAssessment(e5, 0, "human-live", 1000);
    const html = candidateTableHtml(t, t.rootId);
    expect(html).toContain("1/2"); // the coverage story, in the Seen column
    expect(html).not.toContain("?</span>");
  });

  it("claims no completeness it cannot support, and hints at no move", () => {
    const t = widthTree();
    const html = candidateTableHtml(t, t.rootId);
    expect(html).not.toMatch(/fully\s+examined/i);
    expect(html).not.toMatch(/legal/i);
    expect(html).not.toMatch(/remain/i);
    // No recommendation vocabulary anywhere on the surface.
    expect(html).not.toMatch(/\b(best move|try |should|recommend|suggest)\b/i);
  });
});

describe("the candidates tab in the fair-play panel", () => {
  const panel = (notebook: boolean) => {
    const t = candidateTree();
    const values = backupTree(t, "white");
    return renderToStaticMarkup(
      createElement(FairPlayPanel, {
        meta: null,
        tree: t,
        currentId: t.rootId,
        onGoToNode: () => {},
        livePosition: { relation: "unknown", distance: 0, canMove: false },
        onSync: () => {},
        onBackToLive: () => {},
        onContinueLater: () => {},
        onShowList: () => {},
        onStart: () => {},
        onBack: () => {},
        onForward: () => {},
        onEnd: () => {},
        canBack: false,
        canForward: false,
        ...(notebook
          ? {
              notebookValues: values,
              currentNode: t.root(),
              onSetAssessment: () => {},
              onSetLikelihood: () => {},
            }
          : {}),
      }),
    );
  };

  it("appears beside Moves and Openings only when the notebook is on", () => {
    expect(panel(true)).toContain('data-testid="fair-play-tab-candidates"');
    expect(panel(false)).not.toContain('data-testid="fair-play-tab-candidates"');
  });

  it("takes no space from the board — it is a tab, not a pane or an overlay", () => {
    const src = readFileSync(path.join(ROOT, "packages/ui/src/notebook-table.tsx"), "utf8");
    // Nothing may render over the board (user-rejected twice, 2026-07-20).
    for (const token of ["fixed", "absolute", "z-50", "Board"]) {
      expect(src.includes(token), `notebook-table uses ${token}`).toBe(false);
    }
  });
});

describe("the notebook's 13px floor", () => {
  // The panel is read at a glance mid-think, next to a board, and anything
  // smaller was reported unreadable (user 2026-07-21). It kept regressing one
  // row at a time — each new label copied the size of the one above it — so the
  // floor is asserted over the source rather than over one rendered fixture.
  const files = [
    "notebook-panel",
    "notebook-compare",
    "notebook-review",
    "notebook-value",
    "notebook-table",
    // The panel that hosts all of the above, including the status line that
    // was moved off the board and had to stay readable where it landed.
    "fair-play-panel",
    // The Moves tab and the variations it renders through renderLine — the
    // body of the very panel the strip sits on top of, and the default tab.
    // It was outside the list, which is exactly how the regression the guard
    // exists to prevent survived in the place the reader looks at most.
    "move-table",
    "move-list",
  ];

  it.each(files)("%s.tsx uses no text size below 13px", (name) => {
    const src = readFileSync(path.join(ROOT, `packages/ui/src/${name}.tsx`), "utf8");
    // Tailwind's named scale below `text-sm`, plus any arbitrary px value the
    // regex can read. text-sm is 14px and text-base 16px, so both are fine.
    const tooSmall = [
      ...src.matchAll(/text-\[(\d+)px\]/g),
    ].filter((m) => Number(m[1]) < 13).map((m) => m[0]);
    expect(tooSmall).toEqual([]);
    expect(src).not.toMatch(/\btext-xs\b/);
    expect(src).not.toMatch(/\btext-\[[\d.]+rem\]/);
  });
});

// ---- the table ends at the live position (user 2026-07-21) ---------------
//
// "would it not be more natural to say (exploring) ... that's just what I
// tried first, not what I think is best ... these are all variations".
// Past the live node nothing was played, so a mainline there is only typing
// order — and privileging one branch also makes re-ranking a structural event
// instead of a reorder.

describe("no mainline past the live position", () => {
  /** Real game: 1. e4 e5. Then, from e5, three things the user tried. */
  function liveTree() {
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    const e5 = t.addMoveSan("e5")!;
    const nf3 = t.addMoveSan("Nf3")!; // tried first
    t.goTo(e5);
    const bc4 = t.addMoveSan("Bc4")!;
    t.goTo(e5);
    const d4 = t.addMoveSan("d4")!;
    t.setAssessment(nf3, 0, "human-live");
    t.setAssessment(bc4, 1, "human-live"); // the best of the three
    t.setAssessment(d4, -1, "human-live");
    return { t, e4, e5, nf3, bc4, d4 };
  }

  function html(t: GameTree, live: string, sortByRank = false) {
    return renderToStaticMarkup(
      createElement(MoveTable, {
        tree: t,
        currentId: t.rootId,
        onGoToNode: () => {},
        liveNodeId: live,
        notebook: { values: backupTree(t, "white"), sortByRank },
      }),
    );
  }

  it("stops the played rows at the live move", () => {
    const { t, e5 } = liveTree();
    const h = html(t, e5);
    // e4 and e5 were played; Nf3 was not, so it must not hold a game cell.
    expect(h).toContain("e4");
    expect(h).toContain("e5");
    expect(h.match(/data-testid="move-cell"/g) ?? []).toHaveLength(2);
  });

  it("renders every branch out of the live position as a peer", () => {
    const { t, e5 } = liveTree();
    const h = html(t, e5);
    const peers = [...h.matchAll(/data-testid="exploring-peer" data-san="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(peers.sort()).toEqual(["Bc4", "Nf3", "d4"]);
    // None of them is subordinate: no parenthesised block wrapping a peer.
    expect(h).toContain("exploring-divider");
  });

  it("reorders the peers when the ranking asks, with no structural change", () => {
    const { t, e5 } = liveTree();
    const explored = [...html(t, e5, false).matchAll(/exploring-peer" data-san="([^"]+)"/g)].map((m) => m[1]);
    const ranked = [...html(t, e5, true).matchAll(/exploring-peer" data-san="([^"]+)"/g)].map((m) => m[1]);
    expect(explored).toEqual(["Nf3", "Bc4", "d4"]); // the order they were tried
    expect(ranked[0]).toBe("Bc4"); // best-judged first
    // Same set, same shape — a re-rank is a reorder, not a promotion.
    expect([...ranked].sort()).toEqual([...explored].sort());
  });

  it("shows no divider when nothing has been explored past live", () => {
    const t = GameTree.create();
    t.addMoveSan("e4");
    const e5 = t.addMoveSan("e5")!;
    expect(html(t, e5)).not.toContain("exploring-divider");
  });
});

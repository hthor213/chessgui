// The Notebook's UI surface (spec 226): entry, display, ordering — and the
// three things it must never do (name a move the user didn't, recommend one,
// or read the engine).

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";

import { GameTree } from "@chessgui/core/game-tree";
import { backupTree } from "@chessgui/core/notebook";
import { treeToPgn } from "@chessgui/core/pgn";
import { MoveTable } from "@chessgui/ui/move-table";
import {
  ASSESSMENT_KEYS,
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
    expect(ASSESSMENT_KEYS.map((k) => k.value)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
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
  it("shows a range, not a point, while candidates are unexamined", () => {
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    const e5 = t.addMoveSan("e5")!;
    t.goTo(e4);
    t.addMoveSan("c5"); // named but unjudged: Black may yet do better
    t.setAssessment(e5, 1, "human-live", 1000);
    const html = panelHtml(t, e4);
    expect(html).toContain("…"); // "⩲ … −+", bounded by vision, not by chess
    const settled = panelHtml(candidateTree(), t.rootId);
    expect(settled).not.toContain("…");
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

describe("the notebook's 13px floor", () => {
  // The panel is read at a glance mid-think, next to a board, and anything
  // smaller was reported unreadable (user 2026-07-21). It kept regressing one
  // row at a time — each new label copied the size of the one above it — so the
  // floor is asserted over the source rather than over one rendered fixture.
  const files = ["notebook-panel", "notebook-compare", "notebook-review", "notebook-value"];

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

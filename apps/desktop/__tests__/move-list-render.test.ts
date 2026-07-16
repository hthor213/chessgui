import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GameTree } from "@chessgui/core/game-tree";
import { MoveList } from "@chessgui/ui/move-list";
import { AdvantageSparkline } from "@chessgui/ui/advantage-sparkline";

// 1. e4 e5 (1... c5) 2. Nf3 with evals on the mainline moves only.
function annotatedTree(): GameTree {
  const t = GameTree.create();
  const e4 = t.addMoveSan("e4")!;
  const e5 = t.addMoveSan("e5")!;
  t.addMoveSan("Nf3");
  t.goTo(e4);
  const c5 = t.addMoveSan("c5")!; // variation of 1... e5
  t.setEval(e4, { cp: 30, depth: 12 });
  t.setEval(e5, { cp: -50, depth: 12 });
  t.setEval(c5, { cp: 90, depth: 12 }); // variation eval — must NOT badge
  return t;
}

describe("MoveList per-move eval badges (spec 202)", () => {
  it("shows a compact badge on mainline moves that have an eval", () => {
    const t = annotatedTree();
    const html = renderToStaticMarkup(
      createElement(MoveList, {
        tree: t,
        currentId: t.rootId,
        onGoToNode: () => {},
        showEvals: true,
      }),
    );
    expect(html).toContain('data-testid="move-eval-badge"');
    expect(html).toContain("+0.3"); // e4
    expect(html).toContain("-0.5"); // e5 (evals render white-perspective)
    // Nf3 has no eval and variations never badge: exactly two badges.
    expect(html.match(/move-eval-badge/g)).toHaveLength(2);
    expect(html).not.toContain("+0.9"); // the variation's eval stays off
  });

  it("shows no badges when showEvals is off (play mode / spec 219 lockout)", () => {
    const t = annotatedTree();
    const html = renderToStaticMarkup(
      createElement(MoveList, {
        tree: t,
        currentId: t.rootId,
        onGoToNode: () => {},
      }),
    );
    expect(html).not.toContain("move-eval-badge");
  });

  it("renders mate evals as #N", () => {
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    const e5 = t.addMoveSan("e5")!;
    t.setEval(e4, { mate: 5, depth: 20 });
    t.setEval(e5, { mate: -3, depth: 20 });
    const html = renderToStaticMarkup(
      createElement(MoveList, {
        tree: t,
        currentId: t.rootId,
        onGoToNode: () => {},
        showEvals: true,
      }),
    );
    expect(html).toContain("#5");
    expect(html).toContain("#-3");
  });
});

describe("AdvantageSparkline (spec 001 §3)", () => {
  it("renders the area sparkline once two mainline evals exist", () => {
    const t = annotatedTree();
    const html = renderToStaticMarkup(
      createElement(AdvantageSparkline, { tree: t }),
    );
    expect(html).toContain('data-testid="advantage-sparkline"');
    expect(html).toContain("Advantage");
    expect(html).toContain("advantage-sparkline-fill"); // gradient area fill
  });

  it("renders nothing with fewer than two evals", () => {
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    t.addMoveSan("e5");
    t.setEval(e4, { cp: 30, depth: 12 });
    const html = renderToStaticMarkup(
      createElement(AdvantageSparkline, { tree: t }),
    );
    expect(html).toBe("");
  });
});

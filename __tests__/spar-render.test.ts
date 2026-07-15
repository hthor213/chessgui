import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The board is a next/dynamic({ ssr: false }) import; stub it so the intro screen
// renders without pulling in Chessground. (The intro phase shows no board anyway.)
vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

import { SparTab } from "@/components/spar-tab";

describe("SparTab entry point renders", () => {
  it("renders the intro screen with the honest label and controls", () => {
    // Effects don't run under renderToStaticMarkup, so the book stays unloaded
    // and we see the initial intro screen — exactly the entry point.
    const html = renderToStaticMarkup(createElement(SparTab));
    expect(html).toContain("Spar vs Dad (beta)");
    expect(html).toContain('data-testid="spar-intro"');
    expect(html).toContain('data-testid="spar-start"');
    expect(html).toContain('data-testid="spar-side-either"');
    expect(html).toContain('data-testid="spar-side-white"');
    expect(html).toContain('data-testid="spar-side-black"');
    // Adjustable strength selector, defaulting to 1700 (spec 214 calibration).
    expect(html).toContain('data-testid="spar-level-1500"');
    expect(html).toContain('data-testid="spar-level-1700"');
    expect(html).toContain('data-testid="spar-level-1900"');
    // Honest strength labelling (spec 214: no unmeasured realism claims).
    expect(html).toContain("~1700");
    // Start is disabled until the book loads (an effect that hasn't run here).
    expect(html).toContain("Loading rival book");
  });
});

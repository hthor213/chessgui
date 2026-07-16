// Dedicated live opening-explorer panel (spec 200) + the explicit
// transposition claim: position search is keyed on the position (Zobrist in
// the Rust backend, EPD in the mock), not on the move order that reached it —
// asserted here at the data layer and as the rendered UI note. The Rust twin
// of the data-layer test is `transposition_matches_distinct_move_orders` in
// src-tauri/src/db.rs.

import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockDatabase } from "@/lib/database-mock";

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

import { OpeningExplorerPanel } from "@chessgui/ui/opening-explorer-panel";
import { DatabaseTab } from "@chessgui/ui/database-tab";

// After 1. d4 Nf6 2. c4 e6 3. Nc3 — reached by both move orders below.
const TARGET_FEN = "rnbqkb1r/pppp1ppp/4pn2/8/2PP4/2N5/PP2PPPP/R1BQKBNR b KQkq - 1 3";

const TWO_ORDERS = `[Event "TranspoTest"]
[White "P1"]
[Black "P2"]
[Result "1-0"]

1. d4 Nf6 2. c4 e6 3. Nc3 1-0

[Event "TranspoTest"]
[White "P3"]
[Black "P4"]
[Result "0-1"]

1. c4 Nf6 2. Nc3 e6 3. d4 0-1
`;

describe("explorer surfaces transpositions", () => {
  it("position search matches distinct move orders reaching the same position", async () => {
    const db = createMockDatabase();
    await db.importPgn({ source: "t", text: TWO_ORDERS });
    const hits = await db.searchPosition(TARGET_FEN, 100);
    const mine = hits.filter((h) => ["P1", "P3"].includes(h.white));
    expect(mine.length).toBe(2);
    // Both games sit at ply 5 with no next move — the searched position is
    // their final one, reached via different move orders.
    expect(mine.every((h) => h.ply === 5)).toBe(true);
  });

  it("the dedicated panel renders the transposition claim", () => {
    const html = renderToStaticMarkup(
      createElement(OpeningExplorerPanel, { currentFen: TARGET_FEN }),
    );
    expect(html).toContain('data-testid="explorer-panel"');
    expect(html).toContain('data-testid="explorer-transposition-note"');
    expect(html).toContain("transpositions");
    expect(html).toContain("Zobrist");
  });

  it("the Database tab's position-search panel renders the same claim", () => {
    const html = renderToStaticMarkup(
      createElement(DatabaseTab, { onLoadGame: () => {} }),
    );
    expect(html).toContain('data-testid="db-transposition-note"');
    expect(html).toContain("transpositions");
    // And the material filter (spec 200 material search) is present.
    expect(html).toContain('data-testid="db-filter-material"');
  });
});

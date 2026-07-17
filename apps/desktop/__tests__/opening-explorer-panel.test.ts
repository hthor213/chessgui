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

// Player-scoped queries (spec 225 rival filter + spec 211 opening leaks) —
// the mock twin of the Rust tests player_filtered_search_counts_only_their_games
// and player_openings_resolve_colour_and_skip_unfinished in src-tauri/src/db.rs.
const PLAYER_GAMES = `[Event "T"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 1-0

[Event "T"]
[White "Carol"]
[Black "Alice"]
[Result "0-1"]

1. c4 Nf6 2. Nc3 e6 3. d4 d5 0-1

[Event "T"]
[White "Carol"]
[Black "Dan"]
[Result "1/2-1/2"]

1. d4 Nf6 2. c4 e6 3. Nc3 d5 1/2-1/2

[Event "T"]
[White "Alice"]
[Black "Eve"]
[Result "*"]

1. e4 e5 *
`;

describe("player-scoped explorer queries (mock backend)", () => {
  it("player-filtered position search counts only their games, newest-first cap", async () => {
    const db = createMockDatabase();
    await db.importPgn({ source: "t", text: PLAYER_GAMES });
    // Unfiltered, the position is reached by other players' games too (the
    // mock seeds GM games; our fixture alone adds three).
    const all = await db.searchPosition(TARGET_FEN, 100);
    expect(all.length).toBeGreaterThanOrEqual(3);

    const hits = await db.searchPositionForPlayer(TARGET_FEN, "Alice", 2000);
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.white === "Alice" || h.black === "Alice")).toBe(true);
    expect(hits.every((h) => h.next_uci != null)).toBe(true);

    // The candidate cap keeps the MOST RECENT games: Alice's newest game is
    // the unfinished one vs Eve, which never reaches the target position.
    const one = await db.searchPositionForPlayer(TARGET_FEN, "Alice", 1);
    expect(one.length).toBe(0);
    const two = await db.searchPositionForPlayer(TARGET_FEN, "Alice", 2);
    expect(two.length).toBe(1);
    expect(two[0].black).toBe("Alice");

    expect(await db.searchPositionForPlayer(TARGET_FEN, "Nobody", 2000)).toEqual([]);
  });

  it("playerOpenings resolves colour/opponent and skips unfinished games", async () => {
    const db = createMockDatabase();
    await db.importPgn({ source: "t", text: PLAYER_GAMES });
    const rows = await db.playerOpenings("Alice", 2000);
    expect(rows.length).toBe(2); // the "*" game is never counted
    expect(rows[0]).toMatchObject({ color: "black", opponent: "Carol", result: "0-1" });
    expect(rows[1]).toMatchObject({ color: "white", opponent: "Bob", result: "1-0" });
  });

  it("listPlayers suggests by prefix and never dumps the roster", async () => {
    const db = createMockDatabase();
    await db.importPgn({ source: "t", text: PLAYER_GAMES });
    expect(await db.listPlayers("Al", 10)).toEqual(["Alice"]);
    // Prefix match reaches the seeded GM roster too — but stays a prefix
    // match, sorted, and deduped.
    const c = await db.listPlayers("Car", 10);
    expect(c).toContain("Carol");
    expect(c.every((n) => n.startsWith("Car"))).toBe(true);
    expect(c).toEqual([...c].sort());
    expect(await db.listPlayers("", 10)).toEqual([]);
  });

  it("the panel renders the player filter and, unfiltered, no leaks section", () => {
    const html = renderToStaticMarkup(
      createElement(OpeningExplorerPanel, { currentFen: TARGET_FEN }),
    );
    expect(html).toContain('data-testid="explorer-player-filter"');
    expect(html).toContain("Opening explorer"); // unfiltered title
    expect(html).not.toContain('data-testid="explorer-leaks-run"');
  });
});

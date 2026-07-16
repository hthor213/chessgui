import { describe, it, expect } from "vitest";
import { createMockDatabase } from "@/lib/database-mock";
import { parsePgnToTrees } from "@chessgui/core/pgn";
import { GameTree } from "@chessgui/core/game-tree";

// Derive a position FEN the same way the app does (chessops via GameTree), so
// the mock's stored FENs and the search key share the exact ep/castling
// convention — the search matches on the board part regardless.
function fenAfter(sanMovetext: string, ply: number): string {
  const tree: GameTree = parsePgnToTrees(`${sanMovetext} *`)[0];
  let node = tree.root();
  for (let i = 0; i < ply; i++) {
    const childId = node.children[0];
    expect(childId, `move ${i + 1} of "${sanMovetext}" must be legal`).toBeTruthy();
    node = tree.get(childId)!;
  }
  return node.fen;
}

describe("database mock", () => {
  it("seeds a corpus with indexed positions", async () => {
    const db = createMockDatabase();
    const s = await db.stats();
    expect(s.games).toBe(18);
    expect(s.positions).toBeGreaterThan(s.games); // each game indexes several plies
  });

  it("all seed games parsed with a full mainline (no illegal SANs)", async () => {
    const db = createMockDatabase();
    const rows = await db.listGames({}, 100, 0);
    expect(rows).toHaveLength(18);
    // Every seed line is >= 6 plies; a truncated (illegal) SAN would drop below.
    expect(rows.every((r) => r.ply_count >= 6)).toBe(true);
  });

  it("filters by player across both colours", async () => {
    const db = createMockDatabase();
    const rows = await db.listGames({ player: "Carlsen" }, 100, 0);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.white.includes("Carlsen") || r.black.includes("Carlsen"))).toBe(
      true,
    );
  });

  it("filters by ECO prefix, result, and min Elo", async () => {
    const db = createMockDatabase();
    const b = await db.listGames({ eco: "B" }, 100, 0);
    expect(b.length).toBeGreaterThan(0);
    expect(b.every((r) => r.eco.startsWith("B"))).toBe(true);

    const wins = await db.listGames({ result: "1-0" }, 100, 0);
    expect(wins.every((r) => r.result === "1-0")).toBe(true);

    const elite = await db.listGames({ min_elo: 2850 }, 100, 0);
    expect(elite.every((r) => (r.white_elo ?? 0) >= 2850 || (r.black_elo ?? 0) >= 2850)).toBe(true);
  });

  it("sorts by a whitelisted column", async () => {
    const db = createMockDatabase();
    const asc = await db.listGames({}, 100, 0, { by: "white", dir: "asc" });
    const names = asc.map((r) => r.white);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("paginates", async () => {
    const db = createMockDatabase();
    const page1 = await db.listGames({}, 5, 0);
    const page2 = await db.listGames({}, 5, 5);
    expect(page1).toHaveLength(5);
    expect(page2).toHaveLength(5);
    expect(page1.map((r) => r.id)).not.toEqual(page2.map((r) => r.id));
  });

  it("finds all games reaching a Sicilian position, with the next move", async () => {
    const db = createMockDatabase();
    const hits = await db.searchPosition(fenAfter("1. e4 c5", 2));
    // Seeds 1-4 and 17 all open 1.e4 c5.
    expect(hits.length).toBe(5);
    // Each plays 2.Nf3 next here.
    expect(hits.every((h) => h.next_san === "Nf3")).toBe(true);
  });

  it("aggregates diverging next moves at a shared position", async () => {
    const db = createMockDatabase();
    const hits = await db.searchPosition(fenAfter("1. e4 e5 2. Nf3 Nc6", 4));
    const byMove = new Map<string, number>();
    for (const h of hits) byMove.set(h.next_san ?? "-", (byMove.get(h.next_san ?? "-") ?? 0) + 1);
    // Berlin/Ruy (Bb5) x2, Italian (Bc4) x1, Scotch (d4) x1.
    expect(byMove.get("Bb5")).toBe(2);
    expect(byMove.get("Bc4")).toBe(1);
    expect(byMove.get("d4")).toBe(1);
  });

  it("matches transpositions (distinct move orders, same position)", async () => {
    const db = createMockDatabase();
    // Seeds 9 (d4 first) and 10 (c4 first) reach the same QGD position.
    const hits = await db.searchPosition(fenAfter("1. d4 Nf6 2. c4 e6 3. Nc3 d5 4. Bg5 Be7", 8));
    expect(hits.length).toBe(2);
  });

  it("dedups an exact re-import and counts it", async () => {
    const db = createMockDatabase();
    const before = (await db.stats()).games;
    const pgn = await db.getGame((await db.listGames({}, 1, 0))[0].id);
    expect(pgn).toBeTruthy();
    const rep = await db.importPgn({ source: "dup", text: pgn! });
    expect(rep.imported).toBe(0);
    expect(rep.dups_skipped).toBe(1);
    expect((await db.stats()).games).toBe(before);
  });

  it("imports a new game and deletes it", async () => {
    const db = createMockDatabase();
    const before = (await db.stats()).games;
    const rep = await db.importPgn({
      source: "new",
      text: '[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. g3 d5 2. Bg2 e5 1-0\n',
    });
    expect(rep.imported).toBe(1);
    expect((await db.stats()).games).toBe(before + 1);

    const newest = (await db.listGames({}, 1, 0))[0];
    const removed = await db.deleteGames([newest.id]);
    expect(removed).toBe(1);
    expect((await db.stats()).games).toBe(before);
  });

  it("returns loadable PGN for a game", async () => {
    const db = createMockDatabase();
    const row = (await db.listGames({}, 1, 0))[0];
    const pgn = await db.getGame(row.id);
    expect(pgn).toBeTruthy();
    // Round-trips back through the parser into a tree.
    const trees = parsePgnToTrees(pgn!);
    expect(trees).toHaveLength(1);
  });
});

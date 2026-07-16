import { describe, it, expect } from "vitest";
import { createMockDatabase } from "@/lib/database-mock";
import { parsePgnToTrees, treeToPgn } from "@chessgui/core/pgn";

// Spec 202 "save annotated game to DB": the annotated game — comments, NAGs,
// [%eval]/[%cal] tags, serialized by treeToPgn — must round-trip through
// saveGame → getGame with every annotation intact, and re-saving the same
// mainline must update the stored copy rather than duplicate it. Exercised
// against the browser mock, which mirrors the Rust backend's upsert semantics
// (src-tauri/src/db.rs save_game, covered by its own cargo tests).

/** An annotated game as the app would serialize it before saving. */
const ANNOTATED_PGN = [
  '[Event "Analysis"]',
  '[White "Me"]',
  '[Black "Rival"]',
  '[Result "*"]',
  "",
  "1. e4 { [%eval 0.25] Best by test. [%cal Ge2e4] } c5 $2 2. Nf3 $1 d6 *",
  "",
].join("\n");

describe("save annotated game to database (spec 202)", () => {
  it("round-trips comments, NAGs, and [%...] tags through save → load", async () => {
    const db = createMockDatabase();
    const before = (await db.stats()).games;

    const report = await db.saveGame({ pgn: ANNOTATED_PGN });
    expect(report.updated).toBe(false);
    expect((await db.stats()).games).toBe(before + 1);

    const stored = await db.getGame(report.id);
    expect(stored).not.toBeNull();

    // The stored PGN must carry every annotation type verbatim-in-content.
    expect(stored).toContain("[%eval 0.25]");
    expect(stored).toContain("Best by test.");
    expect(stored).toContain("[%cal Ge2e4]");
    expect(stored).toContain("$2"); // ? on 1...c5
    expect(stored).toContain("$1"); // ! on 2.Nf3

    // And parse back into a tree with the annotations on the right nodes.
    const tree = parsePgnToTrees(stored!)[0];
    const e4 = tree.get(tree.root().children[0])!;
    expect(e4.comment).toContain("Best by test.");
    expect(e4.eval?.cp).toBe(25);
    expect(e4.arrows.some((a) => a.orig === "e2" && a.dest === "e4")).toBe(true);
    const c5 = tree.get(e4.children[0])!;
    expect(c5.nags).toContain(2);
    const nf3 = tree.get(c5.children[0])!;
    expect(nf3.nags).toContain(1);
  });

  it("survives a treeToPgn re-serialization cycle (save what the app exports)", async () => {
    const db = createMockDatabase();
    // Serialize exactly as the frontend save action does: tree → treeToPgn.
    const tree = parsePgnToTrees(ANNOTATED_PGN)[0];
    const report = await db.saveGame({ pgn: treeToPgn(tree) });

    const stored = await db.getGame(report.id);
    expect(stored).toContain("[%eval 0.25]");
    expect(stored).toContain("Best by test.");
    expect(stored).toContain("[%cal Ge2e4]");
    expect(stored).toContain("$2");
  });

  it("re-saving the same mainline updates in place (no duplicate row)", async () => {
    const db = createMockDatabase();
    const first = await db.saveGame({ pgn: ANNOTATED_PGN });
    const games = (await db.stats()).games;

    // Same moves + result, annotations edited.
    const revised = ANNOTATED_PGN.replace("Best by test.", "Theory ends here.");
    const second = await db.saveGame({ pgn: revised });
    expect(second.updated).toBe(true);
    expect(second.id).toBe(first.id);
    expect((await db.stats()).games).toBe(games);

    const stored = await db.getGame(first.id);
    expect(stored).toContain("Theory ends here.");
    expect(stored).not.toContain("Best by test.");
  });

  it("a different mainline inserts a new game", async () => {
    const db = createMockDatabase();
    const a = await db.saveGame({ pgn: '[Result "*"]\n\n1. e4 e5 *\n' });
    const b = await db.saveGame({ pgn: '[Result "*"]\n\n1. d4 d5 *\n' });
    expect(a.updated).toBe(false);
    expect(b.updated).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  it("rejects PGN with no game in it", async () => {
    const db = createMockDatabase();
    await expect(db.saveGame({ pgn: "" })).rejects.toThrow();
  });
});

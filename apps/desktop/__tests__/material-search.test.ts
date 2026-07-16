// Material-signature search through the database mock (spec 200): the mock
// mirrors the Rust backend's semantics — signatures indexed along the WHOLE
// mainline, either orientation matches, unparseable queries match nothing —
// so the Database tab's filter is drivable headless.

import { describe, it, expect } from "vitest";
import { createMockDatabase } from "@/lib/database-mock";

// A distinctive Event isolates these two from the mock's seed corpus (the
// event filter is a substring match, so it must not occur in any seed name).
const SCANDI = `[Event "MatSearchTest"]
[White "A"]
[Black "B"]
[Result "*"]

1. e4 d5 2. exd5 Qxd5 *
`;

const QUIET = `[Event "MatSearchTest"]
[White "C"]
[Black "D"]
[Result "*"]

1. Nf3 Nf6 2. g3 g6 *
`;

const FULL = "KQRRBBNNPPPPPPPP";
const SEVEN = "KQRRBBNNPPPPPPP";

describe("mock database material search", () => {
  it("finds games by signatures reached mid-game, either orientation", async () => {
    const db = createMockDatabase();
    await db.importPgn({ source: "t", text: SCANDI + "\n" + QUIET });

    const list = (material: string) =>
      db.listGames({ material, event: "MatSearchTest" }, 100, 0);

    // After 2. exd5 White is a pawn up (8v7) — and the flipped query (7v8)
    // must find the same game.
    for (const q of [`${FULL} vs ${SEVEN}`, `${SEVEN} vs ${FULL}`]) {
      const rows = await list(q);
      expect(rows.map((r) => r.white)).toEqual(["A"]);
    }
    // After 2... Qxd5 the pawns are level at 7v7.
    expect((await list(`${SEVEN} vs ${SEVEN}`)).map((r) => r.white)).toEqual(["A"]);
    // The capture-free game only ever holds the start signature.
    expect((await list(`${FULL} vs ${FULL}`)).length).toBe(2);
    // Never-reached and unparseable queries match nothing.
    expect(await list("KQ vs KQ")).toEqual([]);
    expect(await list("xyz!")).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { createMockArenaApiClient } from "@/lib/arena-api-mock";
import { arenaResultBadge } from "@/lib/arena-moves";

// Spec 217 Tier 1: per-opponent W/D/L history. The mock mirrors the server's
// SQL aggregation (server/arena/app/db.py wdl_by_persona): finished games
// only, one row per persona faced, counts from the player's side. Exercised
// against the mock client because that's the same seam the history screen
// calls through (getArenaApi()), per the arena-feedback.test.ts precedent.

describe("arena per-persona W/D/L record (spec 217 Tier 1)", () => {
  it("starts empty", async () => {
    const api = createMockArenaApiClient();
    await expect(api.listPersonaRecords()).resolves.toEqual([]);
  });

  it("excludes active games", async () => {
    const api = createMockArenaApiClient();
    await api.createGame("fischer", "white");
    await expect(api.listPersonaRecords()).resolves.toEqual([]);
  });

  it("counts a resignation as a loss for the resigning player, either color", async () => {
    const api = createMockArenaApiClient();
    const asWhite = await api.createGame("fischer", "white");
    await api.resign(asWhite.id);
    const asBlack = await api.createGame("fischer", "black");
    await api.resign(asBlack.id);
    await expect(api.listPersonaRecords()).resolves.toEqual([
      { persona: "fischer", wins: 0, draws: 0, losses: 2 },
    ]);
  });

  it("aggregates per persona, sorted by slug", async () => {
    const api = createMockArenaApiClient();
    for (const persona of ["kasparov", "fischer", "kasparov"]) {
      const g = await api.createGame(persona, "white");
      await api.resign(g.id);
    }
    await expect(api.listPersonaRecords()).resolves.toEqual([
      { persona: "fischer", wins: 0, draws: 0, losses: 1 },
      { persona: "kasparov", wins: 0, draws: 0, losses: 2 },
    ]);
  });

  it("drops a deleted game from the record (deletable on request)", async () => {
    const api = createMockArenaApiClient();
    const g = await api.createGame("fischer", "white");
    await api.resign(g.id);
    await api.deleteGame(g.id);
    await expect(api.listPersonaRecords()).resolves.toEqual([]);
  });
});

// The outcome classification the mock (and the history badges) run on —
// result crossed with player_color, the exact mapping db.wdl_by_persona's
// CASE arms encode. The mock can't force a checkmate against a random
// mover, so the win/draw arms are pinned here directly.
describe("arenaResultBadge result-by-color mapping", () => {
  it.each([
    ["1-0", "white", "Win"],
    ["1-0", "black", "Loss"],
    ["0-1", "white", "Loss"],
    ["0-1", "black", "Win"],
    ["1/2-1/2", "white", "Draw"],
    ["1/2-1/2", "black", "Draw"],
  ] as const)("%s as %s -> %s", (result, color, badge) => {
    expect(arenaResultBadge("finished", result, color)).toBe(badge);
  });

  it("labels an unfinished game In progress", () => {
    expect(arenaResultBadge("active", null, "white")).toBe("In progress");
  });
});

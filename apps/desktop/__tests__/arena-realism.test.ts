import { describe, it, expect } from "vitest";
import { createMockArenaApiClient } from "@/lib/arena-api-mock";
import { ArenaApiError, type ArenaRealismVerdict } from "@chessgui/core/arena-api";

// Spec 217 Tier 2: post-game "felt like him" verdict — whole-game realism on
// the game-over panel, distinct from the per-move never-feedback
// (arena-feedback.test.ts). The mock mirrors the server's validation
// (server/arena/app/main.py game_realism): finished games only, spar verdict
// vocabulary only, one verdict per game with re-submits updating it.
// Exercised against the mock client because that's the same seam the game
// screen calls through (getArenaApi()).

describe("arena post-game realism verdict (spec 217 Tier 2)", () => {
  it("accepts a one-tap verdict on a finished game, with and without a note", async () => {
    const api = createMockArenaApiClient();
    const game = await api.createGame("fischer", "white");
    await api.resign(game.id);
    await expect(api.submitGameRealism(game.id, "felt_like")).resolves.toBeUndefined();
    await expect(
      api.submitGameRealism(game.id, "did_not_feel_like", "he attacks, this shuffled"),
    ).resolves.toBeUndefined();
  });

  it("rejects a verdict while the game is still active", async () => {
    const api = createMockArenaApiClient();
    const game = await api.createGame("fischer", "white");
    await expect(api.submitGameRealism(game.id, "felt_like")).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rejects a verdict outside the spar vocabulary", async () => {
    const api = createMockArenaApiClient();
    const game = await api.createGame("fischer", "white");
    await api.resign(game.id);
    await expect(
      api.submitGameRealism(game.id, "certain" as ArenaRealismVerdict),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an unknown game", async () => {
    const api = createMockArenaApiClient();
    await expect(api.submitGameRealism(123, "felt_like")).rejects.toThrowError(ArenaApiError);
  });
});

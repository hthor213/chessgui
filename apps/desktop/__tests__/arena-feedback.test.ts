import { describe, it, expect } from "vitest";
import { createMockArenaApiClient } from "@/lib/arena-api-mock";
import { ArenaApiError } from "@chessgui/core/arena-api";

// Spec 217 Promise 2: "I would never do this" feedback on a persona move.
// The mock mirrors the server's validation (server/arena/app/main.py
// move_feedback): the ply must exist and must be a persona move. Exercised
// against the mock client because that's the same seam the game screen
// calls through (getArenaApi()).

describe("arena move feedback (spec 217 Promise 2)", () => {
  it("accepts feedback on a persona move, with and without a note", async () => {
    const api = createMockArenaApiClient();
    // Player takes Black so the mock persona opens the game (ply 0).
    const game = await api.createGame("fischer", "black");
    const personaMove = game.moves.find((m) => m.mover === "persona");
    expect(personaMove).toBeDefined();
    await expect(api.submitMoveFeedback(game.id, personaMove!.ply)).resolves.toBeUndefined();
    await expect(
      api.submitMoveFeedback(game.id, personaMove!.ply, "he would never trade queens here"),
    ).resolves.toBeUndefined();
  });

  it("rejects a ply with no move", async () => {
    const api = createMockArenaApiClient();
    const game = await api.createGame("fischer", "black");
    await expect(api.submitMoveFeedback(game.id, 99)).rejects.toThrowError(ArenaApiError);
  });

  it("rejects the player's own move", async () => {
    const api = createMockArenaApiClient();
    const game = await api.createGame("fischer", "white");
    const after = await api.submitMove(game.id, "e2e4");
    const own = after.moves.find((m) => m.mover === "player");
    expect(own).toBeDefined();
    await expect(api.submitMoveFeedback(game.id, own!.ply)).rejects.toThrowError(
      /persona move/,
    );
  });

  it("rejects an unknown game", async () => {
    const api = createMockArenaApiClient();
    await expect(api.submitMoveFeedback(123, 0)).rejects.toThrowError(ArenaApiError);
  });
});

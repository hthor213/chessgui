import { describe, it, expect } from "vitest";
import { createMockArenaApiClient } from "@/lib/arena-api-mock";
import { arenaSharedStatusLabel } from "@/lib/arena-moves";
import type { ArenaSharedReplay } from "@chessgui/core/arena-api";

// Spec 217 Tier 2: shareable family replay links — an unguessable token for
// a finished game that opens a read-only replay WITHOUT login. The mock
// mirrors the server contract (server/arena/app/main.py share_game /
// revoke_share / shared_replay): finished games only, idempotent minting,
// and 404 for unknown, revoked, and deleted tokens alike.

describe("arena family replay links (spec 217 Tier 2)", () => {
  it("mints a token for a finished game, idempotently", async () => {
    const api = createMockArenaApiClient();
    const game = await api.createGame("fischer", "white");
    await api.submitMove(game.id, "e2e4");
    await api.resign(game.id);
    const { token } = await api.shareGame(game.id);
    expect(token).toBeTruthy();
    const again = await api.shareGame(game.id);
    expect(again.token).toBe(token);
  });

  it("refuses to share a still-active game", async () => {
    const api = createMockArenaApiClient();
    const game = await api.createGame("fischer", "white");
    await expect(api.shareGame(game.id)).rejects.toMatchObject({ status: 409 });
  });

  it("serves the replay by token — game record only, no auth-side fields", async () => {
    const api = createMockArenaApiClient();
    const game = await api.createGame("fischer", "white");
    const after = await api.submitMove(game.id, "e2e4");
    await api.resign(game.id);
    const { token } = await api.shareGame(game.id);
    const replay = await api.getSharedReplay(token);
    expect(replay.persona).toBe("fischer");
    expect(replay.playerColor).toBe("white");
    expect(replay.result).toBe("0-1"); // White (the player) resigned
    expect(replay.resultReason).toBe("player resigned");
    expect(replay.moves.map((m) => m.uci)).toEqual(after.moves.map((m) => m.uci));
  });

  it("404s an unknown token", async () => {
    const api = createMockArenaApiClient();
    await expect(api.getSharedReplay("nope")).rejects.toMatchObject({ status: 404 });
  });

  it("revoking the link kills the replay", async () => {
    const api = createMockArenaApiClient();
    const game = await api.createGame("fischer", "white");
    await api.resign(game.id);
    const { token } = await api.shareGame(game.id);
    await api.revokeShare(game.id);
    await expect(api.getSharedReplay(token)).rejects.toMatchObject({ status: 404 });
  });

  it("deleting the game kills the replay", async () => {
    const api = createMockArenaApiClient();
    const game = await api.createGame("fischer", "white");
    await api.resign(game.id);
    const { token } = await api.shareGame(game.id);
    await api.deleteGame(game.id);
    await expect(api.getSharedReplay(token)).rejects.toMatchObject({ status: 404 });
  });
});

describe("arenaSharedStatusLabel (spectator voice)", () => {
  const base: ArenaSharedReplay = {
    persona: "fischer",
    playerColor: "white",
    playerName: "Thorarinn",
    result: "1-0",
    resultReason: "checkmate",
    createdAt: "2026-07-15T12:00:00Z",
    moves: [],
  };

  it("names the winner, never 'You'", () => {
    expect(arenaSharedStatusLabel(base)).toBe("Thorarinn wins — Checkmate");
    expect(arenaSharedStatusLabel({ ...base, result: "0-1" })).toBe("fischer wins — Checkmate");
  });

  it("speaks resignation from the player's side", () => {
    expect(arenaSharedStatusLabel({ ...base, result: "0-1", resultReason: "player resigned" })).toBe(
      "Thorarinn resigned.",
    );
  });

  it("labels draws with the reason", () => {
    expect(
      arenaSharedStatusLabel({ ...base, result: "1/2-1/2", resultReason: "stalemate" }),
    ).toBe("Draw — Stalemate");
  });

  it("falls back to a neutral name when the sharer has none", () => {
    expect(arenaSharedStatusLabel({ ...base, playerName: "" })).toBe("Player wins — Checkmate");
  });
});

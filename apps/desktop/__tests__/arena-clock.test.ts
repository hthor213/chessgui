import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockArenaApiClient } from "@/lib/arena-api-mock";
import { ArenaApiError } from "@chessgui/core/arena-api";
import { arenaStatusLabel, formatClockMs, timeControlLabel } from "@/lib/arena-moves";
import type { ArenaGameState } from "@chessgui/core/arena-api";

// Spec 217 Tier 1: per-game clocks with increment. The mock mirrors the
// server (server/arena/app/main.py clock helpers + db.py clock columns):
// remaining ms per side stamped at turn start, the side to move burning
// wall-clock from there, increment applied server-side on completing a move,
// flag = loss adjudicated lazily on the next request that looks at the game.
// Exercised against the mock client because that's the same seam the game
// screen calls through (getArenaApi()), per the arena-feedback.test.ts
// precedent. Fake timers drive both setTimeout and Date.now, so the clock
// arithmetic below is exact (mock delays: create 150ms, GET 50ms, persona
// think 350ms).

const CONTROL = { initialS: 900, incrementS: 10 };

async function settled<T>(p: Promise<T>, ms: number): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("arena clocks with increment (spec 217 Tier 1)", () => {
  it("a game created without a clock has none (Tier-0 behavior unchanged)", async () => {
    const api = createMockArenaApiClient();
    const game = await api.createGame("fischer", "white");
    expect(game.clock).toBeNull();
  });

  it("a clocked game starts with full time both sides, White's clock running", async () => {
    vi.useFakeTimers();
    const api = createMockArenaApiClient();
    const game = await settled(api.createGame("fischer", "white", CONTROL), 150);
    expect(game.clock).toEqual({
      initialS: 900,
      incrementS: 10,
      whiteMs: 900_000,
      blackMs: 900_000,
      running: "white",
    });
  });

  it("increment lands on the mover; persona think time burns the persona clock", async () => {
    vi.useFakeTimers();
    const api = createMockArenaApiClient();
    const game = await settled(api.createGame("fischer", "white", CONTROL), 150);
    await vi.advanceTimersByTimeAsync(5_000); // player thinks 5s at the board
    const after = await settled(api.submitMove(game.id, "e2e4"), 350);
    // Player: 900s - 5s spent + 10s increment.
    expect(after.clock?.whiteMs).toBe(905_000);
    // Persona: 900s - 350ms mock think + 10s increment.
    expect(after.clock?.blackMs).toBe(909_650);
    expect(after.clock?.running).toBe("white");
    expect(after.status).toBe("active");
  });

  it("flag = loss: an overdue move loses on time and the move is not applied", async () => {
    vi.useFakeTimers();
    const api = createMockArenaApiClient();
    const game = await settled(api.createGame("fischer", "white", { initialS: 30, incrementS: 0 }), 150);
    await vi.advanceTimersByTimeAsync(30_001); // the whole clock, gone
    const after = await settled(api.submitMove(game.id, "e2e4"), 10);
    expect(after.status).toBe("finished");
    expect(after.result).toBe("0-1"); // player had White
    expect(after.resultReason).toBe("flag");
    expect(after.moves).toEqual([]); // the flag beat the move
    expect(after.clock?.whiteMs).toBe(0);
    expect(after.clock?.running).toBeNull();
    // The game is over — a further move is rejected like any finished game.
    // (No settled() here: the 409 is thrown before any timer is awaited, and
    // advancing timers before attaching .rejects would leave the rejection
    // momentarily unhandled.)
    await expect(api.submitMove(game.id, "e2e4")).rejects.toThrowError(ArenaApiError);
  });

  it("the flag falls on a plain GET — the game-screen zero-poll / resume path", async () => {
    vi.useFakeTimers();
    const api = createMockArenaApiClient();
    // Player takes Black: the persona (White) opens, then Black's clock runs.
    const game = await settled(api.createGame("fischer", "black", { initialS: 30, incrementS: 0 }), 500);
    expect(game.moves.length).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    const after = await settled(api.getGame(game.id), 50);
    expect(after.status).toBe("finished");
    expect(after.result).toBe("1-0"); // Black (the player) flagged
    expect(after.resultReason).toBe("flag");
  });

  it("rejects an out-of-bounds control (mirrors the server's validation)", async () => {
    const api = createMockArenaApiClient();
    await expect(api.createGame("fischer", "white", { initialS: 5, incrementS: 0 })).rejects.toThrowError(
      ArenaApiError,
    );
    await expect(
      api.createGame("fischer", "white", { initialS: 300, incrementS: -1 }),
    ).rejects.toThrowError(/clock_increment_s/);
  });
});

describe("clock display helpers", () => {
  it.each([
    [900_000, "15:00"],
    [3_661_000, "1:01:01"],
    [59_000, "0:59"],
    [10_000, "0:10"],
    [9_400, "0:09.4"],
    [0, "0:00.0"],
    [-500, "0:00.0"], // clamps — the UI floors at zero while awaiting the server
  ])("formatClockMs(%i) -> %s", (ms, text) => {
    expect(formatClockMs(ms)).toBe(text);
  });

  it.each([
    [900, 10, "15+10"],
    [600, 5, "10+5"],
    [30, 0, "30s+0"],
    [90, 2, "90s+2"],
  ])("timeControlLabel(%i, %i) -> %s", (initialS, incrementS, label) => {
    expect(timeControlLabel(initialS, incrementS)).toBe(label);
  });

  it("labels a loss on time", () => {
    const game = { status: "finished", result: "0-1", resultReason: "flag", playerColor: "white" };
    expect(arenaStatusLabel(game as ArenaGameState)).toBe("Flag fell — You lose.");
  });
});

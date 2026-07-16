import { describe, expect, it } from "vitest";
import {
  PLAY_CLOCK_PRESETS,
  UNTIMED_PRESET,
  advanceClock,
  engineGoTimes,
  flaggedSide,
  remainingMs,
  startPlayClock,
  type PlayClockState,
} from "@/lib/play-clock";

// Spec 011 local play-vs-engine clocks (000:81): pure model exercised with
// explicit `now` values — no timers needed. Enforcement is local (flag =
// loss), distinct from the server-adjudicated arena clocks (spec 217,
// arena-clock.test.ts); the FORMATTING helpers are shared with the arena
// (lib/arena-moves' formatClockMs/timeControlLabel).

const T0 = 1_000_000; // arbitrary epoch base

const rapid = PLAY_CLOCK_PRESETS.find((p) => p.id === "rapid-15+10")!;

function startedRapid(turn: "white" | "black" = "white"): PlayClockState {
  return startPlayClock(rapid, turn, T0)!;
}

describe("play clock presets", () => {
  it("untimed is first and produces no clock", () => {
    expect(UNTIMED_PRESET.id).toBe("untimed");
    expect(UNTIMED_PRESET.baseS).toBeNull();
    expect(startPlayClock(UNTIMED_PRESET, "white", T0)).toBeNull();
  });

  it("labels use the arena's chess-idiomatic time-control format", () => {
    expect(rapid.label).toBe("Rapid 15+10");
    expect(PLAY_CLOCK_PRESETS.find((p) => p.id === "blitz-3+2")!.label).toBe("Blitz 3+2");
  });
});

describe("startPlayClock", () => {
  it("both sides get the full base time, mover's clock running", () => {
    const c = startedRapid("black");
    expect(c).toEqual({
      whiteMs: 900_000,
      blackMs: 900_000,
      incMs: 10_000,
      running: "black",
      turnStartedAt: T0,
    });
  });
});

describe("remainingMs", () => {
  it("only the running side burns wall time", () => {
    const c = startedRapid("white");
    expect(remainingMs(c, "white", T0 + 5_000)).toBe(895_000);
    expect(remainingMs(c, "black", T0 + 5_000)).toBe(900_000);
  });

  it("clamps at zero once overspent", () => {
    const c = startedRapid("white");
    expect(remainingMs(c, "white", T0 + 2_000_000)).toBe(0);
  });
});

describe("advanceClock", () => {
  it("a completed move charges the mover, pays the increment, hands over", () => {
    const c = startedRapid("white");
    const after = advanceClock(c, "black", true, T0 + 5_000);
    expect(after.whiteMs).toBe(905_000); // 900 - 5 + 10 increment
    expect(after.blackMs).toBe(900_000);
    expect(after.running).toBe("black");
    expect(after.turnStartedAt).toBe(T0 + 5_000);
  });

  it("a take-back charges the thinking time but pays no increment", () => {
    const c = startedRapid("black");
    const after = advanceClock(c, "white", false, T0 + 3_000);
    expect(after.blackMs).toBe(897_000);
    expect(after.whiteMs).toBe(900_000);
    expect(after.running).toBe("white");
  });
});

describe("flaggedSide (flag = loss, adjudicated locally)", () => {
  it("null while time remains", () => {
    expect(flaggedSide(startedRapid("white"), T0 + 899_999)).toBeNull();
  });

  it("the running side flags when its time runs out — the opponent never does", () => {
    const c = startedRapid("white");
    expect(flaggedSide(c, T0 + 900_000)).toBe("white");
    expect(flaggedSide(c, T0 + 2_000_000)).toBe("white");
  });
});

describe("engineGoTimes", () => {
  const virtual = { wtime: 600_000, btime: 550_000, incMs: 5_000 };

  it("untimed keeps the spec 216 virtual pace clock, human effectively untimed", () => {
    expect(engineGoTimes(null, virtual, "white")).toEqual({
      wtime: 2147483647,
      btime: 550_000,
      winc: 5_000,
      binc: 5_000,
    });
    expect(engineGoTimes(null, virtual, "black")).toEqual({
      wtime: 600_000,
      btime: 2147483647,
      winc: 5_000,
      binc: 5_000,
    });
  });

  it("a real clock is passed through verbatim for BOTH sides", () => {
    expect(
      engineGoTimes({ wtimeMs: 123_456, btimeMs: 654_321, incMs: 10_000 }, virtual, "white"),
    ).toEqual({ wtime: 123_456, btime: 654_321, winc: 10_000, binc: 10_000 });
  });

  it("never hands the engine a zero budget — it must still produce a bestmove", () => {
    const t = engineGoTimes({ wtimeMs: 0, btimeMs: 900_000, incMs: 2_000 }, virtual, "black");
    expect(t.wtime).toBe(50);
  });
});

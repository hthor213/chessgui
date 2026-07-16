import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CUSTOM_TC,
  PLAY_CLOCK_PRESETS,
  UNTIMED_PRESET,
  advanceClock,
  customClockPreset,
  engineGoTimes,
  flaggedSide,
  isValidCustomTimeControl,
  loadCustomTimeControl,
  remainingMs,
  saveCustomTimeControl,
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

// --- Custom time control (spec 011) ---

describe("custom time control validation", () => {
  it("accepts whole minutes/seconds inside the ranges", () => {
    expect(isValidCustomTimeControl({ baseMin: 1, incS: 0 })).toBe(true);
    expect(isValidCustomTimeControl({ baseMin: 10, incS: 5 })).toBe(true);
    expect(isValidCustomTimeControl({ baseMin: 180, incS: 120 })).toBe(true);
  });

  it("rejects out-of-range values (zero base is spelled Untimed)", () => {
    expect(isValidCustomTimeControl({ baseMin: 0, incS: 5 })).toBe(false);
    expect(isValidCustomTimeControl({ baseMin: 181, incS: 0 })).toBe(false);
    expect(isValidCustomTimeControl({ baseMin: 10, incS: -1 })).toBe(false);
    expect(isValidCustomTimeControl({ baseMin: 10, incS: 121 })).toBe(false);
  });

  it("rejects non-integers and NaN (an emptied number input)", () => {
    expect(isValidCustomTimeControl({ baseMin: 2.5, incS: 0 })).toBe(false);
    expect(isValidCustomTimeControl({ baseMin: 10, incS: 1.5 })).toBe(false);
    expect(isValidCustomTimeControl({ baseMin: NaN, incS: 0 })).toBe(false);
    expect(isValidCustomTimeControl({ baseMin: 10, incS: NaN })).toBe(false);
  });
});

describe("customClockPreset", () => {
  it("converts minutes to seconds and labels like the arena presets", () => {
    const p = customClockPreset({ baseMin: 7, incS: 3 });
    expect(p).toEqual({ id: "custom", label: "Custom 7+3", baseS: 420, incS: 3 });
  });

  it("feeds the clock model like any built-in preset", () => {
    const c = startPlayClock(customClockPreset({ baseMin: 2, incS: 1 }), "white", T0)!;
    expect(c.whiteMs).toBe(120_000);
    expect(c.blackMs).toBe(120_000);
    expect(c.incMs).toBe(1_000);
  });
});

describe("custom time control persistence (storage seam)", () => {
  // Same fake-window trick as engine-settings.test.ts: the localStorage-backed
  // StorageProvider short-circuits without `window`, so give it one.
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map<string, string>();
    const localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
    (globalThis as Record<string, unknown>).window = { localStorage };
    (globalThis as Record<string, unknown>).localStorage = localStorage;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("defaults to 10+0 when nothing is stored", () => {
    expect(loadCustomTimeControl()).toEqual(DEFAULT_CUSTOM_TC);
    expect(DEFAULT_CUSTOM_TC).toEqual({ baseMin: 10, incS: 0 });
  });

  it("round-trips the last-used custom TC", () => {
    saveCustomTimeControl({ baseMin: 25, incS: 10 });
    expect(loadCustomTimeControl()).toEqual({ baseMin: 25, incS: 10 });
  });

  it("never persists an invalid TC", () => {
    saveCustomTimeControl({ baseMin: 0, incS: 5 });
    expect(store.size).toBe(0);
  });

  it("falls back to the default on garbage or out-of-range blobs", () => {
    store.set("play-custom-tc", "not json");
    expect(loadCustomTimeControl()).toEqual(DEFAULT_CUSTOM_TC);
    store.set("play-custom-tc", JSON.stringify({ baseMin: 9999, incS: 5 }));
    expect(loadCustomTimeControl()).toEqual(DEFAULT_CUSTOM_TC);
    store.set("play-custom-tc", JSON.stringify({ baseMin: "7" }));
    expect(loadCustomTimeControl()).toEqual(DEFAULT_CUSTOM_TC);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  analysisGoCommand,
  clearEnginePath,
  customOptionCommand,
  defaultEngineSettings,
  loadEnginePath,
  loadEngineSettings,
  sanitizeCustomOptions,
  saveEnginePath,
  saveEngineSettings,
} from "@/lib/engine-settings";

// loadEngineSettings/saveEngineSettings short-circuit when `window` is
// undefined, so give them a minimal window + localStorage to exercise the
// real persistence + migration path in the node test environment.
function installFakeStorage() {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  (globalThis as Record<string, unknown>).window = { localStorage };
  (globalThis as Record<string, unknown>).localStorage = localStorage;
  return store;
}

describe("engine settings — arrows default + migration (spec 202 bugfix)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installFakeStorage();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("defaults best-move arrows OFF", () => {
    expect(defaultEngineSettings().showArrows).toBe(false);
  });

  it("resets a legacy (unversioned) blob's showArrows to the new default", () => {
    // Pre-migration user who had arrows on: their stored `true` must not stick.
    store.set(
      "engine-settings",
      JSON.stringify({ hash: 512, threads: 8, multiPv: 4, showArrows: true }),
    );
    const loaded = loadEngineSettings();
    expect(loaded.showArrows).toBe(false);
    // Other settings are preserved through the migration.
    expect(loaded.hash).toBe(512);
    expect(loaded.multiPv).toBe(4);
  });

  it("honors showArrows once the blob carries the current version", () => {
    store.set(
      "engine-settings",
      JSON.stringify({ hash: 256, threads: 4, multiPv: 3, showArrows: true, version: 2 }),
    );
    expect(loadEngineSettings().showArrows).toBe(true);
  });

  it("saving stamps the version so a user's choice survives the next load", () => {
    saveEngineSettings({ ...defaultEngineSettings(), showArrows: true });
    const raw = JSON.parse(store.get("engine-settings")!);
    expect(raw.version).toBe(2);
    // Round-trips: the saved choice is now authoritative.
    expect(loadEngineSettings().showArrows).toBe(true);
  });
});

describe("board coordinates (spec 001)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installFakeStorage();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("defaults ON, including for blobs saved before the setting existed", () => {
    expect(defaultEngineSettings().showCoordinates).toBe(true);
    store.set(
      "engine-settings",
      JSON.stringify({ hash: 256, threads: 4, multiPv: 3, showArrows: false, version: 2 }),
    );
    expect(loadEngineSettings().showCoordinates).toBe(true);
  });

  it("round-trips OFF", () => {
    saveEngineSettings({ ...defaultEngineSettings(), showCoordinates: false });
    expect(loadEngineSettings().showCoordinates).toBe(false);
  });
});

describe("analysis limit + contempt + custom UCI options (spec 011)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installFakeStorage();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("defaults to infinite analysis, neutral contempt, no custom options", () => {
    const d = defaultEngineSettings();
    expect(d.analysisMode).toBe("infinite");
    expect(d.contempt).toBe(0);
    expect(d.customOptions).toEqual([]);
    expect(analysisGoCommand(d)).toBe("go infinite");
  });

  it("maps each analysis mode to its go command", () => {
    const d = defaultEngineSettings();
    expect(analysisGoCommand({ ...d, analysisMode: "depth", analysisDepth: 24 })).toBe("go depth 24");
    expect(analysisGoCommand({ ...d, analysisMode: "movetime", analysisMoveTimeMs: 5000 })).toBe(
      "go movetime 5000",
    );
  });

  it("round-trips the new fields through save/load", () => {
    saveEngineSettings({
      ...defaultEngineSettings(),
      analysisMode: "depth",
      analysisDepth: 24,
      analysisMoveTimeMs: 3000,
      contempt: -50,
      customOptions: [{ name: "Skill Level", value: "10" }],
    });
    const loaded = loadEngineSettings();
    expect(loaded.analysisMode).toBe("depth");
    expect(loaded.analysisDepth).toBe(24);
    expect(loaded.analysisMoveTimeMs).toBe(3000);
    expect(loaded.contempt).toBe(-50);
    expect(loaded.customOptions).toEqual([{ name: "Skill Level", value: "10" }]);
  });

  it("falls back to defaults for a pre-011 blob and clamps out-of-range values", () => {
    // Legacy blob: none of the new fields present.
    store.set(
      "engine-settings",
      JSON.stringify({ hash: 512, threads: 2, multiPv: 3, showArrows: false, version: 2 }),
    );
    const legacy = loadEngineSettings();
    expect(legacy.analysisMode).toBe("infinite");
    expect(legacy.contempt).toBe(0);
    expect(legacy.customOptions).toEqual([]);

    // Hostile blob: bogus mode, out-of-range numbers, malformed options list.
    store.set(
      "engine-settings",
      JSON.stringify({
        version: 2,
        analysisMode: "nodes",
        analysisDepth: 4000,
        analysisMoveTimeMs: -5,
        contempt: 900,
        customOptions: "setoption name Threads value 64",
      }),
    );
    const d = defaultEngineSettings();
    const hostile = loadEngineSettings();
    expect(hostile.analysisMode).toBe("infinite");
    expect(hostile.analysisDepth).toBe(99);
    expect(hostile.analysisMoveTimeMs).toBe(100);
    expect(hostile.contempt).toBe(100);
    expect(hostile.customOptions).toEqual([]);
    expect(hostile.hash).toBe(d.hash);
  });

  it("sanitizes custom options: drops nameless rows, strips line breaks", () => {
    expect(
      sanitizeCustomOptions([
        { name: "  Skill Level ", value: " 10 " },
        { name: "", value: "ignored" },
        { name: "Move Overhead\ngo infinite", value: "30\r\nquit" },
        "not-an-object",
        null,
      ]),
    ).toEqual([
      { name: "Skill Level", value: "10" },
      // UCI is a line protocol — an embedded newline must never survive to
      // smuggle a second command through setoption.
      { name: "Move Overhead go infinite", value: "30 quit" },
    ]);
  });

  it("builds setoption lines, omitting `value` for button options", () => {
    expect(customOptionCommand({ name: "Skill Level", value: "10" })).toBe(
      "setoption name Skill Level value 10",
    );
    expect(customOptionCommand({ name: "Clear Hash", value: "" })).toBe(
      "setoption name Clear Hash",
    );
  });
});

describe("engine path — per-session keys (spec 900 multi-engine comparison)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installFakeStorage();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("keeps the default session on the historical bare key", () => {
    saveEnginePath("/engines/stockfish");
    expect(store.get("engine-path")).toBe("/engines/stockfish");
    expect(loadEnginePath()).toBe("/engines/stockfish");
  });

  it("persists a session's pick under its own suffixed key", () => {
    saveEnginePath("/engines/stockfish");
    saveEnginePath("/engines/reckless", "compare");
    expect(store.get("engine-path:compare")).toBe("/engines/reckless");
    // The two slots never clobber each other.
    expect(loadEnginePath()).toBe("/engines/stockfish");
    expect(loadEnginePath("compare")).toBe("/engines/reckless");
  });

  it("clears only the addressed session's pick", () => {
    saveEnginePath("/engines/stockfish");
    saveEnginePath("/engines/reckless", "compare");
    clearEnginePath("compare");
    expect(store.has("engine-path:compare")).toBe(false);
    expect(loadEnginePath()).toBe("/engines/stockfish");
  });
});

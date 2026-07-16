import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  clearEnginePath,
  defaultEngineSettings,
  loadEnginePath,
  loadEngineSettings,
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

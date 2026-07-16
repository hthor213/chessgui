// Spec 220 step 3 (KVStore pass): the settings/results stores must reach
// persistence ONLY through the registered StorageProvider — never through a
// bare `localStorage` global. Proven by injecting a memory-backed provider
// in a node environment where no localStorage exists at all: if any code
// path still touched the global, these round-trips would silently no-op
// (or throw) instead of hitting the injected store.

import { describe, it, expect, beforeEach } from "vitest"
import { registerProviders, type StorageProvider } from "@/lib/platform"
import { browserProviders } from "@/lib/platform/browser"
import {
  defaultEngineSettings,
  loadEngineSettings,
  saveEngineSettings,
  loadEnginePath,
  saveEnginePath,
  clearEnginePath,
} from "@/lib/engine-settings"
import {
  loadSparResults,
  persistSparResults,
  SPAR_RESULTS_STORAGE_KEY,
  type SparResultEntry,
} from "@/lib/spar-results"

function memoryKV(): { store: Map<string, string>; provider: StorageProvider } {
  const store = new Map<string, string>()
  return {
    store,
    provider: {
      get: (k) => store.get(k) ?? null,
      set: (k, v) => void store.set(k, v),
      remove: (k) => void store.delete(k),
    },
  }
}

function sparEntry(): SparResultEntry {
  return {
    id: "t1",
    at: "2026-07-15T12:00:00Z",
    opponent: "Rival",
    level: 1700,
    mode: "serious",
    userColor: "white",
    result: "win",
    resultLabel: "Checkmate — White wins",
    plies: 60,
    countsTowardTraining: true,
    anomalyFlags: [],
  }
}

describe("KVStore routing (spec 220 step 3)", () => {
  let store: Map<string, string>

  beforeEach(() => {
    const kv = memoryKV()
    store = kv.store
    // Full provider set with only storage swapped — the shape a real shell
    // registers at boot.
    registerProviders({ ...browserProviders, storage: kv.provider })
  })

  it("engine settings round-trip through the injected provider", () => {
    saveEngineSettings({ ...defaultEngineSettings(), hash: 512 })
    expect(store.has("engine-settings")).toBe(true)
    expect(loadEngineSettings().hash).toBe(512)
  })

  it("engine path save/load/clear hit the injected provider", () => {
    saveEnginePath("/tmp/stockfish")
    expect(store.get("engine-path")).toBe("/tmp/stockfish")
    expect(loadEnginePath()).toBe("/tmp/stockfish")
    clearEnginePath()
    expect(store.has("engine-path")).toBe(false)
    // Fallback: browser shell has no default engine path, so "" comes back.
    expect(loadEnginePath()).toBe("")
  })

  it("spar results round-trip through the injected provider", () => {
    expect(loadSparResults()).toEqual([])
    persistSparResults([sparEntry()])
    expect(store.has(SPAR_RESULTS_STORAGE_KEY)).toBe(true)
    expect(loadSparResults()).toEqual([sparEntry()])
  })

  it("load survives a corrupt stored blob", () => {
    store.set(SPAR_RESULTS_STORAGE_KEY, "{not json")
    expect(loadSparResults()).toEqual([])
    store.set("engine-settings", "{not json")
    expect(loadEngineSettings()).toEqual(defaultEngineSettings())
  })
})

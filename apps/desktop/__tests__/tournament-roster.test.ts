// The tournament/exhibition Participant dropdown roster (spec 218 "Exhibition
// & tournament" checklist item 1; decision 5 picker style + the item's
// HONESTY GATE for BT3-backed GM personas).

import { describe, it, expect, beforeEach } from "vitest"
import {
  buildTournamentRoster,
  loadCustomEngines,
  addCustomEngine,
  removeCustomEngine,
  customEngineOption,
  CUSTOM_ENGINES_KEY,
  type EngineOption,
} from "@/lib/tournament-roster"
import { registerProviders, type StorageProvider } from "@/lib/platform"
import { browserProviders } from "@/lib/platform/browser"
import { GM_PERSONAS } from "@/lib/persona-manifest"
import { MAIA_ROSTER_BANDS, PRIVATE_RIVAL_ID } from "@/lib/roster"
import type { RivalBook } from "@/lib/rival-book"

const ENGINES: EngineOption[] = [
  { id: "engine-stockfish", displayName: "Stockfish 18", enginePath: "/opt/sf", label: "engine: stockfish 18" },
  { id: "engine-reckless", displayName: "Reckless", enginePath: "/opt/rk", label: "engine: reckless" },
]

const SAMPLE_BOOK: RivalBook = { version: 1, max_ply: 8, rival: "dad", entries: [] }

describe("buildTournamentRoster", () => {
  it("always includes the two engines, kind-prefixed per decision 5", () => {
    const roster = buildTournamentRoster(null, ENGINES)
    const sf = roster.find((e) => e.participant.id === "engine-stockfish")
    const rk = roster.find((e) => e.participant.id === "engine-reckless")
    expect(sf).toMatchObject({ label: "engine: stockfish 18" })
    expect(sf!.participant).toMatchObject({ kind: "uci", enginePath: "/opt/sf" })
    expect(rk).toMatchObject({ label: "engine: reckless" })
  })

  it("omits the private rival (bot: dad) when the local book hasn't loaded", () => {
    const roster = buildTournamentRoster(null, ENGINES)
    expect(roster.find((e) => e.participant.id === PRIVATE_RIVAL_ID)).toBeUndefined()
  })

  it("includes 'bot: dad' once the local book exists — mirrors lib/roster.ts's gate", () => {
    const roster = buildTournamentRoster(SAMPLE_BOOK, ENGINES)
    const rival = roster.find((e) => e.participant.id === PRIVATE_RIVAL_ID)
    expect(rival).toBeDefined()
    expect(rival!.label).toBe("bot: dad")
    expect(rival!.participant.kind).toBe("persona")
    // Generic — never the rival's real name (spec 214/218 hard rule).
    expect(rival!.participant.displayName.toLowerCase()).not.toContain("dad")
  })

  it("includes every Maia strength band as a generic 'bot: maia N' entry", () => {
    const roster = buildTournamentRoster(null, ENGINES)
    for (const level of MAIA_ROSTER_BANDS) {
      const bot = roster.find((e) => e.participant.id === `maia-${level}`)
      expect(bot, `maia-${level}`).toBeDefined()
      expect(bot!.label).toBe(`bot: maia ${level}`)
      expect(bot!.participant.personaConfig?.level).toBe(level)
      expect(bot!.participant.personaConfig?.weights).toBeUndefined()
    }
  })

  it("includes every BT3 GM persona from the manifest", () => {
    const roster = buildTournamentRoster(null, ENGINES)
    expect(GM_PERSONAS.length).toBeGreaterThan(0)
    for (const g of GM_PERSONAS) {
      const entry = roster.find((e) => e.participant.id === g.slug)
      expect(entry, g.slug).toBeDefined()
      expect(entry!.participant.kind).toBe("persona")
    }
  })

  // HONESTY GATE (spec 218 item 1, hard rule): a GM persona is never sent
  // level-only — every one carries weights:"bt3" and a measured-harness label.
  describe("HONESTY GATE — GM personas", () => {
    it("every GM persona entry carries weights:'bt3'", () => {
      const roster = buildTournamentRoster(null, ENGINES)
      for (const g of GM_PERSONAS) {
        const entry = roster.find((e) => e.participant.id === g.slug)!
        expect(entry.participant.personaConfig?.weights, g.slug).toBe("bt3")
      }
    })

    it("no GM persona entry is disabled — the persona arm DOES support bt3", () => {
      const roster = buildTournamentRoster(null, ENGINES)
      for (const g of GM_PERSONAS) {
        const entry = roster.find((e) => e.participant.id === g.slug)!
        expect(entry.disabled, g.slug).toBeFalsy()
      }
    })

    it("labels carry the measured harness move-match rate, not a bare name", () => {
      const roster = buildTournamentRoster(null, ENGINES)
      const kasparov = roster.find((e) => e.participant.id === "kasparov")!
      expect(kasparov.label).toMatch(/^bot: kasparov \(BT3, \d+% move-match\)$/)
    })

    it("sends real sampling params alongside weights, never bare level", () => {
      const roster = buildTournamentRoster(null, ENGINES)
      for (const g of GM_PERSONAS) {
        const cfg = roster.find((e) => e.participant.id === g.slug)!.participant.personaConfig!
        expect(cfg.temperature).toBeGreaterThan(0)
        expect(cfg.alpha).toBeGreaterThan(0)
        expect(typeof cfg.level).toBe("number")
      }
    })
  })
})

// Custom-engine store (spec 210 Phase 6 "Add-engine UI"): persistence goes
// through the StorageProvider seam, proven with an injected memory provider
// (same pattern as kv-store.test.ts).
describe("custom UCI engines", () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = new Map<string, string>()
    const provider: StorageProvider = {
      get: (k) => store.get(k) ?? null,
      set: (k, v) => void store.set(k, v),
      remove: (k) => void store.delete(k),
    }
    registerProviders({ ...browserProviders, storage: provider })
  })

  it("add -> load -> remove round-trips through the injected provider", () => {
    expect(loadCustomEngines()).toEqual([])
    const added = addCustomEngine("My Engine", "/tmp/my-engine")
    expect(added).toEqual([{ id: "custom-my-engine", name: "My Engine", path: "/tmp/my-engine" }])
    expect(store.has(CUSTOM_ENGINES_KEY)).toBe(true)
    expect(loadCustomEngines()).toEqual(added)
    expect(removeCustomEngine("custom-my-engine")).toEqual([])
    expect(loadCustomEngines()).toEqual([])
  })

  it("bumps the id on a name collision so both entries stay addressable", () => {
    addCustomEngine("Lc0", "/a/lc0")
    const list = addCustomEngine("lc0", "/b/lc0")
    expect(list.map((e) => e.id)).toEqual(["custom-lc0", "custom-lc0-2"])
  })

  it("falls back to the binary's base name when the name is blank", () => {
    const [e] = addCustomEngine("   ", "/opt/engines/patricia")
    expect(e.name).toBe("patricia")
    expect(e.id).toBe("custom-patricia")
  })

  it("drops malformed stored entries instead of failing the list", () => {
    store.set(
      CUSTOM_ENGINES_KEY,
      JSON.stringify([{ id: "custom-ok", name: "Ok", path: "/ok" }, { id: 42 }, "junk", null]),
    )
    expect(loadCustomEngines()).toEqual([{ id: "custom-ok", name: "Ok", path: "/ok" }])
    store.set(CUSTOM_ENGINES_KEY, "{not json")
    expect(loadCustomEngines()).toEqual([])
  })

  it("customEngineOption folds in a resolved version, decision-5 label style", () => {
    const e = { id: "custom-lc0", name: "Lc0", path: "/a/lc0" }
    expect(customEngineOption(e)).toEqual({
      id: "custom-lc0",
      displayName: "Lc0",
      enginePath: "/a/lc0",
      label: "engine: lc0",
    })
    expect(customEngineOption(e, "Lc0 v0.31")).toMatchObject({
      displayName: "Lc0 v0.31",
      label: "engine: lc0 v0.31",
    })
    // "not found" is a probe failure, not a version — keep the given name.
    expect(customEngineOption(e, "not found").label).toBe("engine: lc0")
  })

  it("registered engines flow into buildTournamentRoster as uci participants", () => {
    const [e] = addCustomEngine("Lc0", "/a/lc0")
    const roster = buildTournamentRoster(null, [...ENGINES, customEngineOption(e)])
    const entry = roster.find((r) => r.participant.id === "custom-lc0")
    expect(entry).toBeDefined()
    expect(entry!.participant).toMatchObject({ kind: "uci", enginePath: "/a/lc0" })
    expect(entry!.label).toBe("engine: lc0")
  })
})

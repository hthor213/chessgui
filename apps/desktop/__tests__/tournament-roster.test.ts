// The tournament/exhibition Participant dropdown roster (spec 218 "Exhibition
// & tournament" checklist item 1; decision 5 picker style + the item's
// HONESTY GATE for BT3-backed GM personas).

import { describe, it, expect } from "vitest"
import { buildTournamentRoster, type EngineOption } from "@/lib/tournament-roster"
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

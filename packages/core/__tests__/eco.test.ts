import { describe, it, expect } from "vitest"
import { ecoLabel, ecoName, matchesEcoQuery } from "@chessgui/core/eco"

describe("ECO → opening-name lookup (spec 200)", () => {
  it("names famous codes", () => {
    expect(ecoName("B90")).toBe("Sicilian, Najdorf")
    expect(ecoName("B70")).toBe("Sicilian, Dragon")
    expect(ecoName("C60")).toBe("Ruy Lopez")
    expect(ecoName("C89")).toBe("Ruy Lopez, Marshall Attack")
    expect(ecoName("E60")).toBe("King's Indian Defence")
    expect(ecoName("A57")).toBe("Benko Gambit")
    expect(ecoName("D85")).toBe("Grünfeld, Exchange")
  })

  it("resolves every code in a family range to that family", () => {
    // B91..B99 all belong to the Najdorf block starting at B90.
    for (const code of ["B91", "B95", "B99"]) {
      expect(ecoName(code)).toBe("Sicilian, Najdorf")
    }
    // E00..E09 Catalan
    expect(ecoName("E05")).toBe("Catalan Opening")
  })

  it("covers the full A00–E99 space", () => {
    for (const letter of ["A", "B", "C", "D", "E"]) {
      for (let n = 0; n < 100; n++) {
        const code = `${letter}${String(n).padStart(2, "0")}`
        expect(ecoName(code), code).toBeTruthy()
      }
    }
  })

  it("is case/whitespace tolerant and rejects malformed codes", () => {
    expect(ecoName(" b90 ")).toBe("Sicilian, Najdorf")
    expect(ecoName("")).toBeNull()
    expect(ecoName("Z12")).toBeNull()
    expect(ecoName("B9")).toBeNull()
    expect(ecoName("B900")).toBeNull()
  })

  it("ecoLabel prints code · name, or just the input when unknown", () => {
    expect(ecoLabel("b90")).toBe("B90 · Sicilian, Najdorf")
    expect(ecoLabel("??")).toBe("??")
  })
})

describe("matchesEcoQuery — tournament ECO/opening filter (spec 210 Phase 6)", () => {
  it("an empty or whitespace query matches everything, tagged or not", () => {
    expect(matchesEcoQuery("B90", "")).toBe(true)
    expect(matchesEcoQuery(undefined, "  ")).toBe(true)
    expect(matchesEcoQuery(null, "")).toBe(true)
  })

  it("matches code prefixes at every length (volume, decade, exact)", () => {
    expect(matchesEcoQuery("B90", "B")).toBe(true)
    expect(matchesEcoQuery("B90", "B9")).toBe(true)
    expect(matchesEcoQuery("B90", "B90")).toBe(true)
    expect(matchesEcoQuery("B90", "B91")).toBe(false)
    expect(matchesEcoQuery("C65", "B")).toBe(false)
    // Case-insensitive both sides.
    expect(matchesEcoQuery("b90", "b9")).toBe(true)
  })

  it("matches opening-name substrings via the family lookup", () => {
    expect(matchesEcoQuery("B90", "najdorf")).toBe(true)
    expect(matchesEcoQuery("B90", "Sicilian")).toBe(true)
    expect(matchesEcoQuery("B70", "dragon")).toBe(true)
    expect(matchesEcoQuery("C65", "berlin")).toBe(true)
    expect(matchesEcoQuery("B90", "berlin")).toBe(false)
  })

  it("excludes untagged or malformed codes once a query is set", () => {
    expect(matchesEcoQuery(undefined, "B90")).toBe(false)
    expect(matchesEcoQuery(null, "najdorf")).toBe(false)
    expect(matchesEcoQuery("", "B")).toBe(false)
    expect(matchesEcoQuery("Z12", "sicilian")).toBe(false)
  })
})

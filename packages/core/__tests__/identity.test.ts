// Spec 225 follow-on: the pure identity helpers — name cleanup, the store
// parse, the White/Black → my-side match that orients a loaded board, and the
// archive-time header fill. Orientation must fire ONLY on an unambiguous
// single-side match, and header fill must never clobber a real name.

import { describe, it, expect } from "vitest"
import {
  cleanNames,
  ensurePlayerHeaders,
  matchMyColor,
  normalizeName,
  parseIdentityStore,
} from "@chessgui/core/identity"

describe("cleanNames / normalizeName", () => {
  it("trims, drops blanks, and dedupes case-insensitively keeping first casing", () => {
    expect(cleanNames([" Hjalti ", "hjalti", "", "  ", "hjaltth"])).toEqual([
      "Hjalti",
      "hjaltth",
    ])
  })
  it("normalizeName lowercases and trims", () => {
    expect(normalizeName("  Magnus Carlsen ")).toBe("magnus carlsen")
  })
})

describe("parseIdentityStore", () => {
  it("returns empty for null/garbage", () => {
    expect(parseIdentityStore(null).names).toEqual([])
    expect(parseIdentityStore("not json").names).toEqual([])
    expect(parseIdentityStore(JSON.stringify({ v: 2, names: ["x"] })).names).toEqual([])
  })
  it("parses and cleans a valid store", () => {
    expect(parseIdentityStore(JSON.stringify({ v: 1, names: ["A", "a", 3, ""] })).names).toEqual([
      "A",
    ])
  })
})

describe("matchMyColor", () => {
  const names = ["Hjalti Thorsteinsson", "hjaltth"]
  it("matches White by identity (case-insensitive)", () => {
    expect(matchMyColor({ White: "HJALTTH", Black: "Denny" }, names)).toBe("white")
  })
  it("matches Black by identity", () => {
    expect(matchMyColor({ White: "Denny", Black: "hjalti thorsteinsson" }, names)).toBe("black")
  })
  it("returns null when neither side matches", () => {
    expect(matchMyColor({ White: "Denny", Black: "Karpov" }, names)).toBeNull()
  })
  it("returns null when both sides match (ambiguous)", () => {
    expect(matchMyColor({ White: "hjaltth", Black: "Hjalti Thorsteinsson" }, names)).toBeNull()
  })
  it("returns null when the name list is empty", () => {
    expect(matchMyColor({ White: "hjaltth", Black: "x" }, [])).toBeNull()
  })
  it("ignores an empty header value even if the name list has a blank-ish entry", () => {
    expect(matchMyColor({ White: "", Black: "Denny" }, names)).toBeNull()
  })
})

describe("ensurePlayerHeaders", () => {
  it("fills missing White/Black headers", () => {
    const pgn = `[Event "Casual"]\n\n1. e4 e5 *`
    const out = ensurePlayerHeaders(pgn, { white: "hjaltth", black: "Denny" })
    expect(out).toContain('[White "hjaltth"]')
    expect(out).toContain('[Black "Denny"]')
    expect(out).toContain("1. e4 e5 *")
  })
  it("replaces placeholder '?' but never a real name", () => {
    const pgn = `[White "?"]\n[Black "Karpov"]\n\n1. d4 *`
    const out = ensurePlayerHeaders(pgn, { white: "hjaltth", black: "Denny" })
    expect(out).toContain('[White "hjaltth"]')
    expect(out).toContain('[Black "Karpov"]')
    expect(out).not.toContain("Denny")
  })
  it("adds headers to a header-less PGN", () => {
    const out = ensurePlayerHeaders("1. e4 *", { white: "Me", black: "You" })
    expect(out).toContain('[White "Me"]')
    expect(out).toContain('[Black "You"]')
    expect(out.trimEnd().endsWith("1. e4 *")).toBe(true)
  })
  it("leaves a side untouched when no name is supplied", () => {
    const pgn = `[White "?"]\n\n1. e4 *`
    expect(ensurePlayerHeaders(pgn, { black: "Denny" })).toContain('[White "?"]')
  })

  it("does not corrupt a header-less PGN whose moves contain a bracketed comment", () => {
    const pgn = `1. e4 {[%clk 0:05:00]} e5 *`
    const out = ensurePlayerHeaders(pgn, { white: "Me", black: "Denny" })
    expect(out).toContain('[White "Me"]')
    expect(out).toContain('[Black "Denny"]')
    // The move comment survives intact — no tag was spliced into it.
    expect(out).toContain("1. e4 {[%clk 0:05:00]} e5 *")
    expect(out).toMatch(/^\[White "Me"\]\n\[Black "Denny"\]\n\n1\. e4/)
  })

  it("does not expand $-sequences from a player name into the PGN", () => {
    const pgn = `[White "?"]\n[Black "?"]\n\n1. e4 *`
    const out = ensurePlayerHeaders(pgn, { white: "a$&b", black: "c$'d" })
    expect(out).toContain('[White "a$&b"]')
    expect(out).toContain(`[Black "c$'d"]`)
  })
})

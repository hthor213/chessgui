import { describe, it, expect } from "vitest"
import {
  artifactRows,
  canRunProfile,
  parseProfileJson,
  profileRunMessage,
} from "@/lib/player-profile"

const PROFILE_JSON = JSON.stringify({
  slug: "testplayer",
  display_name: "Test Player",
  sample: { games: 32, verified_games: 26, verdict: "dossier-only", badge: "DOSSIER-ONLY", reasons: ["r1"] },
  artifacts: {
    pgn: "data/rivals/testplayer.pgn",
    sources_md: "data/rivals/testplayer.SOURCES.md",
    stats: "data/rivals/testplayer.stats.json",
    book: "data/rivals/testplayer.book.json",
    config: null, // dossier-only: no persona config emitted
  },
})

describe("profileRunMessage", () => {
  it("is null for a successful run with a readable record (verdict shown instead)", () => {
    expect(profileRunMessage({ exit_code: 0, cancelled: false, profile_json: PROFILE_JSON })).toBeNull()
  })

  it("reports cancellation, failure, and an unreadable record honestly", () => {
    expect(profileRunMessage({ exit_code: null, cancelled: true, profile_json: null })).toMatch(/cancelled/i)
    expect(profileRunMessage({ exit_code: 3, cancelled: false, profile_json: null })).toContain("exit code 3")
    expect(profileRunMessage({ exit_code: 0, cancelled: false, profile_json: null })).toMatch(/couldn't be read back/)
  })
})

describe("parseProfileJson", () => {
  it("parses a pipeline record", () => {
    const p = parseProfileJson(PROFILE_JSON)
    expect(p.slug).toBe("testplayer")
    expect(p.sample.verdict).toBe("dossier-only")
  })

  it("throws plain-language messages on garbage and non-pipeline records", () => {
    expect(() => parseProfileJson("{nope")).toThrow(/valid JSON/)
    expect(() => parseProfileJson(JSON.stringify({ player_id: 1 }))).toThrow(/sample verdict/)
  })
})

describe("artifactRows", () => {
  it("lists only the artifacts the record says were built (config null omitted)", () => {
    const rows = artifactRows(parseProfileJson(PROFILE_JSON))
    expect(rows.map((r) => r.label)).toEqual([
      "Corpus (PGN)",
      "Provenance",
      "Stats dossier",
      "Opening book",
    ])
    expect(rows[0].path).toBe("data/rivals/testplayer.pgn")
  })
})

describe("canRunProfile", () => {
  it("requires a name plus at least one GAME source (FIDE ID alone fetches nothing)", () => {
    expect(canRunProfile({ name: "X", chesscom: "x" })).toBe(true)
    expect(canRunProfile({ name: "X", lichess: "x" })).toBe(true)
    expect(canRunProfile({ name: "X", pgns: ["/tmp/x.pgn"] })).toBe(true)
    expect(canRunProfile({ name: "X", fideId: "123" })).toBe(false)
    expect(canRunProfile({ name: "", chesscom: "x" })).toBe(false)
    expect(canRunProfile({ name: "X" })).toBe(false)
  })
})

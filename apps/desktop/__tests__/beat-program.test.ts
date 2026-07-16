import { describe, it, expect } from "vitest"
import {
  beatProgramId,
  beatTargetFor,
  bookExitMove,
  buildBeatPlan,
  maiaBandForRating,
  readPhaseProfile,
  type BeatTarget,
} from "@/lib/beat-program"
import type {
  LocalPlayerProfile,
  PlayerProfileFile,
  PlayerStatsFile,
} from "@chessgui/core/player-profile-types"
import type { RivalBook } from "@/lib/rival-book"

// Fixture mirroring the arnthor artifacts (spec 225's first target) — the
// dossier-only fallback path.
const PROFILE: PlayerProfileFile = {
  slug: "testplayer",
  display_name: "Test Player",
  sample: {
    games: 32,
    verified_games: 26,
    unverified_games: 6,
    verdict: "dossier-only",
    badge: "DOSSIER-ONLY",
    reasons: ["corpus pending review", "6 games unverified"],
  },
  rating: { value: 2236, source: "corpus Elo headers" },
}

const STATS: PlayerStatsFile = {
  slug: "testplayer",
  results: { wins: 7, draws: 10, losses: 15, score_pct: 37.5 },
  opening_families: {
    as_white: [
      { family: "Réti/Nf3 systems", wins: 1, draws: 2, losses: 3, games: 6 },
      { family: "Queen's Gambit", wins: 0, draws: 0, losses: 3, games: 3 },
    ],
    as_black: [{ family: "English", wins: 3, draws: 1, losses: 1, games: 5 }],
  },
  top_lines: {
    as_white: [
      { line: "1.Nf3 Nf6 2.c4 c5 3.Nc3 Nc6", games: 2 },
      { line: "1.d4 d5 2.Nf3 Nf6 3.c4 dxc4", games: 2 },
    ],
    as_black: [{ line: "1.e4 d6 2.d4 g6 3.Nc3 Bg7", games: 2 }],
  },
  phase_profile: {
    ended_in: {
      opening: { wins: 0, draws: 1, losses: 0, games: 1 }, // < 3 games: ignored
      middlegame: { wins: 3, draws: 4, losses: 3, games: 10 },
      endgame: { wins: 4, draws: 5, losses: 12, games: 21 },
    },
  },
}

const BOOK: RivalBook = { version: 1, max_ply: 8, rival: "testplayer", entries: [] }

const DOSSIER_TARGET: BeatTarget = {
  profile: PROFILE,
  stats: STATS,
  hasPersona: false,
  book: BOOK,
}

describe("maiaBandForRating (level-matched Maia fallback)", () => {
  it("snaps to the nearest published band", () => {
    expect(maiaBandForRating(1462)).toEqual({ level: 1500, capped: false })
    expect(maiaBandForRating(1449)).toEqual({ level: 1400, capped: false })
  })

  it("caps outside the published set and says so", () => {
    expect(maiaBandForRating(2236)).toEqual({ level: 1900, capped: true })
    expect(maiaBandForRating(800)).toEqual({ level: 1100, capped: true })
  })

  it("defaults to 1500 uncapped when no rating exists", () => {
    expect(maiaBandForRating(null)).toEqual({ level: 1500, capped: false })
  })
})

describe("bookExitMove (exit X's book by ~move 6)", () => {
  it("targets one move past the measured book depth", () => {
    expect(bookExitMove(BOOK)).toBe(5) // 8 plies = 4 moves deep -> exit by 5
  })

  it("defaults to move 6 without a book artifact", () => {
    expect(bookExitMove(null)).toBe(6)
    expect(bookExitMove(undefined)).toBe(6)
  })

  it("clamps to the 4..8 calibration range", () => {
    expect(bookExitMove({ ...BOOK, max_ply: 2 })).toBe(4)
    expect(bookExitMove({ ...BOOK, max_ply: 30 })).toBe(8)
  })
})

describe("readPhaseProfile (attack where he leaks, shore up where he grinds)", () => {
  it("names the leak (worst score) and grind (best score), ignoring thin phases", () => {
    const r = readPhaseProfile(STATS)
    expect(r.leak?.phase).toBe("endgame") // (4 + 2.5)/21 ≈ 31%
    expect(r.grind?.phase).toBe("middlegame") // 50%
  })

  it("degrades to nulls without stats", () => {
    expect(readPhaseProfile(null)).toEqual({ leak: null, grind: null })
  })
})

describe("buildBeatPlan — the spec 215 Program", () => {
  const plan = buildBeatPlan(DOSSIER_TARGET, new Date("2026-07-16T12:00:00Z"))

  it("emits a valid program: id, 3 contiguous chapters, day-indexed blocks, unique ids", () => {
    const p = plan.program
    expect(p.id).toBe(beatProgramId("testplayer"))
    expect(p.name).toBe("Beat Test Player")
    expect(p.chapters.length).toBe(3)
    expect(p.chapters[0].weekStart).toBe(1)
    for (let i = 1; i < p.chapters.length; i++) {
      expect(p.chapters[i].weekStart).toBe(p.chapters[i - 1].weekEnd + 1)
    }
    const ids = new Set<string>()
    for (const ch of p.chapters) {
      expect(ch.exitCriteria.length).toBeGreaterThan(0)
      for (const b of ch.week) {
        expect(b.day).toBeGreaterThanOrEqual(0)
        expect(b.day).toBeLessThanOrEqual(6)
        expect(ids.has(b.id)).toBe(false)
        ids.add(b.id)
        // Block ids are slug-prefixed so check-offs never collide with the
        // bundled program's (or another target's).
        expect(b.id.startsWith("beat-testplayer-")).toBe(true)
      }
    }
  })

  it("derives anti-book drills from the target's real most-played lines", () => {
    const anti = plan.program.chapters[0].week.filter((b) => b.type === "anti_line_drill")
    expect(anti.length).toBe(2)
    expect(anti[0].detail).toContain("1.Nf3 Nf6 2.c4 c5 3.Nc3 Nc6")
    expect(anti[0].detail).toContain("move 5") // book measured 8 plies -> exit by 5
    expect(anti[1].detail).toContain("1.e4 d6 2.d4 g6 3.Nc3 Bg7")
  })

  it("weights conversion toward the measured leak phase", () => {
    const conv = plan.program.chapters[1].week.filter((b) => b.type === "endgame_playout")
    expect(conv.length).toBe(2)
    expect(conv[0].detail).toMatch(/endgame/i)
    expect(conv[0].detail).toContain("31%")
  })

  it("DOSSIER FALLBACK: spar blocks say the profile fields no bot and substitute level-matched Maia", () => {
    for (const ch of plan.program.chapters) {
      for (const b of ch.week.filter((x) => x.type === "spar_rival")) {
        expect(b.detail).toContain("dossier-only")
        expect(b.detail).toContain("fields no bot")
        expect(b.detail).toContain("Bot 1900") // 2236 capped to the top band
        expect(b.detail).toMatch(/top published Maia band/i)
      }
    }
  })

  it("never tells the trainee to exceed the top band when already capped there", () => {
    const above = plan.program.chapters[2].week.find((b) => b.title === "Spar above weight")!
    expect(above.detail).not.toContain("one strength band higher")
  })

  it("spar blocks use the persona when one exists (an existing-rival profile)", () => {
    const armed = buildBeatPlan({ ...DOSSIER_TARGET, hasPersona: true, personaLevel: 1300 })
    const spar = armed.program.chapters[0].week.find((b) => b.type === "spar_rival")!
    expect(spar.detail).toContain("Test Player's persona")
    expect(spar.detail).toContain("1300")
    expect(spar.detail).not.toContain("fields no bot")
    // Below the top band, taper says to go one band up.
    const above = armed.program.chapters[2].week.find((b) => b.title === "Spar above weight")!
    expect(above.detail).toContain("one strength band higher")
  })

  it("markdown carries the stored verdict verbatim, the lines, and the privacy rule", () => {
    const md = plan.markdown
    expect(md).toContain("Beat Test Player")
    expect(md).toContain("DOSSIER-ONLY")
    expect(md).toContain("corpus pending review")
    expect(md).toContain("32 games (26 verified, 6 unverified)")
    expect(md).toContain("1.Nf3 Nf6 2.c4 c5 3.Nc3 Nc6")
    expect(md).toContain("gitignored")
    expect(md).toContain("2026-07-16")
    // The honest fallback is stated in the doc too, not just the app blocks.
    expect(md).toContain("fields no bot")
  })

  it("degrades honestly without a stats artifact", () => {
    const bare = buildBeatPlan({ profile: PROFILE, stats: null, hasPersona: false })
    expect(bare.program.chapters.length).toBe(3)
    expect(bare.markdown).toContain("No line data in the dossier")
    const conv = bare.program.chapters[1].week.find((b) => b.type === "endgame_playout")!
    expect(conv.detail).toContain("too thin")
  })
})

describe("beatTargetFor", () => {
  it("threads the profile row and persona facts through", () => {
    const row: LocalPlayerProfile = { profile: PROFILE, stats: STATS }
    const t = beatTargetFor(row, { hasPersona: true, personaLevel: 1400, book: BOOK })
    expect(t.profile).toBe(PROFILE)
    expect(t.stats).toBe(STATS)
    expect(t.hasPersona).toBe(true)
    expect(t.personaLevel).toBe(1400)
    expect(t.book).toBe(BOOK)
  })
})

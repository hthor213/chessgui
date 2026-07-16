import { describe, it, expect } from "vitest"
import {
  buildRepertoireDeck,
  extractRepertoire,
  guessUsername,
  repertoireCardId,
  repertoireQueueCounts,
  REPERTOIRE_MAX_PLY,
  type RepertoireCard,
} from "@/lib/repertoire"
import {
  cardSchedules,
  dueReviews,
  reviewIntervalDays,
  REVIEW_LADDER_DAYS,
  type RepertoireResultEntry,
} from "@/lib/repertoire-results"

const NOW = Date.parse("2026-07-15T12:00:00Z")
const DAY = 24 * 60 * 60 * 1000

function pgn(white: string, black: string, moves: string, extraHeaders = ""): string {
  return `[Event "Test"]\n[White "${white}"]\n[Black "${black}"]\n[Result "*"]\n${extraHeaders}\n${moves} *\n\n`
}

function entry(key: string, correct: boolean, atMs: number): RepertoireResultEntry {
  return {
    id: Math.random().toString(36).slice(2),
    at: new Date(atMs).toISOString(),
    key,
    correct,
  }
}

// ---------------------------------------------------------------------------
// guessUsername
// ---------------------------------------------------------------------------

describe("guessUsername", () => {
  it("returns the most frequent player name across headers", () => {
    const text =
      pgn("hjaltth", "rivalA", "1. e4 e5") +
      pgn("rivalB", "hjaltth", "1. d4 d5") +
      pgn("hjaltth", "rivalA", "1. c4 c5")
    expect(guessUsername(text)).toBe("hjaltth")
  })

  it("ignores empty and '?' names, returns null on no headers", () => {
    expect(guessUsername(pgn("?", "", "1. e4 e5"))).toBeNull()
    expect(guessUsername("no headers here")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// extractRepertoire
// ---------------------------------------------------------------------------

describe("extractRepertoire", () => {
  const twoWhiteGames =
    pgn("hjaltth", "rival", "1. e4 e5 2. Nf3 Nc6 3. Bb5") +
    pgn("hjaltth", "rival", "1. e4 e5 2. Nf3 Nf6 3. Nxe5")

  it("cards only for positions reached at least minReached times, expected = most played", () => {
    const rep = extractRepertoire(twoWhiteGames, "hjaltth")
    expect(rep.gamesUsed).toBe(2)
    // Start position (2x, e4 both) and after 1.e4 e5 (2x, Nf3 both); the
    // positions after Black's 2nd move diverge and are reached once each.
    expect(rep.cards).toHaveLength(2)
    expect(rep.cards[0].ply).toBe(0)
    expect(rep.cards[0].expectedSan).toBe("e4")
    expect(rep.cards[0].expectedUci).toBe("e2e4")
    expect(rep.cards[0].timesPlayed).toBe(2)
    expect(rep.cards[0].timesReached).toBe(2)
    expect(rep.cards[1].ply).toBe(2)
    expect(rep.cards[1].expectedSan).toBe("Nf3")
    expect(rep.cards[1].color).toBe("white")
  })

  it("extracts black cards from the user's black games, case-insensitively", () => {
    const text =
      pgn("rival", "HJALTTH", "1. d4 d5 2. c4 e6") + pgn("rival", "hjaltth", "1. d4 d5 2. Nf3 e6")
    const rep = extractRepertoire(text, "hjaltth")
    expect(rep.gamesUsed).toBe(2)
    const afterD4 = rep.cards.find((c) => c.ply === 1)
    expect(afterD4).toBeDefined()
    expect(afterD4!.color).toBe("black")
    expect(afterD4!.expectedSan).toBe("d5")
    expect(afterD4!.timesReached).toBe(2)
  })

  it("merges transpositions onto one card (normalized-FEN identity)", () => {
    const text =
      pgn("hjaltth", "rival", "1. d4 d5 2. c4 e6 3. Nc3") +
      pgn("hjaltth", "rival", "1. c4 d5 2. d4 e6 3. Nc3")
    const rep = extractRepertoire(text, "hjaltth", { minReached: 2 })
    const deep = rep.cards.find((c) => c.ply === 4)
    expect(deep).toBeDefined()
    expect(deep!.timesReached).toBe(2)
    expect(deep!.expectedSan).toBe("Nc3")
    // The start position was reached twice but with different moves — the
    // first-recorded move wins the tie.
    const start = rep.cards.find((c) => c.ply === 0)
    expect(start!.expectedSan).toBe("d4")
    expect(start!.timesPlayed).toBe(1)
    expect(start!.timesReached).toBe(2)
  })

  it("caps at maxPly and skips self-play and set-up-position games", () => {
    const selfPlay = pgn("hjaltth", "hjaltth", "1. e4 e5")
    const setUp = pgn(
      "hjaltth",
      "rival",
      "3... Nf6",
      '[SetUp "1"]\n[FEN "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"]\n',
    )
    const rep = extractRepertoire(selfPlay + setUp + twoWhiteGames, "hjaltth", { maxPly: 2 })
    expect(rep.gamesUsed).toBe(2)
    expect(rep.cards).toHaveLength(1) // only the start position fits ply < 2
    expect(rep.cards[0].ply).toBe(0)
  })

  it("stops a game's walk at malformed SAN, keeping earlier counts", () => {
    const text =
      pgn("hjaltth", "rival", "1. e4 e5 2. Qxh7") + pgn("hjaltth", "rival", "1. e4 c5 2. Nf3")
    const rep = extractRepertoire(text, "hjaltth")
    expect(rep.gamesUsed).toBe(2)
    expect(rep.cards).toHaveLength(1)
    expect(rep.cards[0].expectedSan).toBe("e4")
    expect(rep.cards[0].timesReached).toBe(2)
  })

  it("stable card ids survive rebuilds", () => {
    const a = extractRepertoire(twoWhiteGames, "hjaltth")
    const b = extractRepertoire(twoWhiteGames + pgn("hjaltth", "rival", "1. e4 e5 2. Nf3"), "hjaltth")
    expect(b.cards.map((c) => c.id)).toContain(a.cards[0].id)
    expect(a.cards[0].id).toBe(repertoireCardId("white", a.cards[0].fen))
  })

  it("default window is the first 10 moves", () => {
    expect(REPERTOIRE_MAX_PLY).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// Schedule (repertoire-results)
// ---------------------------------------------------------------------------

describe("reviewIntervalDays", () => {
  it("walks the ladder and sticks at the last rung", () => {
    expect(reviewIntervalDays(1)).toBe(1)
    expect(reviewIntervalDays(2)).toBe(3)
    expect(reviewIntervalDays(3)).toBe(7)
    expect(reviewIntervalDays(6)).toBe(90)
    expect(reviewIntervalDays(99)).toBe(REVIEW_LADDER_DAYS[REVIEW_LADDER_DAYS.length - 1])
  })
})

describe("cardSchedules / dueReviews", () => {
  it("success schedules by streak; failure is due immediately", () => {
    const entries = [
      entry("a", true, NOW - 3 * DAY), // streak 1 → due 1d after = NOW-2d
      entry("b", false, NOW - 1 * DAY), // fail → due at once = NOW-1d
      entry("c", true, NOW - 5 * DAY), // streak 1 at the time
      entry("c", true, NOW - 4 * DAY), // streak 2 → due 3d after = NOW-1d (tie with b; stable sort keeps log order)
    ]
    const s = cardSchedules(entries)
    expect(s.get("a")!.streak).toBe(1)
    expect(s.get("a")!.dueAt).toBe(NOW - 3 * DAY + 1 * DAY)
    expect(s.get("b")!.streak).toBe(0)
    expect(s.get("b")!.dueAt).toBe(NOW - 1 * DAY)
    expect(s.get("c")!.streak).toBe(2)
    expect(s.get("c")!.dueAt).toBe(NOW - 4 * DAY + 3 * DAY)
    const due = dueReviews(entries, NOW)
    expect(due.map((d) => d.key)).toEqual(["a", "b", "c"]) // longest-overdue first
  })

  it("a failure resets the streak", () => {
    const entries = [
      entry("a", true, NOW - 5 * DAY),
      entry("a", true, NOW - 4 * DAY),
      entry("a", false, NOW - 3 * DAY),
      entry("a", true, NOW - 2 * DAY),
    ]
    const s = cardSchedules(entries).get("a")!
    expect(s.streak).toBe(1)
    expect(s.dueAt).toBe(NOW - 2 * DAY + 1 * DAY)
    expect(s.attempts).toBe(4)
    expect(s.correct).toBe(3)
  })

  it("not-yet-due cards are excluded from the due queue", () => {
    const entries = [entry("a", true, NOW - 1 * DAY + 60_000)] // due in 1 minute
    expect(dueReviews(entries, NOW)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Deck builder
// ---------------------------------------------------------------------------

function card(over: Partial<RepertoireCard> & { id: string }): RepertoireCard {
  return {
    color: "white",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    ply: 0,
    expectedSan: "e4",
    expectedUci: "e2e4",
    timesPlayed: 2,
    timesReached: 2,
    ...over,
  }
}

describe("buildRepertoireDeck", () => {
  const cards = [
    card({ id: "c0", ply: 0 }),
    card({ id: "c2", ply: 2 }),
    card({ id: "c4", ply: 4, color: "black" }),
  ]

  it("due reviews lead, then new cards shallow-first; count caps the deck", () => {
    const entries = [entry("c4", false, NOW - DAY)]
    const deck = buildRepertoireDeck(cards, entries, { count: 2, now: NOW })
    expect(deck.map((d) => d.card.id)).toEqual(["c4", "c0"])
    expect(deck[0].review).toBe(true)
    expect(deck[1].review).toBe(false)
  })

  it("attempted-but-not-due cards are neither reviews nor new", () => {
    const entries = [entry("c0", true, NOW - 60_000)] // due tomorrow
    const deck = buildRepertoireDeck(cards, entries, { count: 10, now: NOW })
    expect(deck.map((d) => d.card.id)).toEqual(["c2", "c4"])
  })

  it("filters by colour and ignores schedules for dropped cards", () => {
    const entries = [entry("gone", false, NOW - DAY), entry("c4", false, NOW - DAY)]
    const deck = buildRepertoireDeck(cards, entries, { color: "black", count: 10, now: NOW })
    expect(deck.map((d) => d.card.id)).toEqual(["c4"])
  })
})

describe("repertoireQueueCounts", () => {
  it("splits into due / fresh / later, ignoring foreign keys", () => {
    const cards = [card({ id: "c0" }), card({ id: "c2" }), card({ id: "c4" })]
    const entries = [
      entry("c0", false, NOW - DAY), // due
      entry("c2", true, NOW - 60_000), // later
      entry("gone", false, NOW - DAY), // not in the repertoire
    ]
    expect(repertoireQueueCounts(cards, entries, NOW)).toEqual({ due: 1, fresh: 1, later: 1 })
  })
})

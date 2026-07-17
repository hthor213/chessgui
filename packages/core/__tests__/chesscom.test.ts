// Spec 219 "Game finished": the chess.com Published-Data API client. All
// network is mocked; these tests pin the etiquette (serial requests, the
// descriptive User-Agent) and the matching rules (exact URL match archives,
// heuristic matches need confirmation, misses/failures stay locked).

import { describe, it, expect } from "vitest"
import {
  CHESSCOM_USER_AGENT,
  fetchFinishedGame,
  type ChesscomGame,
  type FetchLike,
} from "@chessgui/core/chesscom"

const ARCHIVES_URL = "https://api.chess.com/pub/player/hjaltth/games/archives"
const JUNE = "https://api.chess.com/pub/player/hjaltth/games/2026/06"
const JULY = "https://api.chess.com/pub/player/hjaltth/games/2026/07"

function game(overrides: Partial<ChesscomGame> = {}): ChesscomGame {
  return {
    url: "https://www.chess.com/game/daily/123456",
    pgn: '[Event "Daily"]\n\n1. e4 e5 *',
    end_time: 1_752_000_000, // epoch seconds
    time_class: "daily",
    white: { username: "hjaltth" },
    black: { username: "dad" },
    ...overrides,
  }
}

/** Mock fetch over a url→body map that records call order, headers, and the
 *  maximum number of requests ever in flight at once. */
function mockFetch(routes: Record<string, unknown>) {
  const calls: string[] = []
  const headersSeen: Record<string, string>[] = []
  let inFlight = 0
  let maxInFlight = 0
  const fetchFn: FetchLike = async (url, init) => {
    calls.push(url)
    headersSeen.push(init.headers)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    // Yield so overlapping (parallel) requests would be observable.
    await new Promise((r) => setTimeout(r, 0))
    inFlight--
    if (!(url in routes)) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => routes[url] }
  }
  return { fetchFn, calls, headersSeen, maxInFlight: () => maxInFlight }
}

describe("fetchFinishedGame", () => {
  it("matches by stored game URL: archives first, then months newest-first", async () => {
    const wanted = game({ url: "https://www.chess.com/game/daily/999" })
    const mock = mockFetch({
      [ARCHIVES_URL]: { archives: [JUNE, JULY] },
      [JULY]: { games: [game()] },
      [JUNE]: { games: [wanted] },
    })
    const result = await fetchFinishedGame({
      username: "HjaltTh", // mixed case must normalize into the URL
      gameUrl: "https://www.chess.com/game/daily/999/", // trailing slash tolerated
      fetchFn: mock.fetchFn,
    })
    expect(result).toEqual({ status: "matched", game: wanted, pgn: wanted.pgn })
    expect(mock.calls).toEqual([ARCHIVES_URL, JULY, JUNE])
  })

  it("issues strictly serial requests with the descriptive User-Agent", async () => {
    const mock = mockFetch({
      [ARCHIVES_URL]: { archives: [JUNE, JULY] },
      [JULY]: { games: [] },
      [JUNE]: { games: [game()] },
    })
    await fetchFinishedGame({
      username: "hjaltth",
      gameUrl: game().url,
      fetchFn: mock.fetchFn,
    })
    expect(mock.maxInFlight()).toBe(1)
    for (const h of mock.headersSeen) {
      expect(h["User-Agent"]).toBe(CHESSCOM_USER_AGENT)
    }
  })

  it("URL stored but not in the archive yet (12-24h cache) -> not-found, never a heuristic fallback", async () => {
    const other = game({ url: "https://www.chess.com/game/daily/111" })
    const mock = mockFetch({
      [ARCHIVES_URL]: { archives: [JULY] },
      [JULY]: { games: [other] }, // same opponent, would heuristic-match
    })
    const result = await fetchFinishedGame({
      username: "hjaltth",
      gameUrl: "https://www.chess.com/game/daily/999",
      opponent: "dad",
      fetchFn: mock.fetchFn,
    })
    expect(result).toEqual({ status: "not-found" })
  })

  it("no URL: opponent/date heuristic returns candidates for confirmation, never auto-archives", async () => {
    const old = game({ url: "https://www.chess.com/game/daily/1", end_time: 1_000 })
    const vsOther = game({
      url: "https://www.chess.com/game/daily/2",
      black: { username: "somebody-else" },
    })
    const hit = game({ url: "https://www.chess.com/game/daily/3", end_time: 1_752_100_000 })
    const newerHit = game({
      url: "https://www.chess.com/game/daily/4",
      end_time: 1_752_200_000,
      white: { username: "DAD" }, // opponent match is case-insensitive, either color
      black: { username: "hjaltth" },
    })
    const mock = mockFetch({
      [ARCHIVES_URL]: { archives: [JULY] },
      [JULY]: { games: [old, vsOther, hit, newerHit] },
    })
    const result = await fetchFinishedGame({
      username: "hjaltth",
      opponent: "dad",
      since: 1_752_000_000_000, // ms — excludes `old`
      fetchFn: mock.fetchFn,
    })
    expect(result.status).toBe("needs-confirmation")
    if (result.status === "needs-confirmation") {
      // Newest first, opponent mismatches and too-old games excluded.
      expect(result.candidates.map((g) => g.url)).toEqual([newerHit.url, hit.url])
    }
  })

  it("no candidates at all -> not-found (retry later / manual PGN path)", async () => {
    const mock = mockFetch({
      [ARCHIVES_URL]: { archives: [JULY] },
      [JULY]: { games: [] },
    })
    const result = await fetchFinishedGame({
      username: "hjaltth",
      opponent: "dad",
      fetchFn: mock.fetchFn,
    })
    expect(result).toEqual({ status: "not-found" })
  })

  it("HTTP failure -> error result (429 explains the serial-retry etiquette)", async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 429, json: async () => ({}) })
    const result = await fetchFinishedGame({ username: "hjaltth", fetchFn })
    expect(result.status).toBe("error")
    if (result.status === "error") expect(result.message).toContain("429")
  })

  it("network throw -> error result, never an exception", async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error("offline")
    }
    const result = await fetchFinishedGame({ username: "hjaltth", fetchFn })
    expect(result).toEqual({ status: "error", message: "offline" })
  })

  it("missing username -> error without any request", async () => {
    const mock = mockFetch({})
    const result = await fetchFinishedGame({ username: "  ", fetchFn: mock.fetchFn })
    expect(result.status).toBe("error")
    expect(mock.calls).toEqual([])
  })

  it("matched game without a pgn field -> error, not a silent archive", async () => {
    const noPgn = game()
    delete noPgn.pgn
    const mock = mockFetch({
      [ARCHIVES_URL]: { archives: [JULY] },
      [JULY]: { games: [noPgn] },
    })
    const result = await fetchFinishedGame({
      username: "hjaltth",
      gameUrl: noPgn.url,
      fetchFn: mock.fetchFn,
    })
    expect(result.status).toBe("error")
  })
})

describe("chesscomGameUrl (paste-box URL detection, 2026-07-17)", () => {
  it("canonicalizes daily/live game links, tolerating share params", async () => {
    const { chesscomGameUrl } = await import("../src/chesscom")
    expect(chesscomGameUrl("https://www.chess.com/game/daily/997892824")).toBe(
      "https://www.chess.com/game/daily/997892824",
    )
    expect(chesscomGameUrl("  https://chess.com/game/LIVE/123?ref_id=abc  ")).toBe(
      "https://www.chess.com/game/live/123",
    )
  })

  it("rejects anything that could be actual PGN or other URLs", async () => {
    const { chesscomGameUrl } = await import("../src/chesscom")
    expect(chesscomGameUrl('[Event "x"]\n1. e4 e5')).toBeNull()
    expect(chesscomGameUrl("https://lichess.org/abcd1234")).toBeNull()
    expect(chesscomGameUrl("https://www.chess.com/member/hjaltth")).toBeNull()
    expect(chesscomGameUrl("see https://www.chess.com/game/daily/1 for the game")).toBeNull()
  })
})

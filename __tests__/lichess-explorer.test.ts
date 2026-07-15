import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import {
  clearLichessExplorerCache,
  fetchLichessExplorer,
} from "@/lib/lichess-explorer"

const FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

const SAMPLE_BODY = {
  white: 100,
  draws: 50,
  black: 70,
  moves: [
    { uci: "e2e4", san: "e4", white: 60, draws: 30, black: 40, averageRating: 2150 },
    { uci: "d2d4", san: "d4", white: 40, draws: 20, black: 30 },
  ],
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

describe("Lichess explorer fallback (spec 200)", () => {
  beforeEach(() => {
    clearLichessExplorerCache()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("maps the API response into MoveGroups", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(SAMPLE_BODY)))
    const result = await fetchLichessExplorer(FEN)
    expect(result.total).toBe(220)
    expect(result.moves).toHaveLength(2)
    const e4 = result.moves[0]
    expect(e4).toMatchObject({
      san: "e4",
      uci: "e2e4",
      total: 130,
      whiteWins: 60,
      draws: 30,
      blackWins: 40,
      avgElo: 2150,
      performance: null, // not computable from Lichess aggregates
    })
    expect(result.moves[1].avgElo).toBeNull()
  })

  it("caches per FEN — a repeat query does not refetch", async () => {
    const fetchMock = vi.fn(async () => okResponse(SAMPLE_BODY))
    vi.stubGlobal("fetch", fetchMock)
    await fetchLichessExplorer(FEN)
    await fetchLichessExplorer(FEN)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("rejects with a readable message when offline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch")
      }),
    )
    await expect(fetchLichessExplorer(FEN)).rejects.toThrow(/offline/i)
  })

  it("rejects on HTTP errors and does not cache the failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 } as unknown as Response)
      .mockResolvedValueOnce(okResponse(SAMPLE_BODY))
    vi.stubGlobal("fetch", fetchMock)
    await expect(fetchLichessExplorer(FEN)).rejects.toThrow(/429/)
    // A retry after the failure succeeds (failure was not cached).
    const result = await fetchLichessExplorer(FEN)
    expect(result.total).toBe(220)
  })
})

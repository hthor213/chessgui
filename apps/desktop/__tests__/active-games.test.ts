// Spec 219 C/D: the active-games domain wrapper — persistence through the
// ActiveGamesProvider seam and the archive step's compliance invariant: the
// lockout lifts ONLY after the finished PGN actually reached the game
// database. Providers are injected in-memory (same pattern as kv-store.test).

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest"
import { registerProviders, type PlatformProviders } from "@/lib/platform"
import { browserProviders } from "@/lib/platform/browser"
import {
  engineAllowedForGame,
  newActiveGameRecord,
  type ActiveGameMeta,
} from "@chessgui/core/active-game"
import type { ChesscomGame, FetchLike } from "@chessgui/core/chesscom"
import type { ImportReport } from "@chessgui/core/database-types"
import { GameTree } from "@chessgui/core/game-tree"
import {
  archiveActiveGamePgn,
  deleteActiveGame,
  finishActiveGame,
  getActiveGame,
  loadActiveGames,
  saveActiveGame,
} from "@/lib/active-games"

const PGN = '[Event "Daily"]\n\n1. e4 e5 *'

function meta(overrides: Partial<ActiveGameMeta> = {}): ActiveGameMeta {
  return {
    opponent: "dad",
    chesscomUsername: "hjaltth",
    gameUrl: "https://www.chess.com/game/daily/123456",
    flaggedAt: 1_750_000_000_000,
    ...overrides,
  }
}

function record(id = "g1") {
  return newActiveGameRecord(id, GameTree.create().toJSON(), meta(), 1000)
}

type ImportPgnFn = PlatformProviders["database"]["importPgn"]

let stored: string | null
let importPgn: Mock<ImportPgnFn>

beforeEach(() => {
  stored = null
  importPgn = vi.fn<ImportPgnFn>(
    async (): Promise<ImportReport> => ({ imported: 1, dups_skipped: 0, errors: 0 }),
  )
  registerProviders({
    ...browserProviders,
    activeGames: {
      load: async () => stored,
      save: async (json: string) => void (stored = json),
    },
    database: { ...browserProviders.database, importPgn },
  })
})

describe("active-games store (spec 219 C)", () => {
  it("Continue later: save -> load round-trips the tree, metadata and lock", async () => {
    await saveActiveGame(record())
    const games = await loadActiveGames()
    expect(games).toHaveLength(1)
    expect(games[0].meta.opponent).toBe("dad")
    expect(games[0].archived).toBe(false)
    // The embedded tree still carries the flag — resume re-applies the lockout.
    expect(engineAllowedForGame(games[0].tree.activeGame)).toBe(false)
  })

  it("re-saving the same game updates in place and bumps lastUpdated", async () => {
    const first = await saveActiveGame(record())
    const second = await saveActiveGame({ ...first })
    expect(second.lastUpdated).toBeGreaterThanOrEqual(first.lastUpdated)
    expect(await loadActiveGames()).toHaveLength(1)
  })

  it("deleteActiveGame removes the record", async () => {
    await saveActiveGame(record())
    await deleteActiveGame("g1")
    expect(await loadActiveGames()).toEqual([])
  })

  it("a corrupt store file reads as empty instead of wedging the list", async () => {
    stored = "{corrupt"
    expect(await loadActiveGames()).toEqual([])
  })
})

describe("archive step (spec 219 D — lockout lifts ONLY after DB import)", () => {
  it("successful import marks archived, clears the tree flag, persists", async () => {
    await saveActiveGame(record())
    const { record: archived, report } = await archiveActiveGamePgn(record(), PGN)
    expect(report.imported).toBe(1)
    expect(archived.archived).toBe(true)
    expect(engineAllowedForGame(archived.tree.activeGame ?? null)).toBe(true)
    // Provenance flows into the existing import path.
    expect(importPgn).toHaveBeenCalledWith(
      expect.objectContaining({ source: meta().gameUrl, text: PGN }),
    )
    // Persisted, not just returned.
    expect((await getActiveGame("g1"))?.archived).toBe(true)
  })

  it("failed import throws and leaves the record active and locked", async () => {
    importPgn.mockRejectedValueOnce(new Error("db locked"))
    await saveActiveGame(record())
    await expect(archiveActiveGamePgn(record(), PGN)).rejects.toThrow("db locked")
    const kept = await getActiveGame("g1")
    expect(kept?.archived).toBe(false)
    expect(engineAllowedForGame(kept!.tree.activeGame)).toBe(false)
  })

  it("an import that writes nothing (all errors) does NOT lift the lockout", async () => {
    importPgn.mockResolvedValueOnce({ imported: 0, dups_skipped: 0, errors: 1 })
    await saveActiveGame(record())
    await expect(archiveActiveGamePgn(record(), PGN)).rejects.toThrow(/stays active/)
    expect((await getActiveGame("g1"))?.archived).toBe(false)
  })

  it("a duplicate counts as archived — the game IS in the database", async () => {
    importPgn.mockResolvedValueOnce({ imported: 0, dups_skipped: 1, errors: 0 })
    await saveActiveGame(record())
    const { record: archived } = await archiveActiveGamePgn(record(), PGN)
    expect(archived.archived).toBe(true)
  })

  it("empty manual PGN paste is rejected", async () => {
    await expect(archiveActiveGamePgn(record(), "   ")).rejects.toThrow(/no PGN/)
    expect(importPgn).not.toHaveBeenCalled()
  })
})

describe("finishActiveGame (spec 219 D — Game finished flow)", () => {
  const finished: ChesscomGame = {
    url: meta().gameUrl!,
    pgn: PGN,
    end_time: 1_752_000_000,
    time_class: "daily",
    white: { username: "hjaltth" },
    black: { username: "dad" },
  }

  function fetchReturning(games: ChesscomGame[]): FetchLike {
    return async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith("/archives")
          ? { archives: ["https://api.chess.com/pub/player/hjaltth/games/2026/07"] }
          : { games },
    })
  }

  it("URL match: fetches, imports, archives", async () => {
    await saveActiveGame(record())
    const result = await finishActiveGame(record(), { fetchFn: fetchReturning([finished]) })
    expect(result.status).toBe("archived")
    expect((await getActiveGame("g1"))?.archived).toBe(true)
  })

  it("not in the public archive yet: record stays active and locked", async () => {
    await saveActiveGame(record())
    const result = await finishActiveGame(record(), { fetchFn: fetchReturning([]) })
    expect(result).toEqual({ status: "not-found" })
    const kept = await getActiveGame("g1")
    expect(kept?.archived).toBe(false)
    expect(engineAllowedForGame(kept!.tree.activeGame)).toBe(false)
    expect(importPgn).not.toHaveBeenCalled()
  })

  it("fetch failure: error result, record stays locked", async () => {
    const failing: FetchLike = async () => ({ ok: false, status: 429, json: async () => ({}) })
    await saveActiveGame(record())
    const result = await finishActiveGame(record(), { fetchFn: failing })
    expect(result.status).toBe("error")
    expect((await getActiveGame("g1"))?.archived).toBe(false)
  })

  it("fetched-but-import-fails: error result, lockout intact", async () => {
    importPgn.mockRejectedValueOnce(new Error("disk full"))
    await saveActiveGame(record())
    const result = await finishActiveGame(record(), { fetchFn: fetchReturning([finished]) })
    expect(result.status).toBe("error")
    expect((await getActiveGame("g1"))?.archived).toBe(false)
  })
})

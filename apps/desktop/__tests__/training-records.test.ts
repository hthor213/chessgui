// Spec 226 J: the two artifacts. The archived GAME must be pure — the real
// PGN chess.com served, byte-comparable with the opponent's copy — and
// everything the player thought must land in the training record instead.
//
// Also layer 1 of the doctrine gate as it is reached in practice: through the
// provider seam, with the caller's active-game flag deciding. Layer 2 (the
// Rust refusal) is tested in src-tauri/src/training_records.rs.

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest"
import { registerProviders, type PlatformProviders } from "@/lib/platform"
import { browserProviders } from "@/lib/platform/browser"
import { newActiveGameRecord, type ActiveGameMeta } from "@chessgui/core/active-game"
import type { ImportReport } from "@chessgui/core/database-types"
import { GameTree } from "@chessgui/core/game-tree"
import { treeToPgn } from "@chessgui/core/pgn"
import {
  parseTrainingRecordsStore,
  readTrainingRecordsStore,
  removeTrainingRecord,
  upsertTrainingRecord,
} from "@chessgui/core/training-record"
import {
  archiveActiveGamePgn,
  deleteActiveGame,
  loadActiveGames,
  saveActiveGame,
} from "@/lib/active-games"
import {
  findTrainingDecisionsByPosition,
  getTrainingRecordForGame,
  loadTrainingRecords,
} from "@/lib/training-records"

const GAME_URL = "https://www.chess.com/game/daily/123456"

/** The PGN chess.com actually serves for a finished daily game. */
const SERVED_PGN = [
  '[Event "Let\'s Play!"]',
  '[Site "Chess.com"]',
  '[Date "2026.07.18"]',
  '[White "hjaltth"]',
  '[Black "dad"]',
  '[Result "1-0"]',
  "",
  "1. e4 {[%clk 23:59:47]} e5 {[%clk 23:59:12]} 2. Nf3 1-0",
].join("\n")

function meta(overrides: Partial<ActiveGameMeta> = {}): ActiveGameMeta {
  return {
    opponent: "dad",
    chesscomUsername: "hjaltth",
    gameUrl: GAME_URL,
    flaggedAt: 1_750_000_000_000,
    myColor: "white",
    ...overrides,
  }
}

/** The user's working tree: the game, plus everything they thought about it. */
function workingTree(): GameTree {
  const tree = GameTree.create()
  const root = tree.rootId
  const e4 = tree.addMoveSan("e4")!
  tree.goTo(root)
  const d4 = tree.addMoveSan("d4")!
  tree.setAssessment(e4, 1, "human-live", 1_750_000_100)
  tree.setAssessment(d4, 0, "human-live", 1_750_000_100)
  tree.recordPreference(e4, d4, { reason: "safer king", tags: ["safer king"], at: 1_750_000_200 })
  tree.goTo(e4)
  const e5 = tree.addMoveSan("e5")!
  tree.setLikelihood(e5, 3)
  tree.setAssessment(e5, 1, "human-live", 1_750_000_300)
  tree.goTo(e5)
  tree.addMoveSan("Nf3")
  return tree
}

function record(id = "ag-1") {
  const tree = workingTree()
  return newActiveGameRecord(id, tree.toJSON(), meta(), 1000)
}

type ImportPgnFn = PlatformProviders["database"]["importPgn"]

let activeStored: string | null
let trainingStored: string | null
let importPgn: Mock<ImportPgnFn>

/**
 * The shell, in memory — mirroring the browser fallback and the Rust store:
 * the load redacts, writes are per record against the RAW document, and the
 * by-position query refuses on the core guard.
 */
function trainingProvider(): PlatformProviders["trainingRecords"] {
  return {
    load: async (context: string) => {
      if (trainingStored === null) return null
      return JSON.stringify(
        readTrainingRecordsStore(parseTrainingRecordsStore(trainingStored), context),
      )
    },
    upsert: async (recordJson: string) => {
      const store = upsertTrainingRecord(
        parseTrainingRecordsStore(trainingStored),
        JSON.parse(recordJson),
      )
      trainingStored = JSON.stringify(store)
    },
    remove: async (id: string) => {
      trainingStored = JSON.stringify(removeTrainingRecord(parseTrainingRecordsStore(trainingStored), id))
    },
    queryByPosition: async (fen: string, context: string) => {
      const { queryDecisionsByPosition } = await import("@chessgui/core/training-record")
      return JSON.stringify(
        queryDecisionsByPosition(parseTrainingRecordsStore(trainingStored), fen, context),
      )
    },
  }
}

beforeEach(() => {
  activeStored = null
  trainingStored = null
  importPgn = vi.fn<ImportPgnFn>(
    async (): Promise<ImportReport> => ({ imported: 1, dups_skipped: 0, errors: 0 }),
  )
  registerProviders({
    ...browserProviders,
    activeGames: {
      load: async () => activeStored,
      save: async (json: string) => void (activeStored = json),
    },
    trainingRecords: trainingProvider(),
    database: { ...browserProviders.database, importPgn },
  })
})

describe("archive purity (spec 226 J)", () => {
  it("archives the PGN chess.com served, byte-identical", async () => {
    await archiveActiveGamePgn(record(), SERVED_PGN)
    expect(importPgn).toHaveBeenCalledTimes(1)
    expect(importPgn.mock.calls[0][0].text).toBe(SERVED_PGN)
  })

  it("the archived PGN carries NO notebook content", async () => {
    await archiveActiveGamePgn(record(), SERVED_PGN)
    const text = importPgn.mock.calls[0][0].text
    expect(text).not.toContain("[%lik")
    expect(text).not.toContain("[%prov")
    expect(text).not.toContain("[%src")
    // The user assessed e4 as ⩲ ($14) and d4 as = ($10). Neither reached the
    // archive, and neither did the head-to-head.
    expect(text).not.toContain("$14")
    expect(text).not.toContain("$10")
    expect(text).not.toContain("safer king")
    // Nor did the variation the user analysed but never played.
    expect(text).not.toContain("d4")
  })

  it("the test would catch a regression: the working tree DOES carry it", () => {
    // Guards the test above from passing vacuously. Serializing the tree is
    // exactly what the archive path must never do, and this is what it would
    // have produced if it did.
    const pgn = treeToPgn(workingTree())
    expect(pgn).toContain("[%lik")
    expect(pgn).toContain("[%prov")
    expect(pgn).toContain("$14")
  })

  it("refuses outright if a contaminated PGN ever reaches the archive path", async () => {
    const dirty = SERVED_PGN.replace("1. e4", "1. e4 {[%prov human-live,1750000100]}")
    await expect(archiveActiveGamePgn(record(), dirty)).rejects.toThrow(/notebook tags/i)
    // Refused BEFORE the import: a laundered archive is worse than none.
    expect(importPgn).not.toHaveBeenCalled()
  })

  it("refuses a working-tree serialization even with no notebook tag in it", async () => {
    // The reachable path: Export (treeToPgn) → paste into the archive box. The
    // three notebook tags are the LEAST of what comes with it — the analysis
    // variations carry no tag at all, and they are the bulk of the leak.
    const serialized = treeToPgn(workingTree()).replace(/\[%(?:lik|prov|src)[^\]]*\]/g, "")
    expect(serialized).toContain("(") // still carries the d4 variation
    await expect(archiveActiveGamePgn(record(), serialized)).rejects.toThrow(/variations/i)
    expect(importPgn).not.toHaveBeenCalled()
  })

  it("refuses bare assessment NAGs — the annotation bar never stamps provenance", async () => {
    const dirty = SERVED_PGN.replace("1. e4", "1. e4 $14")
    await expect(archiveActiveGamePgn(record(), dirty)).rejects.toThrow(/NAG/i)
    expect(importPgn).not.toHaveBeenCalled()
  })

  it("a header or a comment with a bracket is not contamination", async () => {
    // The check reads the movetext only: a real event name and chess.com's own
    // clock comments must not read as analysis.
    const ok = SERVED_PGN.replace('[Event "Let\'s Play!"]', '[Event "Team Match (round 2)"]')
    await expect(archiveActiveGamePgn(record(), ok)).resolves.toBeTruthy()
  })

  it("the second door into the games table is guarded too", async () => {
    // Save-to-database serializes the WORKING TREE and upserts on the mainline
    // hash — so without this it would overwrite the archived game's pure
    // movetext with the notebook's.
    const { saveGame } = await import("@/lib/database")
    await expect(saveGame({ pgn: treeToPgn(workingTree()) })).rejects.toThrow(/notebook content/i)
  })

  it("still rescues missing player headers on a hand-pasted PGN", async () => {
    await archiveActiveGamePgn(record(), "1. e4 e5 *")
    const text = importPgn.mock.calls[0][0].text
    expect(text).toContain('[White "hjaltth"]')
    expect(text).toContain('[Black "dad"]')
  })
})

describe("the training record is written beside it (spec 226 J)", () => {
  it("lands in its OWN store, pointing at the archived game", async () => {
    await archiveActiveGamePgn(record(), SERVED_PGN)
    const records = await loadTrainingRecords()
    expect(records).toHaveLength(1)
    expect(records[0].game.gameUrl).toBe(GAME_URL)
    expect(records[0].game.activeGameId).toBe("ag-1")
    // The pointer, not the game: no PGN anywhere in the document.
    expect(JSON.stringify(records[0])).not.toContain("[Event")
  })

  it("holds the candidate sets, assessments, likelihoods and preferences", async () => {
    await archiveActiveGamePgn(record(), SERVED_PGN)
    const rec = (await getTrainingRecordForGame({ gameUrl: GAME_URL }))!
    const start = rec.decisions.find((d) => d.ply === 0)!
    expect(start.candidates.map((c) => c.san).sort()).toEqual(["d4", "e4"])
    expect(start.candidates.find((c) => c.san === "e4")!.assessment).toBe(1)
    expect(start.candidates.find((c) => c.san === "e4")!.assessedBy).toBe("human-live")
    expect(start.preferences[0].reason).toBe("safer king")
    expect(start.preferences[0].tags).toEqual(["safer king"])
    const afterE4 = rec.decisions.find((d) => d.line.join(" ") === "e4")!
    expect(afterE4.candidates.find((c) => c.san === "e5")!.likelihood).toBe(3)
  })

  it("keeps the position at each decision, so blind spots stay recoverable", async () => {
    await archiveActiveGamePgn(record(), SERVED_PGN)
    // Outside a fair-play game the positions come with it — that is what makes
    // the post-game pass able to work out what was never on the list.
    const rec = (await getTrainingRecordForGame({ activeGameId: "ag-1" }, null))!
    for (const d of rec.decisions) expect(d.fen).toMatch(/ [wb] /)
  })

  it("the manual PGN paste is the same path — pure game, record beside it", async () => {
    // The paste fallback (no chess.com match) goes through archiveActiveGamePgn
    // exactly as the fetched game does, so both artifacts must land the same way.
    const pasted = "1. e4 e5 2. Nf3 *"
    const { training } = await archiveActiveGamePgn(record(), pasted)
    expect(training.status).toBe("written")
    const text = importPgn.mock.calls[0][0].text
    // Headers were rescued; nothing from the notebook came with them.
    expect(text).toContain('[White "hjaltth"]')
    expect(text).not.toContain("[%lik")
    expect(text).not.toContain("$14")
    const rec = (await getTrainingRecordForGame({ activeGameId: "ag-1" }))!
    expect(rec.decisions.length).toBeGreaterThan(0)
  })

  it("reports what became of it, so the archive can say so in one line", async () => {
    const { training } = await archiveActiveGamePgn(record(), SERVED_PGN)
    expect(training).toMatchObject({ status: "written", id: "tr-ag-1" })
    if (training.status === "written") expect(training.decisions).toBeGreaterThan(0)
  })

  it("a training-record failure does not undo a lawful archive", async () => {
    registerProviders({
      ...browserProviders,
      activeGames: {
        load: async () => activeStored,
        save: async (json: string) => void (activeStored = json),
      },
      trainingRecords: {
        ...trainingProvider(),
        upsert: async () => {
          throw new Error("disk full")
        },
      },
      database: { ...browserProviders.database, importPgn },
    })
    const { record: archived, training } = await archiveActiveGamePgn(record(), SERVED_PGN)
    expect(archived.archived).toBe(true)
    expect(training).toMatchObject({ status: "failed" })
  })
})

describe("the two artifacts have different lifetimes (spec 226 J)", () => {
  it("removing the game row leaves the training record standing", async () => {
    await archiveActiveGamePgn(record(), SERVED_PGN)
    // "Remove" on an archived row, and the fair-play discard, are the same
    // call — neither says anything about how the player thought.
    await deleteActiveGame("ag-1")
    expect(await loadActiveGames()).toHaveLength(0)
    const kept = await loadTrainingRecords()
    expect(kept).toHaveLength(1)
    // Still pointing at the archived game, which is where it lived all along.
    expect(kept[0].game.gameUrl).toBe(GAME_URL)
  })

  it("discarding a game that never archived has no record to strand", async () => {
    await saveActiveGame(record("ag-2"))
    await deleteActiveGame("ag-2")
    expect(await loadTrainingRecords()).toHaveLength(0)
  })
})

describe("the record describes the game AS PLAYED (spec 226 H/J)", () => {
  /** The working tree as it stands when the last live sync is stale: the board
   *  knows 1.e4 and the replies the user weighed, not the moves since. */
  function staleRecord() {
    const tree = GameTree.create()
    const e4 = tree.addMoveSan("e4")!
    const c5 = tree.addMoveSan("c5")! // an opponent reply the user expected
    tree.setLikelihood(c5, 3)
    tree.setAssessment(c5, 1, "human-live", 1_750_000_400)
    tree.goTo(e4)
    return newActiveGameRecord(
      "ag-1",
      tree.toJSON(),
      meta({ liveNodeId: e4 }),
      1000,
    )
  }

  it("recovers the decisions played after the last sync", async () => {
    await archiveActiveGamePgn(staleRecord(), SERVED_PGN)
    const rec = (await getTrainingRecordForGame({ activeGameId: "ag-1" }, null))!
    const lines = rec.decisions.map((d) => d.line.join(" "))
    // Without reconciling against the archived PGN the tree stops at 1.e4 and
    // the last decisions — often the decisive ones — are simply absent.
    expect(lines).toContain("e4 e5")
  })

  it("marks what the opponent really played, which is the opponent-model signal", async () => {
    await archiveActiveGamePgn(staleRecord(), SERVED_PGN)
    const rec = (await getTrainingRecordForGame({ activeGameId: "ag-1" }, null))!
    const afterE4 = rec.decisions.find((d) => d.line.join(" ") === "e4")!
    expect(afterE4.played).toBe(true)
    expect(afterE4.playedMove?.san).toBe("e5")
    // He played something the user never judged — recorded, not classified.
    expect(afterE4.playedMove?.wasAssessed).toBe(false)
    // And the reply the user DID weigh is still on the candidate list:
    // reconciliation must not prune the exploration it exists to preserve.
    expect(afterE4.candidates.map((c) => c.san)).toContain("c5")
    expect(afterE4.candidates.find((c) => c.san === "c5")!.likelihood).toBe(3)
  })
})

describe("the doctrine gate through the provider seam (spec 226 G/J, layer 1)", () => {
  it("refuses a by-position query while a game is active", async () => {
    await archiveActiveGamePgn(record(), SERVED_PGN)
    const rec = (await getTrainingRecordForGame({ activeGameId: "ag-1" }, null))!
    const fen = rec.decisions[0].fen
    await expect(findTrainingDecisionsByPosition(fen, meta())).rejects.toThrow(/fair play/i)
  })

  it("refuses when the caller could not tell which game it was serving", async () => {
    await archiveActiveGamePgn(record(), SERVED_PGN)
    const rec = (await getTrainingRecordForGame({ activeGameId: "ag-1" }, null))!
    await expect(findTrainingDecisionsByPosition(rec.decisions[0].fen, undefined)).rejects.toThrow()
  })

  it("refuses even when the shell behind it would happily answer", async () => {
    // The one test that actually pins layer 1. A guard that only runs inside
    // the provider is a property of whichever provider is registered — on the
    // desktop path that is a thin invoke forwarder, which would leave Rust as
    // the only refusal in the app.
    await archiveActiveGamePgn(record(), SERVED_PGN)
    const rec = (await getTrainingRecordForGame({ activeGameId: "ag-1" }, null))!
    const fen = rec.decisions[0].fen
    registerProviders({
      ...browserProviders,
      activeGames: {
        load: async () => activeStored,
        save: async (json: string) => void (activeStored = json),
      },
      trainingRecords: {
        ...trainingProvider(),
        queryByPosition: async () => JSON.stringify([{ leaked: true }]),
      },
      database: { ...browserProviders.database, importPgn },
    })
    await expect(findTrainingDecisionsByPosition(fen, meta())).rejects.toThrow(/fair play/i)
  })

  it("allows it outside a fair-play game — it is a post-game instrument", async () => {
    await archiveActiveGamePgn(record(), SERVED_PGN)
    const rec = (await getTrainingRecordForGame({ activeGameId: "ag-1" }, null))!
    const hits = await findTrainingDecisionsByPosition(rec.decisions[0].fen, null)
    expect(hits).toHaveLength(1)
  })
})

describe("the bulk read is not a back door (spec 226 G/J)", () => {
  it("hands over no position index inside a fair-play game", async () => {
    await archiveActiveGamePgn(record(), SERVED_PGN)
    const records = await loadTrainingRecords(meta())
    expect(records).toHaveLength(1)
    // The join key is gone: `records.flatMap(r => r.decisions).find(d => d.fen
    // === liveFen)` is the query the gate refuses, done in one call.
    for (const d of records[0].decisions) {
      expect(d.fen).toBe("")
      for (const c of d.candidates) expect(c.fen).toBe("")
    }
    // Everything the linear read is FOR survives.
    const start = records[0].decisions.find((d) => d.ply === 0)!
    expect(start.candidates.map((c) => c.san).sort()).toEqual(["d4", "e4"])
    expect(start.preferences[0].reason).toBe("safer king")
  })

  it("redacts when the caller could not say where it was standing", async () => {
    await archiveActiveGamePgn(record(), SERVED_PGN)
    const records = await loadTrainingRecords()
    expect(records[0].decisions.every((d) => d.fen === "")).toBe(true)
  })

  it("post-game, the positions come back — that is what the tag unlocks", async () => {
    await archiveActiveGamePgn(record(), SERVED_PGN)
    const records = await loadTrainingRecords(null)
    expect(records[0].decisions.every((d) => d.fen.includes(" "))).toBe(true)
  })

  it("a redacted read can never be written back over the real positions", async () => {
    // The hazard a whole-document save would create: load (redacted) → modify
    // → save would erase every FEN in the store permanently. Writes are per
    // record and the shell does the read-modify-write, so archiving a second
    // game after a redacted read leaves the first game's positions intact.
    await archiveActiveGamePgn(record(), SERVED_PGN)
    await loadTrainingRecords(meta()) // the redacted read
    await archiveActiveGamePgn(record("ag-2"), SERVED_PGN)
    const all = await loadTrainingRecords(null)
    expect(all).toHaveLength(2)
    for (const r of all) expect(r.decisions.every((d) => d.fen.includes(" "))).toBe(true)
  })
})

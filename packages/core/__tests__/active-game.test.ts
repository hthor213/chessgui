// Spec 219 B: the engine-lockout guard predicate and its context tags, plus
// the pure active-games store operations. The predicate is THE enforcement
// point (hooks/use-engine.ts checks it before any start/go); these tests pin
// the conservative semantics — ambiguity resolves to engine OFF.

import { describe, it, expect } from "vitest"
import {
  ACTIVE_GAME_CONTEXT_PREFIX,
  UNRESTRICTED_ENGINE_CONTEXT,
  emptyActiveGamesStore,
  engineAllowedForGame,
  engineContextTag,
  findActiveGame,
  isLockedEngineContext,
  markActiveGameArchived,
  newActiveGameRecord,
  parseActiveGamesStore,
  removeActiveGame,
  upsertActiveGame,
  withActiveGameFlag,
  type ActiveGameMeta,
} from "@chessgui/core/active-game"
import { GameTree } from "@chessgui/core/game-tree"

function meta(overrides: Partial<ActiveGameMeta> = {}): ActiveGameMeta {
  return {
    opponent: "dad",
    chesscomUsername: "hjaltth",
    gameUrl: "https://www.chess.com/game/daily/123456",
    flaggedAt: 1_750_000_000_000,
    ...overrides,
  }
}

describe("engineAllowedForGame (spec 219 B guard predicate)", () => {
  it("allows the engine only for a KNOWN non-active game", () => {
    expect(engineAllowedForGame(null)).toBe(true)
  })

  it("locks flagged games", () => {
    expect(engineAllowedForGame(meta())).toBe(false)
  })

  it("resolves ambiguity to OFF (undefined = caller could not determine its game)", () => {
    expect(engineAllowedForGame(undefined)).toBe(false)
  })
})

describe("engine context tags (layer-2 handshake with the Rust refusal)", () => {
  it("tags unlocked contexts as unrestricted", () => {
    expect(engineContextTag(null)).toBe(UNRESTRICTED_ENGINE_CONTEXT)
  })

  it("tags flagged and ambiguous contexts with the active-game prefix", () => {
    expect(engineContextTag(meta()).startsWith(ACTIVE_GAME_CONTEXT_PREFIX)).toBe(true)
    expect(engineContextTag(undefined).startsWith(ACTIVE_GAME_CONTEXT_PREFIX)).toBe(true)
  })

  it("isLockedEngineContext mirrors the Rust prefix rule exactly", () => {
    // Locked: every tag engineContextTag emits for a non-allowed context.
    expect(isLockedEngineContext(engineContextTag(meta()))).toBe(true)
    expect(isLockedEngineContext(engineContextTag(undefined))).toBe(true)
    expect(isLockedEngineContext("active-game")).toBe(true)
    // Allowed: unrestricted, untagged, and non-prefix lookalikes.
    expect(isLockedEngineContext(UNRESTRICTED_ENGINE_CONTEXT)).toBe(false)
    expect(isLockedEngineContext(null)).toBe(false)
    expect(isLockedEngineContext(undefined)).toBe(false)
    expect(isLockedEngineContext("")).toBe(false)
    expect(isLockedEngineContext("not-an-active-game")).toBe(false)
  })

  it("the guard and the tag can never disagree", () => {
    for (const ctx of [null, undefined, meta()] as const) {
      expect(engineAllowedForGame(ctx)).toBe(!isLockedEngineContext(engineContextTag(ctx)))
    }
  })
})

describe("flag persistence on the serialized game (spec 219 How)", () => {
  it("survives a serialize/deserialize round-trip so every load path re-applies it", () => {
    const tree = GameTree.create()
    tree.activeGame = meta()
    const loaded = GameTree.fromJSON(JSON.parse(JSON.stringify(tree.toJSON())))
    expect(loaded.activeGame).toEqual(meta())
    expect(engineAllowedForGame(loaded.activeGame)).toBe(false)
  })

  it("normalizes pre-219 saves (no flag key) to a known non-active game", () => {
    const serialized = GameTree.create().toJSON()
    expect("activeGame" in serialized).toBe(false)
    const loaded = GameTree.fromJSON(serialized)
    expect(loaded.activeGame).toBeNull()
    expect(engineAllowedForGame(loaded.activeGame)).toBe(true)
  })

  it("withActiveGameFlag sets and clears without mutating the input", () => {
    const base = GameTree.create().toJSON()
    const flagged = withActiveGameFlag(base, meta())
    expect(flagged.activeGame).toEqual(meta())
    expect(base.activeGame).toBeUndefined()
    const cleared = withActiveGameFlag(flagged, null)
    expect("activeGame" in cleared).toBe(false)
  })
})

describe("active-games store operations (spec 219 C/D)", () => {
  it("parses garbage, wrong shapes and null to an empty store", () => {
    expect(parseActiveGamesStore(null)).toEqual(emptyActiveGamesStore())
    expect(parseActiveGamesStore("not json{{{")).toEqual(emptyActiveGamesStore())
    expect(parseActiveGamesStore('{"v":99,"games":[]}')).toEqual(emptyActiveGamesStore())
    expect(parseActiveGamesStore('{"v":1,"games":"nope"}')).toEqual(emptyActiveGamesStore())
  })

  it("upsert replaces by id and keeps newest-updated first", () => {
    const tree = GameTree.create().toJSON()
    const a = newActiveGameRecord("a", tree, meta({ opponent: "a" }), 1000)
    const b = newActiveGameRecord("b", tree, meta({ opponent: "b" }), 2000)
    let store = upsertActiveGame(emptyActiveGamesStore(), a, 1000)
    store = upsertActiveGame(store, b, 2000)
    expect(store.games.map((g) => g.id)).toEqual(["b", "a"])
    // "Continue later" on a again bumps it to the top, without duplicating.
    store = upsertActiveGame(store, a, 3000)
    expect(store.games.map((g) => g.id)).toEqual(["a", "b"])
    expect(findActiveGame(store, "a")?.lastUpdated).toBe(3000)
  })

  it("newActiveGameRecord stamps the embedded tree so resume re-locks", () => {
    const rec = newActiveGameRecord("g1", GameTree.create().toJSON(), meta())
    expect(rec.archived).toBe(false)
    expect(rec.archivedAt).toBeNull()
    expect(engineAllowedForGame(rec.tree.activeGame)).toBe(false)
  })

  it("markActiveGameArchived is the ONLY transition that lifts the lockout", () => {
    const rec = newActiveGameRecord("g1", GameTree.create().toJSON(), meta(), 1000)
    const done = markActiveGameArchived(rec, 5000)
    expect(done.archived).toBe(true)
    expect(done.archivedAt).toBe(5000)
    // The embedded tree's flag is cleared — reopening gets the engine back.
    expect(done.tree.activeGame ?? null).toBeNull()
    expect(engineAllowedForGame(done.tree.activeGame ?? null)).toBe(true)
    // The input record stays locked (no in-place mutation).
    expect(rec.archived).toBe(false)
    expect(engineAllowedForGame(rec.tree.activeGame)).toBe(false)
  })

  it("removeActiveGame deletes by id", () => {
    const rec = newActiveGameRecord("g1", GameTree.create().toJSON(), meta())
    const store = upsertActiveGame(emptyActiveGamesStore(), rec)
    expect(removeActiveGame(store, "g1").games).toEqual([])
    expect(removeActiveGame(store, "other").games).toHaveLength(1)
  })
})

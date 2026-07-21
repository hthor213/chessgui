// Active-games domain wrapper (spec 219 C/D): the I/O half of Active Game
// Mode. Persists the list through the ActiveGamesProvider seam, fetches the
// finished game from chess.com's public API (core/chesscom.ts), and runs the
// archive step through the existing PGN import path (spec 200 database).
//
// The compliance invariant lives here: a record's `archived` flag — the only
// thing that lifts the engine lockout — flips true ONLY after the finished
// PGN has actually been written to the game database. Every failure path
// (fetch miss, 12–24h archive cache, import error) leaves the record active
// and locked, with retry or manual-PGN paste as the ways forward.

import {
  findActiveGame,
  markActiveGameArchived,
  parseActiveGamesStore,
  removeActiveGame,
  upsertActiveGame,
  withActiveGameFlag,
  type ActiveGameMeta,
  type ActiveGameRecord,
  type ActiveGamesStore,
} from "@chessgui/core/active-game"
import {
  CHESSCOM_USER_AGENT,
  fetchFinishedGame,
  fetchOngoingGames,
  matchOngoingGame,
  ongoingGameColorFor,
  type ChesscomGame,
  type ChesscomOngoingGame,
  type FetchLike,
} from "@chessgui/core/chesscom"
import { GameTree } from "@chessgui/core/game-tree"
import { syncLiveLine } from "@chessgui/core/live-sync"
import { ensurePlayerHeaders } from "@chessgui/core/identity"
import type { ImportReport } from "@chessgui/core/database-types"
import { getProviders } from "@/lib/platform"
import { importPgn } from "@/lib/database"

/**
 * Store id for the record backing an open flagged game. Derived from the
 * flag's own timestamp so the board and the list agree on identity without
 * threading a separate id through the tree: flagging, "Continue later",
 * archive, and deletion all address the same record.
 */
export function activeGameIdFor(meta: ActiveGameMeta): string {
  return `ag-${meta.flaggedAt}`
}

// The user's own chess.com username, remembered per shell so the setup
// dialog's field defaults to it (spec 219 A). Seeded with the primary
// account; overwritten by whatever was last used when flagging a game.
const CHESSCOM_USERNAME_KEY = "chessgui-chesscom-username"
const FALLBACK_CHESSCOM_USERNAME = "hjaltth"

export function loadDefaultChesscomUsername(): string {
  return (
    getProviders().storage.get(CHESSCOM_USERNAME_KEY) || FALLBACK_CHESSCOM_USERNAME
  )
}

export function saveDefaultChesscomUsername(username: string): void {
  const trimmed = username.trim()
  if (trimmed) getProviders().storage.set(CHESSCOM_USERNAME_KEY, trimmed)
}

/**
 * chess.com fetches routed through Rust (spec 219 D/F).
 *
 * A direct webview fetch to api.chess.com fails with WebKit's opaque
 * "Load failed" — it's a cross-origin request from tauri://localhost
 * (user-reported 2026-07-20). The Rust command also sends the descriptive
 * User-Agent chess.com asks for, which a browser would strip. This is the
 * `FetchLike` seam core/chesscom.ts was built around; tests still inject
 * their own.
 */
const tauriChesscomFetch: FetchLike = async (url, init) => {
  const { invoke } = await import("@tauri-apps/api/core")
  const res = await invoke<{ ok: boolean; status: number; body: string }>("chesscom_get", {
    url,
    userAgent: init.headers["User-Agent"] ?? CHESSCOM_USER_AGENT,
  })
  return {
    ok: res.ok,
    status: res.status,
    json: async () => JSON.parse(res.body),
  }
}

async function loadStore(): Promise<ActiveGamesStore> {
  const raw = await getProviders().activeGames.load()
  return parseActiveGamesStore(raw)
}

async function persistStore(store: ActiveGamesStore): Promise<void> {
  await getProviders().activeGames.save(JSON.stringify(store))
}

/** All saved records, newest-updated first (archived ones included so the
 *  list UI can show/clear them; filter on `archived` for the active list). */
export async function loadActiveGames(): Promise<ActiveGameRecord[]> {
  return (await loadStore()).games
}

export async function getActiveGame(id: string): Promise<ActiveGameRecord | null> {
  return findActiveGame(await loadStore(), id)
}

/** "Continue later" (spec 219 C): upsert the record, stamping lastUpdated. */
export async function saveActiveGame(record: ActiveGameRecord): Promise<ActiveGameRecord> {
  const now = Date.now()
  await persistStore(upsertActiveGame(await loadStore(), record, now))
  return { ...record, lastUpdated: now }
}

/**
 * Set (or change) which side the user plays on a saved game — the migration
 * path for games flagged before `myColor` existed. Writes it to both the list
 * metadata and the embedded tree's flag so resume orientation follows either
 * source.
 */
export async function setActiveGameMyColor(
  record: ActiveGameRecord,
  myColor: "white" | "black",
): Promise<ActiveGameRecord> {
  const meta: ActiveGameMeta = { ...record.meta, myColor }
  return saveActiveGame({ ...record, meta, tree: withActiveGameFlag(record.tree, meta) })
}

/**
 * Explicit deletion — the ONLY exit besides archiving (spec 219 B). The UI
 * must gate this behind the fair-play confirmation dialog; nothing here
 * softens that, deletion just removes the record.
 */
export async function deleteActiveGame(id: string): Promise<void> {
  await persistStore(removeActiveGame(await loadStore(), id))
}

/**
 * The archive step (spec 219 D): write the finished game's PGN into the
 * game database via the existing import path, and only on success mark the
 * record archived — which clears the embedded tree's active flag and lifts
 * the engine lockout. Used for both the fetched PGN and a manually pasted
 * one. Throws (record untouched, lockout intact) when the import fails or
 * imports nothing new; a duplicate counts as success — the game IS in the
 * database, which is all the lockout exit requires.
 */
export async function archiveActiveGamePgn(
  record: ActiveGameRecord,
  pgn: string,
): Promise<{ record: ActiveGameRecord; report: ImportReport }> {
  if (!pgn.trim()) throw new Error("no PGN to archive")
  const meta = record.meta
  // Give the archived game sensible White/Black names when the PGN lacks them,
  // so a later load can orient the board to the user's side by identity (spec
  // 225). Fetched chess.com PGNs already carry real usernames — this only
  // rescues a header-less pasted game.
  let text = pgn
  if (meta.myColor && (meta.chesscomUsername || meta.opponent)) {
    const me = meta.chesscomUsername || undefined
    const them = meta.opponent || undefined
    text = ensurePlayerHeaders(pgn, {
      white: meta.myColor === "white" ? me : them,
      black: meta.myColor === "white" ? them : me,
    })
  }
  const source = meta.gameUrl ?? `chess.com daily vs ${meta.opponent || "?"}`
  const report = await importPgn({ source, text })
  if (report.imported < 1 && report.dups_skipped < 1) {
    throw new Error(
      `archive import wrote nothing (${report.errors} error${report.errors === 1 ? "" : "s"}) — game stays active and locked`,
    )
  }
  const archived = markActiveGameArchived(record)
  await persistStore(upsertActiveGame(await loadStore(), archived, archived.lastUpdated))
  return { record: archived, report }
}

// ---- the live-position sync (spec 219 F) ----

export type SyncActiveGameResult =
  /** Pointer refreshed. `record` is persisted and carries the updated tree,
   *  liveNodeId, myColor and gameUrl. */
  | {
      status: "synced"
      record: ActiveGameRecord
      plies: number
      /** Real moves that were new to the board since the last sync. */
      added: number
      /** Dead exploration branches cleared from behind the live position. */
      pruned: number
      turn: string | null
    }
  /** The game is no longer among the account's ongoing games — it ended.
   *  The pointer is left untouched; the user is pointed at "Game finished". */
  | { status: "ended" }
  /** Couldn't identify which ongoing game this record refers to (no stored
   *  URL and an ambiguous or absent opponent match). */
  | { status: "ambiguous"; candidates: ChesscomOngoingGame[] }
  /** Fetch or replay failed. Record untouched — a wrong live pointer is
   *  worse than a stale one. */
  | { status: "error"; message: string }

/**
 * Refresh a fair-play game against chess.com (spec 219 F): fetch the account's
 * ongoing daily games, find this one, replay its real move list into the saved
 * tree, and pin `liveNodeId` to the tip.
 *
 * Also settles two things the user should never have to state by hand:
 * `myColor` (so the board opens on their side) and `gameUrl` (so every later
 * sync and the eventual "Game finished" fetch match exactly). Persists through
 * the same reload/apply/persist path as every other mutator — the store is not
 * reactive, so nothing here can rely on an in-memory write reaching disk.
 */
export async function syncActiveGameLivePosition(
  record: ActiveGameRecord,
  opts: { fetchFn?: FetchLike } = {},
): Promise<SyncActiveGameResult> {
  const username = record.meta.chesscomUsername
  const fetched = await fetchOngoingGames({
    username,
    fetchFn: opts.fetchFn ?? tauriChesscomFetch,
  })
  if (fetched.status === "error") return { status: "error", message: fetched.message }

  const game = matchOngoingGame(fetched.games, {
    gameUrl: record.meta.gameUrl,
    opponent: record.meta.opponent,
    username,
  })
  if (!game) {
    // A stored URL that's absent from the ongoing list means the game is over.
    // Without a URL we can't distinguish "ended" from "couldn't tell which" —
    // so only claim it ended when we had an exact key to look for.
    if (record.meta.gameUrl) return { status: "ended" }
    return fetched.games.length === 0
      ? { status: "ended" }
      : { status: "ambiguous", candidates: fetched.games }
  }
  if (!game.pgn) {
    return { status: "error", message: `chess.com returned ${game.url} with no PGN` }
  }

  const synced = syncLiveLine(GameTree.fromJSON(record.tree), game.pgn)
  if (synced.status === "error") return { status: "error", message: synced.message }
  // Use the tree the sync returns — it may have adopted the real game's start
  // position wholesale rather than mutating the one passed in.
  const tree = synced.tree

  const meta: ActiveGameMeta = {
    ...record.meta,
    liveNodeId: synced.report.liveNodeId,
    liveSyncedAt: Date.now(),
    gameUrl: record.meta.gameUrl ?? game.url,
    myColor: ongoingGameColorFor(game, username) ?? record.meta.myColor,
  }
  const saved = await saveActiveGame({
    ...record,
    meta,
    tree: withActiveGameFlag(tree.toJSON(), meta),
  })
  return {
    status: "synced",
    record: saved,
    plies: synced.report.plies,
    added: synced.report.added,
    pruned: synced.report.pruned,
    turn: game.turn ?? null,
  }
}

export type FinishActiveGameResult =
  /** Fetched, imported, lockout lifted. */
  | { status: "archived"; record: ActiveGameRecord; report: ImportReport }
  /** Heuristic candidates — user must confirm one (then call
   *  archiveActiveGamePgn with the chosen candidate's pgn). */
  | { status: "needs-confirmation"; candidates: ChesscomGame[] }
  /** Not in the public archive yet (cached 12–24h) — retry later or paste
   *  the PGN manually. Record unchanged, still locked. */
  | { status: "not-found" }
  /** Fetch or import failed. Record unchanged, still locked. */
  | { status: "error"; message: string }

/**
 * "Game finished" (spec 219 D): fetch the real game from chess.com
 * (archives → month JSON, serial requests) and archive it. Only an
 * unambiguous match (stored game URL) archives automatically; heuristic
 * matches come back for user confirmation. `fetchFn` is injectable for
 * tests and shell-specific transports.
 */
export async function finishActiveGame(
  record: ActiveGameRecord,
  opts: { fetchFn?: FetchLike } = {},
): Promise<FinishActiveGameResult> {
  const result = await fetchFinishedGame({
    username: record.meta.chesscomUsername,
    gameUrl: record.meta.gameUrl,
    opponent: record.meta.opponent || null,
    since: record.meta.flaggedAt,
    // Same webview cross-origin problem as the live sync — this path would
    // have failed with "Load failed" too (never caught because the spec's
    // smoke test was a curl, not an in-app run).
    fetchFn: opts.fetchFn ?? tauriChesscomFetch,
  })
  if (result.status !== "matched") return result
  try {
    const { record: archived, report } = await archiveActiveGamePgn(record, result.pgn)
    return { status: "archived", record: archived, report }
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) }
  }
}

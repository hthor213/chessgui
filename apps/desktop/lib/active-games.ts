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
  fetchFinishedGame,
  type ChesscomGame,
  type FetchLike,
} from "@chessgui/core/chesscom"
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
    fetchFn: opts.fetchFn,
  })
  if (result.status !== "matched") return result
  try {
    const { record: archived, report } = await archiveActiveGamePgn(record, result.pgn)
    return { status: "archived", record: archived, report }
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) }
  }
}

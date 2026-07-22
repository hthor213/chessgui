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
//
// Spec 226 J adds the second invariant: what gets archived is the PGN
// chess.com SERVED, never a re-serialization of the user's working tree. The
// game is a historical fact shared with the opponent and must stay
// byte-comparable with his copy. Everything the user thought goes to the
// training record instead (lib/training-records.ts), which points at the
// archived game and never lives inside it.

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
import { archivePgnImpurity } from "@chessgui/core/annotations"
import { GameTree } from "@chessgui/core/game-tree"
import { pruneBehindLive, syncLiveLine } from "@chessgui/core/live-sync"
import { ensurePlayerHeaders } from "@chessgui/core/identity"
import type { ImportReport } from "@chessgui/core/database-types"
import { getProviders } from "@/lib/platform"
import { importPgn } from "@/lib/database"
import {
  extractTrainingRecord,
  mergeDecisionLog,
  playerRefFrom,
} from "@chessgui/core/training-record"
import { recordTrainingForArchivedGame } from "@/lib/training-records"

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
 *
 * It deliberately does NOT touch the training store (spec 226 J), and that is
 * a judgement call rather than an oversight, so here is the argument. The two
 * artifacts have different owners: the game belongs to both players, the
 * training record belongs only to this one. Deleting an active-game row says
 * something about the GAME — "this was never real", or "it is archived and I
 * want it out of my list" — and neither of those is a statement about how the
 * player thought. The record also points at the archived game rather than at
 * this row, so it is not orphaned by the row going away; cascading would
 * silently destroy cross-game evidence (spec 226 J's whole reason for a
 * separate store) as a side effect of tidying a list. The reverse mistake is
 * cheap to fix: an unwanted record is one explicit `deleteTrainingRecord`
 * away, while a deleted one is gone for good.
 *
 * In practice the discard path finds nothing to cascade anyway — a training
 * record only exists once a game has archived — so the rule bites exactly
 * where it should: "Remove" on an already-archived row keeps the notes.
 */
export async function deleteActiveGame(id: string): Promise<void> {
  await persistStore(removeActiveGame(await loadStore(), id))
}

/**
 * What became of the second artifact during an archive (spec 226 J). Reported
 * rather than thrown, because it must never look like the archive failed:
 * a `failed` here still means the game reached the database and the lockout
 * lifted lawfully.
 */
export type TrainingRecordOutcome =
  | { status: "written"; id: string; decisions: number }
  | { status: "failed"; message: string }

/**
 * The archive step (spec 219 D): write the finished game's PGN into the
 * game database via the existing import path, and only on success mark the
 * record archived — which clears the embedded tree's active flag and lifts
 * the engine lockout. Used for both the fetched PGN and a manually pasted
 * one. Throws (record untouched, lockout intact) when the import fails or
 * imports nothing new; a duplicate counts as success — the game IS in the
 * database, which is all the lockout exit requires.
 *
 * `pgn` is the game as played and is passed through UNCHANGED apart from
 * rescuing missing player headers — the tree is never serialized here, which
 * is what makes spec 226 J's purity guarantee structural rather than a thing
 * to remember.
 *
 * ORDER AND FAILURE SEMANTICS, spelled out because both artifacts are written
 * here and the wrong order would weaken the lockout:
 *
 *   1. import the served PGN  → fails: throw. Nothing archived, nothing
 *      recorded, record stays active and LOCKED. Retry or paste.
 *   2. mark the record archived (this is what lifts the lockout) → fails:
 *      throw. The game is now in the database but the record stays locked,
 *      which is the safe side of that error; retrying archives again and the
 *      duplicate counts as success.
 *   3. extract and write the training record → fails: REPORTED, not thrown.
 *      The archive stands.
 *
 * Step 3 is last and non-fatal on purpose. The lockout may only ever be lifted
 * by the game genuinely reaching the database, and it must never be *withheld*
 * for an unrelated reason either — re-locking a user whose game is demonstrably
 * archived, because a notes file could not be written, would be absurd and
 * would teach them to distrust the lockout. Nothing is lost when it fails: the
 * pre-archive record (working tree, assessments, likelihoods, preferences) is
 * still in the active-games store until the user removes the row, so the write
 * can be retried. The inverse order — training record first — is rejected
 * outright: it would leave a record pointing at a game that never got archived.
 */
export async function archiveActiveGamePgn(
  record: ActiveGameRecord,
  pgn: string,
): Promise<{
  record: ActiveGameRecord
  report: ImportReport
  training: TrainingRecordOutcome
}> {
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
  // The archive-purity backstop (spec 226 J). Nothing above can produce
  // notebook content today — the served PGN goes through untouched — so this
  // is here for the day someone "helpfully" swaps in treeToPgn, and for the
  // paste box, which takes arbitrary text and is reachable by pasting the
  // app's own Export output.
  //
  // It checks more than the three notebook tags, because `treeToPgn` leaks the
  // notebook three ways and only one of them is tagged: the analysis
  // VARIATIONS are the bulk of it and carry no tag at all, and an assessment
  // set through the spec 202 annotation bar is a bare NAG with no [%prov]
  // stamp. A chess.com daily PGN has neither, so refusing both costs a real
  // archive nothing. Refuses rather than strips, for the same reason as ever:
  // a silently laundered archive is worse than a failed one, and stripping
  // would hide the bug that produced it.
  const impurity = archivePgnImpurity(text)
  if (impurity) {
    throw new Error(
      `refusing to archive: this PGN carries ${impurity}. The archived game must be ` +
        "the game as played (spec 226 J), byte-comparable with the opponent's copy — " +
        "the user's thinking belongs in the training record, not in the game.",
    )
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
  // The second artifact (spec 226 J), step 3. Extracted from the PRE-archive
  // record, whose working tree still carries every assessment, likelihood and
  // preference — the archive never touched it. Reported, never thrown: see the
  // failure semantics above.
  //
  // The archived text goes with it so the record describes the game AS PLAYED:
  // the working tree is only current as of the last successful live sync, and
  // the decisions it would otherwise be missing are the ones at the final
  // moves. It is read there, never written — the archive is already in the
  // database by this line and nothing below can reach it.
  let training: TrainingRecordOutcome
  try {
    const written = await recordTrainingForArchivedGame(
      record,
      {
        databaseGameId: null,
        gameUrl: meta.gameUrl,
        importSource: source,
      },
      { archivedPgn: text },
    )
    training = { status: "written", id: written.id, decisions: written.decisions.length }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.warn("training record not written for", record.id, e)
    training = { status: "failed", message }
  }
  return { record: archived, report, training }
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
      /** True when the tree was rebuilt from chess.com because its foundation
       *  (variant / start position) disagreed with reality — e.g. a 960 game
       *  that had lost its castling rights. Exploration is discarded, so the
       *  UI must say so rather than let it vanish silently. */
      rebuilt: boolean
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

  // Replay WITHOUT pruning, so the candidate sets are still standing when the
  // decisions are captured below. The prune runs afterwards, by hand.
  const synced = syncLiveLine(GameTree.fromJSON(record.tree), game.pgn, { prune: false })
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

  // CAPTURE BEFORE PRUNE (spec 226 J; user-reported data loss 2026-07-21).
  //
  // The prune below is right for the move list and fatal for the record: it
  // deletes exactly the branches that ARE the candidate sets — what the player
  // considered before they moved. Extraction used to run at archive time, by
  // which point days of it were gone. Measured on the real game: the board held
  // 131 nodes / 17 assessments / 9 branch points; the store, one sync later,
  // held 36 / 0 / 0.
  //
  // Best-effort: a capture failure must never cost the user their sync, and
  // the tree is still on disk either way.
  let decisionLog = record.decisionLog ?? []
  try {
    const snapshot = extractTrainingRecord(tree, {
      id: record.id,
      // Only `snapshot.decisions` is kept. The game reference is unknowable
      // mid-game — nothing has been archived — and is filled in properly when
      // the real record is built at archive time, so it is a placeholder here
      // rather than a half-truth worth persisting.
      game: {
        databaseGameId: null,
        gameUrl: meta.gameUrl,
        activeGameId: record.id,
        importSource: "",
        archivedAt: 0,
      },
      player: playerRefFrom(meta),
      liveNodeId: meta.liveNodeId,
    })
    decisionLog = mergeDecisionLog(decisionLog, snapshot.decisions)
  } catch (e) {
    console.error("[active-games] decision capture failed; the tree is unchanged:", e)
  }

  // Now the prune, purely for readability of the move list (spec 219 F).
  const pruned = pruneBehindLive(tree, synced.report.liveNodeId)

  const saved = await saveActiveGame({
    ...record,
    meta,
    decisionLog,
    tree: withActiveGameFlag(tree.toJSON(), meta),
  })
  return {
    status: "synced",
    record: saved,
    plies: synced.report.plies,
    added: synced.report.added,
    pruned,
    rebuilt: synced.report.adopted,
    turn: game.turn ?? null,
  }
}

export type FinishActiveGameResult =
  /** Fetched, imported, lockout lifted. `training` says whether the second
   *  artifact landed — it never gates this status (spec 226 J). */
  | {
      status: "archived"
      record: ActiveGameRecord
      report: ImportReport
      training: TrainingRecordOutcome
    }
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
    const { record: archived, report, training } = await archiveActiveGamePgn(record, result.pgn)
    return { status: "archived", record: archived, report, training }
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) }
  }
}

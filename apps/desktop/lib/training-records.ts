// Training-record domain wrapper (spec 226 J): the I/O half of the second
// artifact. packages/core owns the shape, the extraction and the doctrine
// gate; this owns persistence through the TrainingRecordsProvider seam, the
// same division as lib/active-games.ts.
//
// The separation this file exists to hold up: the GAME goes to the spec 200
// database exactly as played (archiveActiveGamePgn, lib/active-games.ts), and
// the record of how the player THOUGHT goes here, pointing at it. Neither ever
// contains the other.
//
// Every read here takes the caller's active-game flag, and it is not optional
// bookkeeping: the loaded document is a position index, so the tag decides
// whether the FENs come with it (core `redactPositionIndex`). Writes go
// per-record through the provider so nothing here ever round-trips the whole
// store — a redacted load persisted back would erase the positions for good.

import {
  engineContextTag,
  type ActiveGameMeta,
  type ActiveGameRecord,
} from "@chessgui/core/active-game"
import { GameTree } from "@chessgui/core/game-tree"
import { syncLiveLine } from "@chessgui/core/live-sync"
import {
  extractTrainingRecord,
  mergeDecisionLog,
  findTrainingRecord,
  findTrainingRecordForGame,
  parseTrainingRecordsStore,
  playerRefFrom,
  positionQueryAllowed,
  readTrainingRecordsStore,
  TRAINING_POSITION_QUERY_REFUSED,
  type ArchivedGameRef,
  type TrainingRecord,
  type TrainingRecordsStore,
} from "@chessgui/core/training-record"
import { getProviders } from "@/lib/platform"

/** Store id for the record of one finished game — derived from the
 *  active-game id so re-archiving the same game replaces rather than duplicates. */
export function trainingRecordIdFor(activeGameId: string): string {
  return `tr-${activeGameId}`
}

/**
 * The caller's context, on exactly the same contract as `engineAllowedForGame`:
 * `null` means "known not an active game", `undefined` means the caller could
 * not tell, and ambiguity resolves to the restricted reading.
 */
export type ReadContext = ActiveGameMeta | null | undefined

async function loadStore(activeGame: ReadContext): Promise<TrainingRecordsStore> {
  const context = engineContextTag(activeGame)
  const raw = await getProviders().trainingRecords.load(context)
  // Redacted a second time on this side. The shell already redacted (Rust, or
  // the browser fallback), and this is the layer that still holds when a shell
  // forgets — cheap, and it is the same argument as the two-layer query gate.
  return readTrainingRecordsStore(parseTrainingRecordsStore(raw), context)
}

/** Every record, newest first — the linear read, always permitted. Positions
 *  come along only outside a fair-play game. */
export async function loadTrainingRecords(
  activeGame: ReadContext = undefined,
): Promise<TrainingRecord[]> {
  return (await loadStore(activeGame)).records
}

export async function getTrainingRecord(
  id: string,
  activeGame: ReadContext = undefined,
): Promise<TrainingRecord | null> {
  return findTrainingRecord(await loadStore(activeGame), id)
}

/** By archived-game pointer: reached FROM a game you are already looking at,
 *  never from a position. That is what keeps it inside the doctrine. */
export async function getTrainingRecordForGame(
  ref: {
    gameUrl?: string | null
    databaseGameId?: number | null
    activeGameId?: string
  },
  activeGame: ReadContext = undefined,
): Promise<TrainingRecord | null> {
  return findTrainingRecordForGame(await loadStore(activeGame), ref)
}

/** Insert-or-replace one record. The shell does the read-modify-write, so no
 *  redacted copy can ever be written back over the real store. */
export async function saveTrainingRecord(record: TrainingRecord): Promise<TrainingRecord> {
  await getProviders().trainingRecords.upsert(JSON.stringify(record))
  return record
}

export async function deleteTrainingRecord(id: string): Promise<void> {
  await getProviders().trainingRecords.remove(id)
}

/**
 * Extract and persist the training record for a game that has just been
 * archived (spec 226 J).
 *
 * Called AFTER the archive step, and reading the record's own working tree —
 * which still carries every assessment, likelihood and preference, because the
 * archive never touched it. That ordering is the whole design: the archived
 * PGN is the game as played, this is everything else, and the only thing
 * joining them is `game`.
 *
 * `archivedPgn` is the text that was just archived, and passing it is what
 * makes the record describe the game AS PLAYED rather than as last synced. The
 * working tree is only as current as the last successful live sync, so without
 * this the decisions at the final moves — often the decisive ones — would be
 * missing outright, and anything the user explored past the stale live pointer
 * would be recorded `played: false` with a null `playedMove`, killing the
 * opponent-model signal exactly where it matters (spec 226 H). The replay runs
 * into a COPY, with pruning off (the branches behind those final moves are the
 * candidate sets this record exists to keep), and the archive itself was
 * written from the served text long before this and is untouchable from here.
 */
export async function recordTrainingForArchivedGame(
  record: ActiveGameRecord,
  game: Omit<ArchivedGameRef, "activeGameId" | "archivedAt"> & {
    archivedAt?: number
  },
  opts: { archivedPgn?: string } = {},
): Promise<TrainingRecord> {
  const meta: ActiveGameMeta = record.meta
  let tree = GameTree.fromJSON(record.tree)
  let liveNodeId = meta.liveNodeId ?? null
  if (opts.archivedPgn) {
    const synced = syncLiveLine(tree, opts.archivedPgn, { prune: false })
    // A divergence (different start position, a paste that isn't this game)
    // leaves the working tree as it stood. A partial record beats none, and
    // reconciliation failure must never cost the user their notes.
    if (synced.status === "ok") {
      tree = synced.tree
      liveNodeId = synced.report.liveNodeId
    } else {
      console.warn("training record: could not reconcile with the archived PGN —", synced.message)
    }
  }
  const extracted = extractTrainingRecord(tree, {
    id: trainingRecordIdFor(record.id),
    game: {
      databaseGameId: game.databaseGameId,
      gameUrl: game.gameUrl,
      importSource: game.importSource,
      activeGameId: record.id,
      archivedAt: game.archivedAt ?? Date.now(),
    },
    player: playerRefFrom(meta),
    liveNodeId,
  })
  // Merge in everything captured at sync time (spec 226 J). The tree at
  // archive is NOT the tree the player thought in: the spec 219 F prune has
  // been deleting branches behind the live position for the whole game, and
  // those branches are the candidate sets. Extracting only from what survives
  // yields a record of the moves that were played and almost nothing about
  // what was considered — the exact loss measured on disk 2026-07-21.
  //
  // Order matters: the log is the base and the fresh extraction is merged ON
  // TOP, so a decision still standing in the tree (anything at or ahead of the
  // live position, where nothing was ever pruned) wins if it names more
  // candidates, while pruned decisions survive from the log.
  const decisions = mergeDecisionLog(record.decisionLog ?? [], extracted.decisions)
  return saveTrainingRecord({ ...extracted, decisions })
}

// ---- the doctrine gate, at the call site (spec 226 G/J) ----

/**
 * Position-indexed read over the training record — the post-game instrument.
 *
 * `activeGame` is the flag of the game the CALLER is serving, on exactly the
 * same contract as `engineAllowedForGame`: `null` means "known not an active
 * game", `undefined` means the caller could not tell, and ambiguity resolves
 * to refusal.
 *
 * The refusal is thrown HERE, before the provider seam, and that placement is
 * the point rather than an implementation detail. Handing the tag to the shell
 * and trusting it to refuse makes layer 1 a property of whichever provider
 * happens to be registered — which on the desktop path is a thin `invoke`
 * forwarder, leaving the Rust command as the only guard in the app. Refusing
 * here holds in every shell, and leaves Rust as a genuine second line.
 */
export async function findTrainingDecisionsByPosition(
  fen: string,
  activeGame: ReadContext,
): Promise<unknown[]> {
  const context = engineContextTag(activeGame)
  if (!positionQueryAllowed(context)) throw new Error(TRAINING_POSITION_QUERY_REFUSED)
  const json = await getProviders().trainingRecords.queryByPosition(fen, context)
  return JSON.parse(json) as unknown[]
}

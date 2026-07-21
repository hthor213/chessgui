// Active Game Mode — OTB daily-game compliance (spec 219).
//
// A game flagged ACTIVE is a chess.com Daily game still being played:
// chess.com permits moving pieces on an analysis board but bans every form
// of engine evaluation, so for a flagged game the engine must be provably,
// structurally OFF. The stance is conservative by design (spec 219 B): any
// ambiguity about which game a request serves resolves to engine OFF.
//
// This module is the pure half: the flag/metadata types that ride the
// serialized game tree, the guard predicate checked at every engine
// invocation point (hooks/use-engine.ts), the context tags the Rust UCI
// manager refuses defensively (src-tauri/src/uci.rs mirrors
// isLockedEngineContext — keep them in sync), and the persisted
// active-games store shape with its pure list operations. All I/O lives in
// the shells (apps/desktop/lib/active-games.ts).

import type { SerializedTree } from "./game-tree"
// Type-only, so this stays a one-directional dependency like the rest of the
// module: active-game describes the store, training-record describes what the
// store now has to carry (spec 226 J).
import type { DecisionRecord } from "./training-record"

/** Metadata captured when a game is flagged active (spec 219 A). */
export interface ActiveGameMeta {
  /** Opponent's name or handle, freeform ("" when not given). */
  opponent: string
  /** The chess.com account the USER plays this game on. Stored per game —
   *  the user has more than one account (spec 219 A). */
  chesscomUsername: string
  /** chess.com game URL when known — the exact-match key for the
   *  finished-game fetch (spec 219 D). */
  gameUrl: string | null
  /** Epoch ms when the game was flagged. */
  flaggedAt: number
  /** Which side the USER is playing — drives board orientation on resume so
   *  the user's pieces sit at the bottom. Optional: games flagged before this
   *  field existed carry none, and the active-games panel offers a per-game
   *  control to set it. Since spec 219 F the chess.com sync derives it
   *  authoritatively, so the manual control is only a fallback. */
  myColor?: "white" | "black"
  /**
   * The node holding the position as the game ACTUALLY stands (spec 219 F).
   * Everything at or after it is exploration; everything before it is
   * history the user may browse but not branch from. Node ids survive
   * save/load verbatim (GameTree.fromJSON), so this pointer persists with
   * the game. Absent/null = never synced — the board behaves as a plain
   * analysis board until the first sync.
   */
  liveNodeId?: string | null
  /** Epoch ms of the last successful chess.com sync — drives the badge's
   *  "synced Nm ago" and tells the user how stale the pointer might be. */
  liveSyncedAt?: number | null
}

// ---- the live position (spec 219 F) ----

/**
 * Where the browsing cursor sits relative to the live position.
 * - `live`       — on the real game position.
 * - `ahead`      — a descendant of it: this is exploration, and it's allowed.
 * - `behind`     — an ancestor: real history, browsable but not branchable.
 * - `off-branch` — in a variation that diverged BEFORE the live position;
 *                  also not branchable, for the same reason as `behind`.
 * - `unknown`    — no pointer yet (never synced), or it names a node that
 *                  isn't in this tree. The board stays fully usable.
 */
export type LivePositionRelation = "live" | "ahead" | "behind" | "off-branch" | "unknown"

export interface LivePositionState {
  relation: LivePositionRelation
  /** Plies between the cursor and the live position — for `off-branch`, plies
   *  back to where this line diverged. Zero when `live` or `unknown`. */
  distance: number
  /**
   * Whether a move may be played from here. True at or ahead of the live
   * position (that IS the analysis board), and true when unknown — the block
   * exists to stop branches growing off stale positions, not to freeze a
   * board we have no pointer for. Engine access is governed separately and
   * far more strictly by `engineAllowedForGame`.
   */
  canMove: boolean
}

export function livePositionCanMove(relation: LivePositionRelation): boolean {
  return relation === "live" || relation === "ahead" || relation === "unknown"
}

// ---- guard predicate (spec 219 B, layer 1) ----

/**
 * Whether engine commands may be issued for the game carrying this flag.
 * `null` means "known not an active game" → engine allowed. `undefined`
 * means the caller could not determine its game — ambiguity resolves to
 * OFF, per the spec's conservative stance.
 */
export function engineAllowedForGame(
  activeGame: ActiveGameMeta | null | undefined,
): boolean {
  return activeGame === null
}

/** Shown wherever an engine action was refused because of the lockout. */
export const ENGINE_LOCKED_MESSAGE =
  "Engine disabled: this game is flagged as an active chess.com daily game (fair play)."

// ---- context tags (spec 219 B, layer 2 — the Rust defensive refusal) ----

/** Tag prefix the Rust UCI manager refuses (uci.rs `context_is_locked`). */
export const ACTIVE_GAME_CONTEXT_PREFIX = "active-game"

/** Tag for contexts with full engine access (puzzles, training, spar, lab,
 *  and non-flagged games). */
export const UNRESTRICTED_ENGINE_CONTEXT = "unrestricted"

/**
 * The game-context tag every engine command carries down to the Rust UCI
 * manager. The frontend gate (engineAllowedForGame) provides the scoping;
 * the tag lets the Rust layer refuse defensively if a locked request ever
 * slips through.
 */
export function engineContextTag(
  activeGame: ActiveGameMeta | null | undefined,
): string {
  if (engineAllowedForGame(activeGame)) return UNRESTRICTED_ENGINE_CONTEXT
  return activeGame
    ? `${ACTIVE_GAME_CONTEXT_PREFIX}:${activeGame.gameUrl ?? activeGame.opponent ?? ""}`
    : `${ACTIVE_GAME_CONTEXT_PREFIX}:unknown`
}

/** TS mirror of the Rust refusal (uci.rs) — same prefix rule, kept adjacent
 *  to engineContextTag so the two layers can't drift apart silently. */
export function isLockedEngineContext(tag: string | null | undefined): boolean {
  return typeof tag === "string" && tag.startsWith(ACTIVE_GAME_CONTEXT_PREFIX)
}

// ---- persisted active-games store (spec 219 C/D) ----

/**
 * One saved active game: the full serialized tree (which itself carries
 * `activeGame` so every load path re-applies the lockout) plus the list
 * metadata. `archived` flips true ONLY after the finished game's PGN has
 * reached the game database — that flip is what lifts the lockout.
 */
export interface ActiveGameRecord {
  id: string
  tree: SerializedTree
  meta: ActiveGameMeta
  /** Epoch ms of the last "Continue later" save. */
  lastUpdated: number
  archived: boolean
  archivedAt: number | null
  /**
   * Decisions captured at sync time, BEFORE the spec 219 F prune runs
   * (spec 226 J; user-reported data loss 2026-07-21).
   *
   * The tree alone cannot carry the training record, because pruning behind
   * the live position deletes the candidate sets as the game advances — which
   * is correct for the move list and fatal for the record of what the player
   * considered. So each sync snapshots the decisions first and accumulates
   * them here, and the archive builds the training record from this log rather
   * than from whatever the tree still happens to hold.
   *
   * Optional: absent on every record written before this existed.
   */
  decisionLog?: DecisionRecord[]
}

/** The store file's shape (one small JSON document, spec 219 How). */
export interface ActiveGamesStore {
  v: 1
  games: ActiveGameRecord[]
}

export function emptyActiveGamesStore(): ActiveGamesStore {
  return { v: 1, games: [] }
}

/** Rebuild the store from raw JSON. Corrupt or missing data yields an empty
 *  store — the list must never wedge the app. */
export function parseActiveGamesStore(raw: string | null | undefined): ActiveGamesStore {
  if (!raw) return emptyActiveGamesStore()
  try {
    const parsed = JSON.parse(raw)
    if (parsed && parsed.v === 1 && Array.isArray(parsed.games)) {
      return parsed as ActiveGamesStore
    }
  } catch {
    /* corrupt store — start fresh */
  }
  return emptyActiveGamesStore()
}

/** Stamp (or clear, with `null`) the active-game flag on a serialized tree.
 *  Returns a new object; the input is not mutated. */
export function withActiveGameFlag(
  tree: SerializedTree,
  meta: ActiveGameMeta | null,
): SerializedTree {
  const next: SerializedTree = { ...tree }
  if (meta) next.activeGame = { ...meta }
  else delete next.activeGame
  return next
}

/** Build a record for a freshly flagged game. Ensures the embedded tree
 *  carries the flag so resume/restart re-applies the lockout. */
export function newActiveGameRecord(
  id: string,
  tree: SerializedTree,
  meta: ActiveGameMeta,
  now: number = Date.now(),
): ActiveGameRecord {
  return {
    id,
    tree: withActiveGameFlag(tree, meta),
    meta: { ...meta },
    lastUpdated: now,
    archived: false,
    archivedAt: null,
  }
}

/** Insert or replace by id, stamping lastUpdated. Newest-updated first. */
export function upsertActiveGame(
  store: ActiveGamesStore,
  record: ActiveGameRecord,
  now: number = Date.now(),
): ActiveGamesStore {
  const stamped = { ...record, lastUpdated: now }
  const games = store.games.filter((g) => g.id !== record.id)
  games.unshift(stamped)
  games.sort((a, b) => b.lastUpdated - a.lastUpdated)
  return { v: 1, games }
}

export function removeActiveGame(store: ActiveGamesStore, id: string): ActiveGamesStore {
  return { v: 1, games: store.games.filter((g) => g.id !== id) }
}

export function findActiveGame(
  store: ActiveGamesStore,
  id: string,
): ActiveGameRecord | null {
  return store.games.find((g) => g.id === id) ?? null
}

/**
 * Mark a record archived — the ONLY transition that lifts the lockout
 * (spec 219 D). Clears the embedded tree's flag so reopening the archived
 * game gets full engine access. Callers must have already written the
 * finished PGN to the game database before calling this.
 */
export function markActiveGameArchived(
  record: ActiveGameRecord,
  now: number = Date.now(),
): ActiveGameRecord {
  return {
    ...record,
    tree: withActiveGameFlag(record.tree, null),
    archived: true,
    archivedAt: now,
    lastUpdated: now,
  }
}

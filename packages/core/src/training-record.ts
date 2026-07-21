// The training record (spec 226 J): the second of the two artifacts a
// notebook produces, and the private one.
//
// The GAME is a historical fact shared with the opponent. On conclusion it is
// archived to the spec 200 database EXACTLY AS PLAYED — the real PGN chess.com
// served, byte-comparable with the copy the opponent has. Nothing about the
// user's thinking is welded into it. That path lives in the shell
// (apps/desktop/lib/active-games.ts `archiveActiveGamePgn`) and this module
// deliberately owns no part of it.
//
// The TRAINING RECORD is about the PLAYER. It lives in its own store with a
// POINTER to the archived game, never inside it, and it holds everything the
// archive refuses: candidate sets, assessments with provenance, likelihood
// labels, coverage, width, and the head-to-head log.
//
// Three rules govern this module and none is negotiable:
//
//  1. Extraction is pure and reads the tree only. No move generation, no legal
//     move list, no engine — same two rules as notebook.ts, for the same
//     reason: the gap between what the player saw and what mattered is the
//     record this feature exists to produce, and anything that quietly fills
//     that gap destroys it (spec 226 "Two co-equal goals").
//  2. Blind spots must stay RECOVERABLE without being enumerated here.
//     Enumerating them needs the legal-move list, which is the single most
//     important non-goal in the spec. So the record stores the POSITION at
//     every decision alongside the user's own candidate set — from which a
//     post-game pass (spec 215, with the lockout lifted) can work out what was
//     never on the list, and this module never has to know.
//  3. This is the most dangerous store in the app. Once spec 215 joins engine
//     verdicts onto these decisions it becomes exactly the FEN-keyed
//     engine-evaluation lookup table the Notebook Doctrine (spec 226 G) exists
//     to prevent. So the by-position query is gated here, at the query layer,
//     with the Rust command (src-tauri/src/training_records.rs) refusing a
//     second time — the same two-layer treatment as the engine lockout. And
//     because the loaded DOCUMENT is itself a position index, the bulk read is
//     redacted in a fair-play context rather than merely un-queryable: a gate
//     over a table you were handed anyway is not a gate.

import { ACTIVE_GAME_CONTEXT_PREFIX, UNRESTRICTED_ENGINE_CONTEXT } from "./active-game";
import type { ActiveGameMeta } from "./active-game";
import type {
  AssessmentOrigin,
  GameTree,
  Likelihood,
  MoveNode,
  MoveSource,
  Preference,
} from "./game-tree";
import { assessmentOf, backupTree, type Assessment, type NodeValue } from "./notebook";

/**
 * Document version. Bumped whenever a shape below changes incompatibly;
 * `parseTrainingRecordsStore` drops anything it does not recognise rather than
 * guessing, because a half-migrated record of how someone thought is worse
 * than no record at all.
 *
 * v2: `own` used to be true for every move with no `src`, which included the
 * moves the live sync appended because they were PLAYED. So a v1 record credits
 * the player with having named every move of the game — including the
 * opponent's replies they never once considered — which inflates
 * `coverage.named` and, worse, makes a decision where they did no work at all
 * read as free of blind spots (the played move's own loss is 0 whenever they
 * played well). A v1 record cannot be repaired, because nothing in it records
 * which nodes the sync created. It is dropped rather than diagnosed: this
 * feature tells a person what is wrong with their chess, and a confident wrong
 * answer is worse than no answer.
 */
export const TRAINING_RECORD_VERSION = 2;

// ---- the pointer to the archived game (spec 226 J) ----

/**
 * Which archived game this record is about. Never the game itself: the game
 * belongs to both players and to the record, and lives in the spec 200
 * database exactly as played.
 *
 * Two keys, because neither alone survives everything. `databaseGameId` is
 * whatever identity the spec 200 import handed back and is null when the
 * import reported only a duplicate. `gameUrl` is chess.com's own permalink —
 * stable across a database rebuild, re-import, or a move to another machine,
 * which makes it the key that actually joins a season of records together.
 */
export interface ArchivedGameRef {
  databaseGameId: number | null;
  gameUrl: string | null;
  /** The active-games record it was played through (spec 219 C). */
  activeGameId: string;
  /** The `source` string the PGN was imported under — the fallback join key
   *  when there is no chess.com URL (a pasted PGN). */
  importSource: string;
  archivedAt: number;
}

/** Whose play this record describes. The unit of analysis is the PLAYER. */
export interface TrainingPlayerRef {
  chesscomUsername: string;
  opponent: string;
  myColor: "white" | "black";
}

// ---- one candidate at one decision ----

/**
 * A move the user had on the board at a decision point, with everything they
 * said about it.
 *
 * `own` is the load-bearing field: a move the player did not put on the board
 * themselves is not one of their candidates. Two ways that happens, and both
 * are marked (`MoveSource`) — served out of a position-indexed corpus (the
 * opening explorer, the database's move rows), or appended by the live sync
 * because it was played in the real game. Judging either is still their own
 * work and still feeds the backup, but counting them as "my candidates" would
 * overstate what they saw and quietly repair the blind-spot record with the
 * answer key.
 */
export interface CandidateRecord {
  nodeId: string;
  san: string;
  uci: string;
  /** Position AFTER the candidate — lets a later pass characterise the move
   *  (inactive piece? backward move?) without re-walking the archived game. */
  fen: string;
  own: boolean;
  src?: MoveSource;
  /** The user's own judgement, or null when they never judged it. Reads
   *  through `assessmentOf`, so an unstamped NAG arriving from an imported
   *  annotated PGN is invisible here exactly as it is to the backup. */
  assessment: Assessment | null;
  assessedBy?: AssessmentOrigin;
  assessedAt?: number;
  /** How likely they thought the opponent was to play it (opponent replies
   *  only in practice; null when unbucketed). */
  likelihood: Likelihood | null;
  /** The backed-up value of the whole branch under this candidate — what the
   *  user actually concluded, not just what they wrote on the move itself. */
  backedUp: number | null;
  /** Coverage under this candidate, so "I judged it ± having checked one of
   *  his four replies" survives as the qualified claim it was. */
  examined: number;
  named: number;
}

/** A head-to-head, flattened so the log reads without the tree (spec 226 I). */
export interface PreferenceRecord {
  winnerId: string;
  loserId: string;
  winnerSan: string;
  loserSan: string;
  reason: string;
  /**
   * The one-tap tags. Structurally these are CONJOINT ATTRIBUTES — every
   * head-to-head carrying `[safer king] [clearer plan]` is one row of a design
   * matrix — so the log is already the raw data for a part-worth fit once it
   * is long enough (spec 226 J). Kept as a flat list rather than folded into
   * `reason` so that stays possible.
   */
  tags: string[];
  at: number;
}

/** What actually happened at a decision, once the game moved on. */
export interface PlayedMove {
  nodeId: string;
  san: string;
  /**
   * Whether the move that was actually played had been JUDGED by the user
   * before it appeared. At the opponent's decisions this is the
   * opponent-model signal in its purest engine-free form: he played something
   * that was never on the list, or something marked unlikely.
   *
   * Deliberately not called "blind spot" — that classification is section H's
   * job, needs the engine, and happens after the lockout lifts.
   */
  wasAssessed: boolean;
  /** The likelihood the user had put on it, when it was an opponent reply. */
  likelihood: Likelihood | null;
  /**
   * How the player actually arrived at this move — NOT how the notebook says
   * they should have (user-reported 2026-07-21).
   *
   * The diagnosis silently assumed every played move came out of the analysis.
   * It does not. The user played b6 in the live game against painterdenny
   * having given up on reading their own panel: *"I made a move b6 because I
   * gave up — meaning, I didn't quite understand my notebook, it was a gut
   * feel."* A pass that assumes otherwise sees "rated something else best,
   * played b6" and reports a SELECTION ERROR — prescribing training for
   * choosing badly, when the truth is the analysis went unused. That is the
   * confidently-wrong answer section H exists to refuse.
   *
   * `undefined` means unrecorded, which must be treated as unknown rather than
   * as "notebook" — the same conservative default the engine and doctrine
   * gates use. Only `"notebook"` licenses a selection-error finding.
   */
  chosenBy?: MoveChoiceBasis;
}

/**
 * Why a move got played. Deliberately coarse: this is answered in the middle
 * of a game, and a taxonomy nobody can be bothered to use records nothing.
 *
 * - `notebook`  — the analysis decided it.
 * - `gut`       — intuition, including "I could not read my own notes".
 * - `forced`    — no real choice (recapture, only move, time).
 * - `other`     — recorded as deliberate, but none of the above.
 */
export type MoveChoiceBasis = "notebook" | "gut" | "forced" | "other";

/**
 * One decision point: a position where at least one move was on the board.
 *
 * `fen` is here for rule 2 above. The candidate list says what the player
 * saw; only the position says what there was to see. Storing both is what
 * makes a blind spot recoverable later WITHOUT this module ever enumerating a
 * legal move.
 */
export interface DecisionRecord {
  nodeId: string;
  fen: string;
  ply: number;
  /** SAN path from the root, so the decision reads on its own. */
  line: string[];
  sideToMove: "white" | "black";
  /** True when it was the USER's move — their candidate generation on trial.
   *  False when it was the opponent's — their opponent model on trial. */
  mine: boolean;
  /** True when this position occurred in the game as actually played, as
   *  opposed to somewhere inside a line the user only analysed. */
  played: boolean;
  candidates: CandidateRecord[];
  /** Coverage in the user's own handwriting: examined out of NAMED, never out
   *  of legal. `allCandidatesExamined` claims nothing about completeness — the
   *  set was theirs and may have been incomplete, and the app will not vouch
   *  for a claim it cannot support. */
  coverage: { examined: number; named: number; allCandidatesExamined: boolean };
  /** Branch width: replies marked LIKELY. Reported, never ranked on. */
  width: { likelyReplies: number };
  /** The backed-up conclusion at this decision. */
  value: { objective: number | null; range: { lo: number; hi: number } | null };
  /** Candidates the user put on the board and never judged — the only
   *  "not considered" set derivable without a legal-move list. */
  unjudged: string[];
  preferences: PreferenceRecord[];
  /** The move that was actually played from here, when this is a played
   *  position and the game went on. */
  playedMove: PlayedMove | null;
}

/** The document. One per finished game, pointing at the archived game. */
export interface TrainingRecord {
  v: typeof TRAINING_RECORD_VERSION;
  id: string;
  game: ArchivedGameRef;
  player: TrainingPlayerRef;
  /** Epoch ms the record was extracted. */
  createdAt: number;
  /** [Date]/[UTCDate] off the working tree's headers, when it had one. */
  playedOn: string | null;
  decisions: DecisionRecord[];
}

// ---- extraction (pure) ----

function sideToMove(node: Pick<MoveNode, "fen">): "white" | "black" {
  return node.fen.split(" ")[1] === "w" ? "white" : "black";
}

/** SAN path root→node, excluding the root (which has no move). */
function lineTo(tree: GameTree, id: string): string[] {
  const out: string[] = [];
  let cur = tree.get(id);
  while (cur && cur.parent !== null) {
    out.push(cur.san);
    cur = tree.get(cur.parent) ?? undefined;
  }
  return out.reverse();
}

/**
 * The nodes of the game AS PLAYED, as far as the tree knows it.
 *
 * The live pointer (spec 219 F) is authoritative when present — it is the tip
 * chess.com confirmed. Without one, fall back to the mainline: children[0] is
 * the move that was appended first, which for a synced game is the real one.
 * Everything off this path is analysis, and marking the difference is what
 * separates "my candidate generation at a real decision" from "a line I
 * happened to look at".
 */
function playedPath(tree: GameTree, liveNodeId: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (liveNodeId && tree.get(liveNodeId)) {
    let cur = tree.get(liveNodeId);
    // Bounded by construction: parent links strictly shorten the path, and a
    // repeat means a corrupt save with a cycle — stop rather than spin.
    while (cur && !out.has(cur.id)) {
      out.add(cur.id);
      cur = cur.parent ? tree.get(cur.parent) ?? undefined : undefined;
    }
    return out;
  }
  let cur: MoveNode | undefined = tree.get(tree.rootId);
  while (cur && !out.has(cur.id)) {
    out.add(cur.id);
    cur = cur.children.length ? tree.get(cur.children[0]) ?? undefined : undefined;
  }
  return out;
}

function candidateOf(node: MoveNode, value: NodeValue | undefined): CandidateRecord {
  return {
    nodeId: node.id,
    san: node.san,
    uci: node.uci,
    fen: node.fen,
    // Absent `src` = the user put this move on the board themselves, which is
    // the only kind the notebook counts as one of their candidates (spec 226 C).
    // Book moves and moves the live sync appended both carry one.
    own: node.src === undefined,
    ...(node.src !== undefined ? { src: node.src } : {}),
    assessment: assessmentOf(node),
    ...(node.assessedBy !== undefined ? { assessedBy: node.assessedBy } : {}),
    ...(node.assessedAt !== undefined ? { assessedAt: node.assessedAt } : {}),
    likelihood: node.lik ?? null,
    backedUp: value?.objective ?? null,
    examined: value?.examined ?? 0,
    named: value?.named ?? 0,
  };
}

function preferenceOf(tree: GameTree, p: Preference): PreferenceRecord {
  return {
    winnerId: p.winnerId,
    loserId: p.loserId,
    winnerSan: tree.get(p.winnerId)?.san ?? "",
    loserSan: tree.get(p.loserId)?.san ?? "",
    reason: p.reason,
    tags: [...p.tags],
    at: p.at,
  };
}

export interface ExtractOptions {
  id: string;
  game: ArchivedGameRef;
  player: TrainingPlayerRef;
  /** The live pointer from the active-game flag, when the game had one. */
  liveNodeId?: string | null;
  now?: number;
}

/**
 * Build the training record from a finished notebook tree.
 *
 * Pure: it reads the tree and returns a document. It does not mutate the tree,
 * it does not touch the archive, and it does not decide anything about chess.
 *
 * Every node with at least one child becomes a decision — including the long
 * tail of played moves whose candidate set is exactly one. Those are not
 * noise: "at move 23 I put nothing on the board but the move I played" is a
 * fact about how hard the player looked, and it is only visible if the empty
 * ones are kept.
 */
export function extractTrainingRecord(tree: GameTree, opts: ExtractOptions): TrainingRecord {
  const values = backupTree(tree, opts.player.myColor);
  const played = playedPath(tree, opts.liveNodeId);
  const decisions: DecisionRecord[] = [];

  // Explicit stack, same reason as backupTree: a three-day think is still one
  // person's notes and blowing the call stack would be an unforgivable way to
  // lose them.
  const stack: string[] = [tree.rootId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = tree.get(id);
    if (!node) continue;
    for (const childId of node.children) stack.push(childId);
    if (node.children.length === 0) continue;

    const kids = node.children
      .map((cid) => tree.get(cid))
      .filter((n): n is MoveNode => n !== undefined);
    const value = values.get(id);
    const stm = sideToMove(node);
    const playedChild = played.has(id) ? kids.find((k) => played.has(k.id)) ?? null : null;

    decisions.push({
      nodeId: id,
      fen: node.fen,
      ply: node.ply,
      line: lineTo(tree, id),
      sideToMove: stm,
      mine: stm === opts.player.myColor,
      played: played.has(id),
      candidates: kids.map((k) => candidateOf(k, values.get(k.id))),
      coverage: {
        examined: value?.examined ?? 0,
        named: value?.named ?? 0,
        allCandidatesExamined: value?.allCandidatesExamined ?? false,
      },
      width: { likelyReplies: value?.likelyReplies ?? 0 },
      value: { objective: value?.objective ?? null, range: value?.range ?? null },
      unjudged: kids.filter((k) => assessmentOf(k) === null).map((k) => k.san),
      preferences: tree.preferencesAt(id).map((p) => preferenceOf(tree, p)),
      playedMove: playedChild
        ? {
            nodeId: playedChild.id,
            san: playedChild.san,
            wasAssessed: assessmentOf(playedChild) !== null,
            likelihood: playedChild.lik ?? null,
          }
        : null,
    });
  }

  decisions.sort((a, b) => a.ply - b.ply || a.nodeId.localeCompare(b.nodeId));

  return {
    v: TRAINING_RECORD_VERSION,
    id: opts.id,
    game: opts.game,
    player: opts.player,
    createdAt: opts.now ?? Date.now(),
    playedOn: tree.headers.Date ?? tree.headers.UTCDate ?? null,
    decisions,
  };
}

/** The player half of the pointer, straight off the active-game flag. */
export function playerRefFrom(meta: ActiveGameMeta): TrainingPlayerRef {
  return {
    chesscomUsername: meta.chesscomUsername,
    opponent: meta.opponent,
    // Unflagged games predate `myColor` (spec 219 A); White is the harmless
    // default because it only orients the practical tie-break, never the
    // objective axis.
    myColor: meta.myColor ?? "white",
  };
}

// ---- the persisted store: shape + pure ops ----

export interface TrainingRecordsStore {
  v: typeof TRAINING_RECORD_VERSION;
  records: TrainingRecord[];
}

export function emptyTrainingRecordsStore(): TrainingRecordsStore {
  return { v: TRAINING_RECORD_VERSION, records: [] };
}

/** Rebuild from raw JSON. Corrupt, missing or future-versioned data yields an
 *  empty store — the app must never wedge on it, and guessing at a shape we
 *  do not recognise would corrupt the very thing we are keeping. */
export function parseTrainingRecordsStore(
  raw: string | null | undefined,
): TrainingRecordsStore {
  if (!raw) return emptyTrainingRecordsStore();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.v === TRAINING_RECORD_VERSION && Array.isArray(parsed.records)) {
      return parsed as TrainingRecordsStore;
    }
  } catch {
    /* corrupt store — start fresh */
  }
  return emptyTrainingRecordsStore();
}

/** Insert or replace by id. Newest-created first. */
export function upsertTrainingRecord(
  store: TrainingRecordsStore,
  record: TrainingRecord,
): TrainingRecordsStore {
  const records = store.records.filter((r) => r.id !== record.id);
  records.push(record);
  records.sort((a, b) => b.createdAt - a.createdAt);
  return { v: TRAINING_RECORD_VERSION, records };
}

export function removeTrainingRecord(
  store: TrainingRecordsStore,
  id: string,
): TrainingRecordsStore {
  return { v: TRAINING_RECORD_VERSION, records: store.records.filter((r) => r.id !== id) };
}

// ---- linear / by-game reads: always permitted ----
//
// Human-speed linear reading is permitted over anything (spec 226 G). These
// are the notebook's page-turning: a list, and a lookup by the game you are
// already looking at. Neither can launder an engine verdict into the position
// in front of you, because neither takes a position.

export function findTrainingRecord(
  store: TrainingRecordsStore,
  id: string,
): TrainingRecord | null {
  return store.records.find((r) => r.id === id) ?? null;
}

/** By archived-game pointer — the join that powers "show me what I was
 *  thinking in THIS game", reached from the game, not from a position. */
export function findTrainingRecordForGame(
  store: TrainingRecordsStore,
  ref: { gameUrl?: string | null; databaseGameId?: number | null; activeGameId?: string },
): TrainingRecord | null {
  return (
    store.records.find(
      (r) =>
        (ref.gameUrl != null && r.game.gameUrl === ref.gameUrl) ||
        (ref.databaseGameId != null && r.game.databaseGameId === ref.databaseGameId) ||
        (ref.activeGameId != null && r.game.activeGameId === ref.activeGameId),
    ) ?? null
  );
}

// ---- THE DOCTRINE GATE (spec 226 G/J, layer 1) ----
//
// The rule, in full: no engine verdict may be reachable at machine speed.
// Human-speed linear reading is permitted over anything; POSITION-INDEXED
// QUERY is permitted only over corpora that contain no engine evaluation at
// all. This store will hold engine verdicts joined to positions the moment
// spec 215's post-game pass runs over it, so it is exactly the corpus the rule
// names — and the most dangerous one in the app.
//
// Two layers, the same treatment as the engine lockout: this guard, and
// src-tauri/src/training_records.rs refusing a second time on the way to the
// file. The Rust refusal is not redundancy for its own sake — it is what makes
// the gate impossible to re-open by editing a component.

/**
 * The context tag a by-position query must carry. Mirrors `engineContextTag`
 * (core/active-game.ts) so there is ONE vocabulary of contexts in the app.
 *
 * The default is inverted relative to the engine gate, deliberately. There, an
 * absent tag means an unrestricted caller and the per-game scoping lives in
 * the hook. Here, an absent tag means a caller who could not say where they
 * were standing — and for the store that holds engine verdicts joined to
 * positions, "I don't know" resolves to NO.
 */
export function positionQueryAllowed(context: string | null | undefined): boolean {
  return context === UNRESTRICTED_ENGINE_CONTEXT;
}

/**
 * What a redacted `fen` reads as. Empty rather than absent so the field keeps
 * its type and a consumer cannot mistake a redacted decision for one from an
 * older document that never had a position.
 */
export const REDACTED_FEN = "";

/**
 * Strip the position index out of a store (spec 226 G/J).
 *
 * Gating `queryDecisionsByPosition` is not enough on its own, and this is the
 * hole that closes: the loaded DOCUMENT is a position index. Every decision and
 * every candidate carries a FEN, so a component inside a live game that can
 * bulk-load can also write `records.flatMap(r => r.decisions).find(d => d.fen
 * === liveFen)` and have exactly what the gate refuses — with spec 215's engine
 * verdicts joined on, once those land.
 *
 * The doctrine's friction argument is about a human turning pages, not about a
 * JSON document handed to JS in one call, so in a fair-play context the join
 * key does not leave the store at all. Everything the linear read is FOR —
 * assessments, likelihoods, coverage, width, preferences, what was played —
 * survives untouched; what disappears is the ability to key on the position in
 * front of you. Full fidelity is what the unrestricted tag already unlocks.
 *
 * Mirrored in Rust (src-tauri/src/training_records.rs `redact_positions`) so
 * this is not a TypeScript-only promise; keep the two in sync.
 */
export function redactPositionIndex(store: TrainingRecordsStore): TrainingRecordsStore {
  return {
    v: TRAINING_RECORD_VERSION,
    records: store.records.map((r) => ({
      ...r,
      decisions: r.decisions.map((d) => ({
        ...d,
        fen: REDACTED_FEN,
        candidates: d.candidates.map((c) => ({ ...c, fen: REDACTED_FEN })),
      })),
    })),
  };
}

/**
 * The bulk read, with the position index attached only when the caller proves
 * it is standing outside a fair-play game. Same default as the query gate:
 * "I could not tell where I was standing" resolves to redacted.
 */
export function readTrainingRecordsStore(
  store: TrainingRecordsStore,
  context: string | null | undefined,
): TrainingRecordsStore {
  return positionQueryAllowed(context) ? store : redactPositionIndex(store);
}

export const TRAINING_POSITION_QUERY_REFUSED =
  "Position-indexed search of the training record is refused during an active " +
  "chess.com daily game (fair play, spec 226 G). Read it linearly, or after the game.";

/**
 * By-position read over the training record — the post-game instrument.
 *
 * Throws unless the caller proves it is standing outside a fair-play context.
 * The `context` argument is required and has no default: a parameter that
 * defaults to "allowed" is a gate that opens itself the first time someone
 * forgets it.
 */
export function queryDecisionsByPosition(
  store: TrainingRecordsStore,
  fen: string,
  context: string | null | undefined,
): { record: TrainingRecord; decision: DecisionRecord }[] {
  if (!positionQueryAllowed(context)) throw new Error(TRAINING_POSITION_QUERY_REFUSED);
  // Position identity ignores the halfmove/fullmove counters: the same
  // position reached by a different move order is the same position, which is
  // the whole reason this query is dangerous enough to gate.
  const key = fenKey(fen);
  const out: { record: TrainingRecord; decision: DecisionRecord }[] = [];
  for (const record of store.records) {
    for (const decision of record.decisions) {
      if (fenKey(decision.fen) === key) out.push({ record, decision });
    }
  }
  return out;
}

function fenKey(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

/** Re-exported so a caller building a query tag has one import. The prefix is
 *  the same one the Rust UCI manager refuses. */
export { ACTIVE_GAME_CONTEXT_PREFIX, UNRESTRICTED_ENGINE_CONTEXT };

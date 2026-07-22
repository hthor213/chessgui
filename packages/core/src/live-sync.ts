// The live-position sync (spec 219 F).
//
// A fair-play game is an analysis board, so the tree records exploration and
// reality in exactly the same shape — and after a ten-move idea the user
// cannot tell which node is the actual game. The fix is to stop asking the
// user: chess.com publishes its ongoing daily games, so this module replays
// the real move list into the tree and pins a pointer to its tip.
//
// Two invariants shape the reconciliation:
//   1. Reality outranks exploration. Chess.com's line ends up in the mainline
//      slot at every branch point it passes through.
//   2. Exploration is never destroyed. Lines the user played that chess.com
//      doesn't know about survive as variations, exactly where they were.
//
// Pure module: it takes a GameTree and a PGN and returns a report. All I/O
// (the fetch, the store write) lives in the shells.

import { GameTree } from "./game-tree"
import { parsePgnToTrees } from "./pgn"

/**
 * Delete every exploration branch hanging off a position STRICTLY BEFORE the
 * live one (spec 219 F, user-reported 2026-07-20).
 *
 * The game has moved past those positions, so the lines exploring them can no
 * longer be played — they are dead by construction, and left in place they
 * bury the actual game under nested parentheses within a few moves. The real
 * history (the path itself) is never touched; only side branches off it are,
 * and only behind the live pointer. Everything at or after the live position —
 * the analysis that still matters — survives untouched.
 *
 * Returns the number of branches removed.
 */
export function pruneBehindLive(tree: GameTree, liveNodeId: string): number {
  if (!tree.get(liveNodeId)) return 0
  const path = tree.pathToNode(liveNodeId)
  const onPath = new Set(path.map((n) => n.id))
  let pruned = 0
  // The live node itself is excluded: branches AT the live position are
  // current exploration, which is the thing this whole feature exists to let
  // the user do.
  for (const node of path) {
    if (node.id === liveNodeId) continue
    for (const childId of [...node.children]) {
      if (onPath.has(childId)) continue
      if (tree.deleteVariation(childId)) pruned++
    }
  }
  return pruned
}

export interface LiveSyncReport {
  /** Tip of chess.com's move list — the new live pointer. */
  liveNodeId: string
  /** Plies in the real game. */
  plies: number
  /** Plies that were not yet in the tree (i.e. moves played since last sync). */
  added: number
  /** Branch points where the real line had to be promoted over a user
   *  variation — the "I explored this and it turned out to be the game" case. */
  promoted: number
  /** Dead exploration branches removed from behind the live position. */
  pruned: number
  /** True when the real game replaced an empty board wholesale rather than
   *  being replayed into it (different start position / variant). */
  adopted: boolean
}

export type LiveSyncResult =
  /** `tree` is the reconciled tree — usually the one passed in, mutated in
   *  place, but a fresh one when the board had to be adopted wholesale (see
   *  `adopted`). Callers must persist THIS tree, not their original handle. */
  | { status: "ok"; tree: GameTree; report: LiveSyncReport }
  /** The PGN had no playable moves, or diverged from this tree's start
   *  position. The caller must leave the existing pointer alone — a wrong
   *  pointer is worse than a stale one. */
  | { status: "error"; message: string }

/**
 * Replay the real game's moves into `tree`, promoting them to the mainline as
 * it goes, and report the node that now holds the live position.
 *
 * When the board is still empty (no moves played) the real game is adopted
 * wholesale instead — start position, variant and all. That covers the case
 * that would otherwise fail on the very first sync: a game flagged from the
 * standard start while the real game is Chess960, where replaying move 1 into
 * the wrong position cannot work. Nothing is lost, because there was nothing
 * on the board to lose.
 *
 * The cursor is left ON the live node — which is where the user wants to be
 * after a sync; it's the whole point of the button.
 */
export interface SyncLiveLineOptions {
  /**
   * Clear dead exploration branches from behind the live position (default
   * true — it is what keeps the move list readable during a game).
   *
   * Set false when the reconciliation exists to READ the tree rather than to
   * put it back on the board: the training record (spec 226 J) is extracted by
   * replaying the archived PGN into a copy of the working tree, and the
   * branches behind the final moves are precisely the candidate sets that
   * record exists to preserve. Pruning them there would delete the evidence
   * while reconciling it.
   */
  prune?: boolean;
}

/**
 * Whether two trees are built on the same rules: same variant, and the same
 * starting position down to piece placement, side to move, castling rights and
 * en-passant square. The move counters are ignored — they are not part of what
 * the game IS. A castling-rights mismatch (960 "HBhb" vs a lost "-") is exactly
 * the kind of foundation difference that must trigger a rebuild.
 */
function sameFoundation(a: GameTree, b: GameTree): boolean {
  if ((a.variant ?? null) !== (b.variant ?? null)) return false;
  const key = (fen: string) => fen.split(" ").slice(0, 4).join(" ");
  return key(a.startFen) === key(b.startFen);
}

export function syncLiveLine(
  tree: GameTree,
  pgn: string,
  opts: SyncLiveLineOptions = {},
): LiveSyncResult {
  const parsed = parsePgnToTrees(pgn)
  if (parsed.length === 0) {
    return { status: "error", message: "could not parse the game chess.com returned" }
  }
  const real = parsed[0]
  const sans = real.mainlineNodes().slice(1).map((n) => n.san)
  if (sans.length === 0) {
    return { status: "error", message: "chess.com returned a game with no moves" }
  }

  // Adopt chess.com's game outright when the FOUNDATIONS disagree — a
  // different start position or variant means the working tree was built on
  // the wrong rules and cannot be reconciled: its node FENs were computed
  // under those rules, and every legal-move set it ever showed was wrong.
  //
  // This is not hypothetical. A Chess960 game set up without its variant and
  // castling rights (piece placement right, castling field "-", variant unset)
  // replays every non-castling move fine and then reports the opponent's O-O
  // as a divergence — AND, far worse, hid castling from the user's own legal
  // moves the whole game, so they dismissed a threat that was always there
  // (user-reported 2026-07-21). chess.com is the source of truth for what the
  // game IS (spec 219 F), so reality wins and the broken tree is rebuilt. The
  // old empty-board case is a subset (its start position differs too).
  if (!sameFoundation(real, tree)) {
    real.activeGame = tree.activeGame
    // Wholesale adoption replaces an EMPTY board, so not one of these moves was
    // ever a candidate the user named — mark them all, or the record would
    // credit the player with having foreseen the entire game.
    for (const n of real.mainlineNodes().slice(1)) real.markPlayed(n.id)
    real.goToEnd()
    return {
      status: "ok",
      tree: real,
      report: {
        liveNodeId: real.currentId,
        plies: sans.length,
        added: sans.length,
        promoted: 0,
        pruned: 0,
        adopted: true,
      },
    }
  }

  tree.goToStart()
  let liveNodeId = tree.currentId
  let added = 0
  let promoted = 0

  for (const [i, san] of sans.entries()) {
    // Capture the parent before the move: addMoveSan advances the cursor, so
    // "did this create a node?" has to be asked of the node we moved FROM.
    const parentId = tree.currentId
    const before = tree.currentNode().children.length
    // Marked "played" when this call CREATES the node: reality is not one of
    // the user's candidates. A move they had already put on the board keeps its
    // own provenance — `addMoveSanAsPlayed` only marks what it appends — so
    // "I saw this coming" survives and "he played something I never looked at"
    // stays visible as the blind spot it is (spec 226 C/H).
    const id = tree.addMoveSanAsPlayed(san)
    if (!id) {
      return {
        status: "error",
        message: `chess.com's game diverges from this board at move ${
          Math.floor(i / 2) + 1
        } (${san}) — the flagged position may not match the real game`,
      }
    }
    if (tree.get(parentId)!.children.length > before) added++
    if (tree.promoteToMainline(id)) promoted++
    liveNodeId = id
  }

  // Committed moves make their alternatives unplayable — clear them out so
  // the move list keeps showing the game rather than a museum of dead ideas.
  const pruned = opts.prune === false ? 0 : pruneBehindLive(tree, liveNodeId)
  tree.goTo(liveNodeId)

  return {
    status: "ok",
    tree,
    report: { liveNodeId, plies: sans.length, added, promoted, pruned, adopted: false },
  }
}

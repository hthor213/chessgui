// Navigating your own analysis tree (spec 226 L).
//
// The problem this answers: you play into a line, go eight moves deep, decide
// it is not great, and cannot remember what you actually played at the start.
// The board is the answer surface — it SHOWS the move where the move list only
// names it — so these are the pure lookups the board navigation is built on.
//
// Nothing here generates a move or reads an engine field. It walks the tree the
// player built, keyed on the live pointer, and every target is a node that
// already exists. The one judgement it makes — "best line" — is the player's
// own ranking (sortedChildren), never the app's chess.

import type { GameTree } from "./game-tree";
import type { NodeValue } from "./notebook";
import { sortedChildren } from "./notebook";

/**
 * The head of the peer line the cursor is in: the move first played off the
 * live position on the way to `fromId`. `null` when the cursor is at or behind
 * the live position (there is no branch to retreat within), or when either id
 * is unknown.
 *
 * This is the ONLY retreat target. A fork deeper in the line is deliberately
 * not a stop — forks mark where the player flailed, not where they found the
 * answer, so retreating to "where I worked hardest" would route toward the
 * noise (spec 226 L; the effort-is-not-quality law of sections E and I).
 */
export function branchHead(
  tree: GameTree,
  liveNodeId: string | null | undefined,
  fromId: string,
): string | null {
  if (!liveNodeId || !tree.get(liveNodeId) || !tree.get(fromId)) return null;
  if (fromId === liveNodeId) return null;
  let node = tree.get(fromId)!;
  // Climb until the parent is the live node; that child is the branch head.
  while (node.parent && node.parent !== liveNodeId) {
    node = tree.get(node.parent)!;
  }
  // Fell off the top without meeting the live node → the cursor is not in a
  // line that descends from it (behind, or off a pre-live branch).
  return node.parent === liveNodeId ? node.id : null;
}

/**
 * The move the player made from `fromId` last time — its mainline continuation,
 * `children[0]`. This is what the re-walk previews: the piece slides there and
 * back, the board saying "this is what you did". `null` at a leaf.
 *
 * `children[0]` and not the ranked best on purpose: re-walking retraces the
 * line as it was explored, and reordering the step you are about to retake
 * would defeat "show me what I actually did here".
 */
export function myContinuation(tree: GameTree, fromId: string): string | null {
  return tree.get(fromId)?.children[0] ?? null;
}

/**
 * The head of the player's best-ranked peer off the live position — the
 * keyboard twin of clicking the top of the ranked peer list.
 *
 * The ranking is the player's own (sortedChildren: their assessments,
 * likelihoods and head-to-heads), so this navigates to their conclusion, never
 * to the app's chess. `null` when nothing has been explored past live.
 *
 * Revealed preference (spec 226 H) is already baked in upstream: once a move
 * has been played from the live position it is that decision's top, so this
 * follows the commit rather than the symbols without any special-casing here.
 */
export function bestPeerHead(
  tree: GameTree,
  values: Map<string, NodeValue>,
  liveNodeId: string | null | undefined,
): string | null {
  if (!liveNodeId || !tree.get(liveNodeId)) return null;
  return sortedChildren(tree, values, liveNodeId)[0] ?? null;
}

/** How far ahead of the live position the cursor sits, in plies — the "4 of 8"
 *  a breadcrumb shows. Zero at or behind live. */
export function depthPastLive(
  tree: GameTree,
  liveNodeId: string | null | undefined,
  fromId: string,
): number {
  const live = liveNodeId ? tree.get(liveNodeId) : undefined;
  const from = tree.get(fromId);
  if (!live || !from) return 0;
  return Math.max(0, from.ply - live.ply);
}

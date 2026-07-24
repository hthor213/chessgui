// The Notebook (spec 226): backing up a hand-built tree of judgements, with a
// person as the position-judging function. Shannon/Turing minimax, no engine
// anywhere — which is precisely what makes it usable inside the spec 219
// fair-play lockout.
//
// Two rules govern every line below and neither is negotiable:
//
//  1. This module performs no move generation and knows nothing about the
//     rules of chess. It reads node.nags, node.assessedBy, node.lik, node.src,
//     node.children and the side-to-move character of node.fen. Nothing else.
//     The candidate set at a node is the children the user played themselves
//     (node.src marks the ones the app handed them out of a position-indexed
//     corpus, and those never count) — so coverage is measured against what they
//     named and can never be topped up by the app. The gap between what they
//     saw and what mattered is the record this feature exists to produce
//     (spec 226 "Two co-equal goals"); filling it destroys it.
//  2. The engine verdict lives in a different field on the node and is never
//     read here. That separation is structural, not a convention.

import { NAG_GLYPHS } from "./annotations";
import type { GameTree, Likelihood, MoveNode, Preference } from "./game-tree";

/**
 * The seven-point position assessment as an ordinal, White-positive scale —
 * the same orientation as the rest of the codebase's numbers, so max/min fall
 * out of the side to move with no per-colour bookkeeping.
 */
export type Assessment = -3 | -2 | -1 | 0 | 1 | 2 | 3;

export type { Likelihood };

// The scale, stored as ordinary position-assessment NAGs (spec 202) so it
// round-trips through PGN with no new storage. NAG 13 ("unclear", ∞) is
// deliberately absent: a node carrying only $13 is explored-but-unassessed,
// which is a real third state and not a synonym for "equal".
export const ASSESSMENT_NAG_BY_VALUE: Record<Assessment, number> = {
  [-3]: 19,
  [-2]: 17,
  [-1]: 15,
  0: 10,
  1: 14,
  2: 16,
  3: 18,
};

/** The assessment NAGs, in scale order — the group setAssessment clears. */
export const ASSESSMENT_NAGS: readonly number[] = [19, 17, 15, 10, 14, 16, 18];

const ASSESSMENT_BY_NAG = new Map<number, Assessment>(
  (Object.entries(ASSESSMENT_NAG_BY_VALUE) as [string, number][]).map(([v, nag]) => [
    nag,
    Number(v) as Assessment,
  ]),
);

/** The position symbol written on a node, whoever wrote it. Display only. */
export function assessmentSymbolOf(node: Pick<MoveNode, "nags">): Assessment | null {
  for (const nag of node.nags) {
    const a = ASSESSMENT_BY_NAG.get(nag);
    if (a !== undefined) return a;
  }
  return null;
}

/**
 * The user's own judgement of a node, or null when they haven't judged it.
 *
 * A position NAG on its own is NOT a judgement of the user's. The same NAGs
 * arrive from PGN import — a downloaded annotated game, or one of the user's
 * own games re-imported after a machine review — and reading those would feed
 * a machine verdict into the backup and the ranking at machine speed, which is
 * exactly the laundering spec 226 G forbids. Only a symbol the app stamped
 * with a human provenance counts. Unstamped symbols stay fully visible as
 * annotations; they are simply invisible here, which is what makes the
 * separation structural rather than a convention.
 */
export function assessmentOf(
  node: Pick<MoveNode, "nags" | "assessedBy">,
): Assessment | null {
  if (node.assessedBy !== "human" && node.assessedBy !== "human-live") return null;
  return assessmentSymbolOf(node);
}

export function assessmentNag(a: Assessment): number {
  return ASSESSMENT_NAG_BY_VALUE[a];
}

export function assessmentGlyph(a: Assessment): string {
  return NAG_GLYPHS[ASSESSMENT_NAG_BY_VALUE[a]];
}

/**
 * A node's backed-up judgement.
 *
 * `objective` is strict minimax over the judged children — the answer to "I
 * looked at nine moves and the tenth is brilliant": the tenth IS the value,
 * because you only have to find one good move.
 *
 * `range` is bounded by the user's vision, not by chess. It reads "as far as I
 * could see". A line can be covered end to end and still lose to a move that
 * was never on the list.
 *
 * `practical` is the expectimax shadow used ONLY to break objective ties, and
 * never shown as a number on its own.
 */
export interface NodeValue {
  objective: number | null;
  /**
   * Whether the objective reading is FIRM or still "maybe" (spec 226, user
   * 2026-07-23). A value backed up from below is a claim that rests on the
   * opponent's replies having been covered — which the app cannot verify, since
   * it has no way to know the reply list is complete. So the value stays
   * provisional ("maybe better") until the player vouches for it: either by
   * assessing this move directly, or by sealing it ("I've covered the replies
   * here"). A move with its own direct assessment is firm; a bare leaf carries
   * no claim to make firm or otherwise, so it reads firm too.
   */
  firm: boolean;
  range: { lo: number; hi: number } | null;
  practical: number | null;
  examined: number;
  named: number;
  allCandidatesExamined: boolean;
  /**
   * Branch width: how many replies out of this node the user marked LIKELY.
   *
   * A narrower branch is worth something — fewer chances for a human to go
   * wrong in it — which is a practical fact no machine will tell you, since
   * machines do not tire. So it is reported beside coverage.
   *
   * NOTHING sorts on it, and that is a correctness requirement rather than a
   * preference (spec 226 I). The count is drawn from the user's own labels and
   * therefore inherits their effort: three likely replies rather than four may
   * mean the position is narrow, or may mean they looked harder at the other
   * one. Ranking on it would let an under-explored branch win for being
   * under-explored, and would be the app passing judgement on the shape of the
   * tree, which it does not do.
   */
  likelyReplies: number;
  /**
   * Sharpness: how many of the user's own judged candidates reach this node's
   * backed-up value. Null when it cannot mean anything yet — see `sharpnessOf`.
   */
  sharpness: Sharpness | null;
}

/**
 * "9 bad and 1 brilliant" and "10 good" back up to the SAME value and have
 * opposite practical character: the first is where a human goes wrong over the
 * board, because it works only if you find the one move. Minimax deliberately
 * throws that difference away (spec 226 B) — the other nine contribute nothing
 * to the value — so it is carried on its own axis here.
 */
export interface Sharpness {
  /** Candidates of the user's own that achieve the node's backed-up value. */
  reaching: number;
  /** The population they are counted out of — see `sharpnessOf` on which. */
  of: number;
}

// Same idiom as the move-numbering helpers: the FEN's side-to-move field, not
// ply parity — a tree can start from any position.
function whiteToMove(node: Pick<MoveNode, "fen">): boolean {
  return node.fen.split(" ")[1] === "w";
}

// Default weight for a reply the user never bucketed: "possible", the middle
// of the three. Assuming anything else would be the app inventing an opponent
// model the user did not supply.
const DEFAULT_WEIGHT: Likelihood = 2;

const BEST = 3;
const WORST = -3;

type Kid = { node: MoveNode; value: NodeValue };

// Coverage counts only the moves the USER produced. A move that arrived from
// the opening book or the game database is chess the app handed them: judging
// it is still their own work and still feeds the backup, but calling it one of
// "my candidates" would overstate what they saw and quietly repair the
// blind-spot record spec 226 H is built on.
function isOwnCandidate(k: Kid): boolean {
  return k.node.src === undefined;
}

/**
 * The bound the notes actually support, in the direction each kind of
 * uncertainty can move it. Shared by both branches of `valueOf` so a node with
 * candidates named but none judged can never read as MORE settled than one
 * with a single judged candidate.
 *
 * `own` is folded in rather than dropped: it is a second, independent human
 * reading of the same node, and when the two disagree the honest display is
 * the disagreement, not the silent deletion of one of them.
 */
function boundedRange(
  lo: number,
  hi: number,
  own: Assessment | null,
  openUp: boolean,
  openDown: boolean,
): { lo: number; hi: number } {
  if (openUp) hi = BEST;
  if (openDown) lo = WORST;
  if (own !== null) {
    lo = Math.min(lo, own);
    hi = Math.max(hi, own);
  }
  return { lo, hi };
}

/**
 * Sharpness at a node, or null when it cannot yet mean anything.
 *
 * MEASURED OVER THE USER'S OWN CANDIDATES, exactly the population coverage
 * uses, and not over every judged child. Three reasons, in order of weight:
 *
 *  1. It has to be read against coverage, so it must be counted out of the same
 *     denominator. "1 of my 6 reach it" beside "6 of my 6 candidates" is one
 *     coherent sentence; counting a book move or the move the sync appended
 *     into the numerator while coverage excludes it from the denominator
 *     produces fractions that cannot be compared with each other at all.
 *  2. Sharpness is a claim about the player's own position over the board —
 *     how many of the moves THEY produced work. A move the app handed them out
 *     of a position-indexed corpus is the app's chess (see `isOwnCandidate`);
 *     letting it count would have the app's contribution quietly widen or
 *     narrow the reading of how sharp the player's own thinking found this.
 *  3. It keeps the blind-spot record intact. A node whose value is reached only
 *     by a src-marked child reads "0 of my 4 reach it" — which is the honest
 *     and, for spec 226 H, the most valuable thing this number ever says.
 *
 * SILENT UNLESS EVERY COUNTED CANDIDATE'S VALUE HAS STOPPED MOVING, and silent
 * on a single candidate:
 *
 *  - One judged candidate would emit "1 of 1", which reads as maximally sharp
 *    when the truth is only that they judged one move. That is a statement
 *    about their effort dressed as a statement about the position, so nothing
 *    is emitted instead.
 *  - With candidates named but not yet judged the count is provisional in a way
 *    the reader cannot see: judging the sixth may double the number that reach
 *    the value, or may raise the value and drop every one of them off it.
 *    Sharpness inherits the same confound branch width has (spec 226 I) —
 *    "only one move works" and "I only judged one move" are indistinguishable
 *    without coverage — and staying quiet until the user's own list is closed
 *    is the only reading of it that is not misleading.
 *  - Closing the list AT THIS NODE is not enough, and that was the subtle bug:
 *    a candidate whose own value is still open drags the same confound up one
 *    ply, invisibly. Six candidates all judged, each explored one reply deep,
 *    emits a settled-looking "1 of my 6 reach it" that a single further reply
 *    under the leading branch moves to a different candidate. Worse, it errs
 *    towards breadth — a candidate whose "+−" rests on one of nine named
 *    replies is counted as reaching the value — so it reads as the forgiving
 *    position when the notes support the sharp one. So a candidate counts only
 *    once its whole subtree is closed AND its range has collapsed to a point:
 *    that is exactly the condition under which its objective can no longer
 *    move, which is what the number is silently asserting about all of them.
 *
 * Even then the number is bounded by vision, not by chess: the named list was
 * the user's and may have been incomplete. Hence "N of my M reach it" and never
 * a phrasing like "only one move works", which would be the app vouching for a
 * claim about the position that it cannot support.
 *
 * NOTHING SORTS ON IT. Same correctness requirement as width, for the same
 * reason: a sharp branch is not thereby better or worse, and ranking on a
 * number drawn from the user's own effort would let the shape of their notes
 * decide the order of their moves.
 */
function sharpnessOf(mine: Kid[], objective: number, examined: number, named: number): Sharpness | null {
  if (examined < 2 || examined !== named) return null;
  if (mine.some((k) => !k.value.allCandidatesExamined || isProvisional(k.value))) return null;
  const reaching = mine.filter((k) => k.value.objective === objective).length;
  return { reaching, of: examined };
}

function valueOf(node: MoveNode, kids: Kid[], myColor: "white" | "black"): NodeValue {
  const own = assessmentOf(node);
  // Firm when the player has vouched for this move: a direct assessment, or the
  // "covered" seal. Everything else backed up from below is a "maybe" — the app
  // may not decide on its own that the opponent's replies were all considered
  // (spec 226, user 2026-07-23).
  const firm = own !== null || node.sealed === true;
  const judged = kids.filter((k) => k.value.objective !== null);
  const mine = kids.filter(isOwnCandidate);
  const named = mine.length;
  const examined = mine.filter((k) => k.value.objective !== null).length;
  const allCandidatesExamined =
    examined === named && kids.every((k) => k.value.allCandidatesExamined);
  // Counted over ALL children, not just the user's own candidates the way
  // coverage is: marking a reply likely is the user's own act of judgement
  // whoever first put the move on the board, and width is a claim about the
  // opponent's behaviour rather than about how hard the user looked.
  const likelyReplies = kids.filter((k) => k.node.lik === 3).length;
  const white = whiteToMove(node);
  // An unexamined candidate of the user's own can only turn out better than
  // what they have found so far; an unexamined reply of the opponent's only
  // worse. So one end of the bound stays open until their own list runs out.
  const openUp = examined < named && white;
  const openDown = examined < named && !white;

  if (judged.length === 0) {
    // A leaf, or a node whose children the user has not judged yet. Unjudged
    // children contribute NOTHING — they are emphatically not read as "equal",
    // which would be a judgement the user never made.
    return {
      objective: own,
      // A leaf's value is the user's own reading (or nothing) — no backed-up
      // claim to hold provisional, so it is firm whenever it says anything.
      firm: true,
      range: own === null ? null : boundedRange(own, own, own, openUp, openDown),
      practical: own,
      examined,
      named,
      allCandidatesExamined,
      likelyReplies,
      // No judged candidate, so there is nothing for one to reach: the value
      // here is the user's reading of this node itself, not a backed-up choice.
      sharpness: null,
    };
  }

  const objs = judged.map((k) => k.value.objective as number);
  // Children override the node's own assessment. That is minimax, and it is
  // what makes the value decay honestly in both directions: one more losing
  // reply for the opponent lowers the min, one more good move for the user
  // raises the max.
  const objective = white ? Math.max(...objs) : Math.min(...objs);

  const los = judged.map((k) => (k.value.range as { lo: number }).lo);
  const his = judged.map((k) => (k.value.range as { hi: number }).hi);
  const range = white
    ? boundedRange(Math.max(...los), Math.max(...his), own, openUp, openDown)
    : boundedRange(Math.min(...los), Math.min(...his), own, openUp, openDown);

  let practical: number;
  const myMove = (white ? "white" : "black") === myColor;
  if (myMove) {
    // The user gets to choose, so no averaging on their own move — and the
    // choice is only ever among the children that achieve the objective value.
    // Carrying up the chances of a line they would never play is hope-chess,
    // and the lexicographic ordering exists precisely to make that impossible
    // (spec 226 D); letting it in through the practical axis would be the same
    // failure by the back door.
    const best = judged.filter((k) => k.value.objective === objective);
    // Mirrors the objective axis above: `practical` is White-positive like
    // everything else here, so the user picks the HIGHEST of it as White and
    // the LOWEST as Black. `myMove` already means the side to move is the
    // user's colour, so `white` is exactly the right discriminator and no
    // extra colour bookkeeping is needed. Taking the max unconditionally would
    // have a Black user's ties broken towards the line that is practically
    // worst for them — the tie-break inverted, silently, only as Black.
    const bests = best.map((k) => k.value.practical as number);
    practical = white ? Math.max(...bests) : Math.min(...bests);
  } else {
    // Normalised across the replies actually assessed — the user names buckets,
    // never percentages, and the buckets they skipped don't dilute the rest.
    let weighted = 0;
    let total = 0;
    for (const k of judged) {
      const w = k.node.lik ?? DEFAULT_WEIGHT;
      weighted += w * (k.value.practical as number);
      total += w;
    }
    practical = weighted / total;
  }

  return {
    objective,
    firm,
    range,
    practical,
    examined,
    named,
    allCandidatesExamined,
    likelyReplies,
    sharpness: sharpnessOf(mine, objective, examined, named),
  };
}

/**
 * Back up the whole tree in one post-order pass, White-positive throughout.
 * `myColor` is needed only for the practical axis — the objective one follows
 * the side to move and needs no colour at all.
 */
export function backupTree(tree: GameTree, myColor: "white" | "black"): Map<string, NodeValue> {
  const out = new Map<string, NodeValue>();
  // Explicit stack: a deeply analysed line is still a line, and blowing the
  // call stack on someone's three-day think would be an unforgivable way to
  // lose their notes.
  const stack: { id: string; expanded: boolean }[] = [{ id: tree.rootId, expanded: false }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const node = tree.get(frame.id);
    if (!node) {
      stack.pop();
      continue;
    }
    if (!frame.expanded) {
      frame.expanded = true;
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ id: node.children[i], expanded: false });
      }
      continue;
    }
    stack.pop();
    const kids: { node: MoveNode; value: NodeValue }[] = [];
    for (const childId of node.children) {
      const child = tree.get(childId);
      const value = out.get(childId);
      if (child && value) kids.push({ node: child, value });
    }
    out.set(node.id, valueOf(node, kids, myColor));
  }
  return out;
}

/** Backed-up value of a single node (convenience; recomputes the tree). */
export function backupAt(
  tree: GameTree,
  id: string,
  myColor: "white" | "black",
): NodeValue | null {
  return backupTree(tree, myColor).get(id) ?? null;
}

/**
 * Lexicographic sibling order: objective value first, practical chances only
 * as a tie-break. This is a safety property, not a preference — pure
 * expectimax would rank a losing move the opponent might not punish above a
 * clean draw, and this ordering makes that structurally impossible.
 *
 * `maximize` is true when the side to move at the shared parent is White.
 * Unjudged siblings sort last and keep their exploration order among
 * themselves; they are not ranked, because there is nothing to rank them by.
 */
export function compareSiblings(
  a: NodeValue | undefined,
  b: NodeValue | undefined,
  maximize: boolean,
): number {
  const ao = a?.objective ?? null;
  const bo = b?.objective ?? null;
  if (ao === null && bo === null) return 0;
  if (ao === null) return 1;
  if (bo === null) return -1;
  if (ao !== bo) return maximize ? bo - ao : ao - bo;
  const ap = a?.practical ?? ao;
  const bp = b?.practical ?? bo;
  if (ap !== bp) return maximize ? bp - ap : ap - bp;
  return 0;
}

/**
 * Copeland score within one tie group: how many recorded head-to-heads each
 * candidate WON against the others in that group (spec 226 I).
 *
 * Human pairwise preferences are not guaranteed transitive — A over B, B over
 * C, C over A is an ordinary thing for a person to feel — so the ranking must
 * not assume a total order it cannot have. Counting wins degrades gracefully:
 * a 3-cycle scores 1-1-1 and simply falls through to the next key, instead of
 * producing an order that depends on which comparison was made first.
 *
 * Comparisons reaching outside the group are ignored, which is what keeps a
 * preference from crossing an objective boundary: the groups ARE the objective
 * ties, so a win can only ever move a candidate within one.
 */
export function copelandScores(
  preferences: readonly Preference[],
  group: readonly string[],
): Map<string, number> {
  const inGroup = new Set(group);
  const score = new Map(group.map((id) => [id, 0]));
  for (const p of preferences) {
    if (!inGroup.has(p.winnerId) || !inGroup.has(p.loserId)) continue;
    score.set(p.winnerId, (score.get(p.winnerId) ?? 0) + 1);
  }
  return score;
}

/**
 * Children of `parentId` in display order — best first for the side to move.
 *
 * Full key order (spec 226 I):
 *
 *     objective value → practical chances → Copeland score → exploration order
 *
 * Branch width is deliberately absent from that list and must stay absent.
 *
 * Display only: the stored tree and the PGN mainline are untouched, because
 * the order the user explored in is real history and their later conclusions
 * do not get to overwrite it (spec 226 F).
 */
export function sortedChildren(
  tree: GameTree,
  values: Map<string, NodeValue>,
  parentId: string,
): string[] {
  const parent = tree.get(parentId);
  if (!parent) return [];
  const maximize = whiteToMove(parent);
  const explored = new Map(parent.children.map((id, i) => [id, i]));
  const byIndex = (x: string, y: string) => explored.get(x)! - explored.get(y)!;
  // Decorated sort: Array.prototype.sort is stable in every runtime we target,
  // but the index tie-break makes the "unjudged keep exploration order"
  // guarantee explicit rather than inherited.
  const ranked = [...parent.children].sort(
    (x, y) => compareSiblings(values.get(x), values.get(y), maximize) || byIndex(x, y),
  );

  // Head-to-heads reorder only WITHIN a run of objectively-and-practically
  // tied siblings. Slicing the runs out first is what makes that structural:
  // the Copeland pass never sees a pair the objective key already separated,
  // so no reason recorded in a comparison can promote a worse move.
  const prefs = tree.preferencesAt(parentId);
  if (prefs.length === 0) return ranked;
  const out: string[] = [];
  for (let i = 0; i < ranked.length; ) {
    let j = i + 1;
    while (
      j < ranked.length &&
      compareSiblings(values.get(ranked[i]), values.get(ranked[j]), maximize) === 0
    ) {
      j++;
    }
    const group = ranked.slice(i, j);
    if (group.length > 1) {
      const score = copelandScores(prefs, group);
      group.sort((x, y) => (score.get(y)! - score.get(x)!) || byIndex(x, y));
    }
    out.push(...group);
    i = j;
  }
  return out;
}

/**
 * How far the most-likely walk is allowed to run.
 *
 * A cap rather than a trust in the tree being finite: the walk follows stored
 * children, and a tree loaded from disk with a cycle in it (a corrupt save, a
 * future editing feature that reparents a node) would otherwise spin forever
 * inside a render. Twenty full moves is far past the depth anyone hand-builds
 * during a three-day think, so the cap never bites in practice.
 */
export const MOST_LIKELY_MAX_PLY = 40;

/** Where the most-likely walk ended up, and how it got there. */
export interface MostLikelyPath {
  /** Node ids after the starting node, in order. Empty when it has no children. */
  path: string[];
  /** The node the walk stopped on — the starting node when it could not move. */
  leafId: string;
  /** True when the depth cap stopped the walk rather than the line running out. */
  truncated: boolean;
}

/**
 * The position the user would most probably actually reach from `fromId` —
 * the representative position of the branch, and the one worth putting on the
 * board when comparing two candidates (spec 226 I).
 *
 * At the OPPONENT's nodes take the reply he is likeliest to play; at the
 * user's own nodes take the move they judged best, because they are the one
 * choosing there. A reply the user never bucketed counts as "possible", the
 * middle of the three — assuming anything else would invent an opponent model
 * they did not supply.
 *
 * The walk steps only through children that already exist. It generates
 * nothing, and a node the user never expanded is where the walk ends — which
 * is honest: that is exactly as far as they looked.
 */
export function mostLikelyPath(
  tree: GameTree,
  values: Map<string, NodeValue>,
  fromId: string,
  myColor: "white" | "black",
  maxPly: number = MOST_LIKELY_MAX_PLY,
): MostLikelyPath {
  const path: string[] = [];
  let cur = tree.get(fromId);
  if (!cur) return { path, leafId: fromId, truncated: false };
  // Guards the cap AND a reparented cycle: a repeat means the walk is going
  // round, and going round is not a longer line.
  const seen = new Set<string>([fromId]);
  while (cur.children.length > 0) {
    if (path.length >= maxPly) return { path, leafId: cur.id, truncated: true };
    const white = whiteToMove(cur);
    const hisMove = (white ? "white" : "black") !== myColor;
    let nextId: string;
    if (hisMove) {
      // Highest likelihood wins; ties keep the order the user explored in, so
      // the walk never depends on anything but their own labels.
      nextId = cur.children.reduce((best, id) => {
        const a = tree.get(id)?.lik ?? DEFAULT_WEIGHT;
        const b = tree.get(best)?.lik ?? DEFAULT_WEIGHT;
        return a > b ? id : best;
      }, cur.children[0]);
    } else {
      // The user's own node: their best move by the same ranking the panel
      // shows, so the walk agrees with what they are reading.
      nextId = sortedChildren(tree, values, cur.id)[0];
    }
    const next = tree.get(nextId);
    if (!next || seen.has(nextId)) return { path, leafId: cur.id, truncated: true };
    seen.add(nextId);
    path.push(nextId);
    cur = next;
  }
  return { path, leafId: cur.id, truncated: false };
}

/**
 * The value in plain words, from the PLAYER's side of the board.
 *
 * The glyphs stay standard and White-positive — that is the notation the user
 * reads fluently and the one PGN carries. But a column of eleven symbol-pairs
 * is eleven decodings, and the whole point of the ranking is to answer "what do
 * I play?" at a glance (user 2026-07-21). So the glyph gets a word beside it,
 * and the word is oriented so that "better" always means better for the reader,
 * whichever colour they have.
 */
export function assessmentWords(a: Assessment, myColor: "white" | "black"): string {
  const mine = (myColor === "white" ? a : -a) as Assessment;
  switch (mine) {
    case 3: return "winning";
    case 2: return "much better";
    case 1: return "better";
    case 0: return "equal";
    case -1: return "worse";
    case -2: return "much worse";
    default: return "losing";
  }
}

/**
 * Rounded plain-word reading of a backed-up value, or "" when unjudged.
 *
 * A provisional value (see `NodeValue.firm`) is prefixed "maybe": the branch
 * backs up to "better", but until the player has vouched that the opponent's
 * replies were covered, the app may only say it MIGHT be better (spec 226).
 */
export function valueWords(v: NodeValue, myColor: "white" | "black"): string {
  if (v.objective === null) return "";
  const clamped = Math.max(-3, Math.min(3, Math.round(v.objective))) as Assessment;
  const word = assessmentWords(clamped, myColor);
  return v.firm ? word : `maybe ${word}`;
}

/**
 * The backed-up value as a SINGLE glyph — what the player currently concludes.
 *
 * Replaces the range as the primary reading. A wide range like "∓ … +−" was
 * unreadable and, worse, redundant: the range only got that wide because few
 * candidates had been examined, so it silently restated the coverage fraction
 * printed beside it (user 2026-07-21, "that is truly confusing"). The value is
 * now the thing you read; how provisional it is, is something you see.
 */
export function formatPoint(v: NodeValue): string {
  if (v.objective === null) return "";
  const clamped = Math.max(-3, Math.min(3, Math.round(v.objective))) as Assessment;
  return assessmentGlyph(clamped);
}

/** True while unexamined candidates of the user's own could still move this. */
export function isProvisional(v: NodeValue): boolean {
  return !!v.range && v.range.lo !== v.range.hi;
}

/** Symbol for a backed-up value: a point when settled, a range when not. */
export function formatValue(v: NodeValue): string {
  if (v.objective === null) return "";
  const point = assessmentGlyph(v.objective as Assessment);
  if (!v.range || v.range.lo === v.range.hi) return point;
  return `${assessmentGlyph(v.range.lo as Assessment)} … ${assessmentGlyph(v.range.hi as Assessment)}`;
}

/**
 * Coverage in the user's own handwriting: "2 of my 6 candidates". Empty when
 * they named none — a "0 candidates" badge would read as a prod to go and
 * name some, and the app does not prod.
 *
 * The wording when everything is covered is "all candidates examined", and
 * never any phrasing that implies objective completeness: the candidate set
 * was the user's and may have been incomplete, and the app will not vouch for
 * a claim it cannot support.
 */
export function coverageLabel(v: NodeValue): string {
  if (!hasCoverageStory(v)) return "";
  if (v.allCandidatesExamined) return "all candidates examined";
  return `${v.examined} of my ${v.named} candidates`;
}

/**
 * Branch width in the user's own handwriting: "3 likely". Empty when they have
 * marked none — a "0 likely" badge would read as a prod to go and label some,
 * and the app does not prod.
 *
 * Displayed BESIDE coverage, never mixed into it and never sorted on: the two
 * numbers are only comparable at equal coverage, which is the reader's job to
 * notice and not the app's to adjudicate.
 */
export function widthLabel(v: NodeValue): string {
  return v.likelyReplies > 0 ? `${v.likelyReplies} likely` : "";
}

/**
 * Sharpness in the user's own handwriting: "1 of my 6 reach it". Empty
 * whenever `sharpness` is null, which is most of the time — see `sharpnessOf`
 * for when the number is allowed to exist at all.
 *
 * Deliberately a bare count and no adjective. "Sharp" would be the app
 * characterising the position, and a colour or an emphasis on the sharp case
 * would be it pointing — both forbidden by "may display state, may never
 * recommend". The reader draws the conclusion; the page just says what they
 * wrote.
 */
export function sharpnessLabel(v: NodeValue): string {
  if (!v.sharpness) return "";
  return `${v.sharpness.reaching} of my ${v.sharpness.of} reach it`;
}

/** Compact form of coverageLabel for a table cell: "2/6". */
export function coverageChip(v: NodeValue): string {
  return hasCoverageStory(v) ? `${v.examined}/${v.named}` : "";
}

/**
 * Whether coverage is worth reporting at all.
 *
 * A node with one candidate has nothing to say: every move of the played game
 * has exactly one child — the move that was actually played — so reporting it
 * stamped "1/1" down the entire game history (user-reported 2026-07-20). There
 * were other moves at the time; one was chosen. That is history, not a
 * candidate set the player worked through, and dressing it as coverage buries
 * the nodes where the number means something.
 *
 * Deliberately NOT "hide when examined === named": that would suppress exactly
 * the honest "I looked at all six of my candidates" report. It is the count of
 * one that carries no information, not the state of being complete.
 */
function hasCoverageStory(v: NodeValue): boolean {
  return v.named > 1;
}

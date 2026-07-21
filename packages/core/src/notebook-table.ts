// The Candidates table (spec 226 C/D/F/I) — Kotov's candidate list as an
// actual table instead of branches scattered through a tree, in the user's own
// words: *"I could write down all legal moves (that I see) on a piece of paper
// and then rank them… I can use excel to sort things"* (user 2026-07-21).
//
// This module is the sorting half, kept out of React so the rules below are
// testable as rules rather than as rendered HTML. It inherits every constraint
// notebook.ts is built on and adds one of its own:
//
//  1. The rows ARE the node's existing children — nothing here generates,
//     counts or names a move the user did not already put on the board,
//     because nothing here knows the rules of chess. A child the app handed
//     them out of the book, or appended because it was played, is still on the
//     board in front of them and still carries their judgement, so it gets a
//     row; what it never gets is to count as one of "my candidates" (that is
//     `isOwnCandidate` over in notebook.ts) OR to be ranked among them. Rows
//     the app supplied sit in their own group after the user's own list, in
//     every order and under every column — see `groupOf`.
//  2. Nothing is read from the engine's field.
//  3. **The user sorts; the app does not.** `sortKey: null` is the default and
//     means "leave the order exactly as it arrived" — the exploration order, or
//     the lexicographic ranking from `sortedChildren` when they asked for it.
//     A column the user clicked is their own hand on their own page.
//  4. **Width is not a sort key at all.** Spec 226 I is unconditional: branch
//     width is "displayed beside coverage and never ranked on", because it is
//     drawn from the user's own likelihood labels and therefore inherits their
//     effort — an under-explored branch would win for being under-explored. A
//     click is not an exemption, because the app would still be the thing that
//     built the ordering. There is deliberately no "width" member of
//     `CandidateSortKey`, and no header to click.

import { assessmentOf } from "./notebook";
import type { Assessment, NodeValue } from "./notebook";
import type { GameTree, Likelihood, MoveSource } from "./game-tree";

/** One candidate: a child of the current node, with everything written on it. */
export interface CandidateRow {
  id: string;
  san: string;
  /** Position in the order the rows arrived — the final tie-break, always. */
  order: number;
  /** The symbol the user wrote on this node itself, if any. */
  mine: Assessment | null;
  /** The backed-up reading of the whole branch under it. */
  value: NodeValue;
  /** Whether anything has been judged under it at all. */
  judged: boolean;
  /** The opponent-likelihood bucket, on his replies only. */
  lik: Likelihood | null;
  /** Absent when the user played the move themselves — see `isOwnCandidate`. */
  src: MoveSource | undefined;
}

/**
 * The columns a reader may sort on. Width is absent by design (see the file
 * header, and spec 226 I) — so is provenance, because the app-supplied rows are
 * grouped out of the user's list already and a column that only ever printed
 * "mine" said nothing.
 */
export type CandidateSortKey = "move" | "mine" | "value" | "coverage" | "likelihood";

export type SortDir = "asc" | "desc";

/**
 * The rows for one node, in the order they were handed in.
 *
 * `order` is taken from that incoming order rather than from the tree, so a
 * caller passing `sortedChildren(...)` gets the ranking as its baseline and a
 * caller passing `node.children` gets exploration order — and in both cases a
 * column sort falls back to whichever the reader was already looking at.
 */
export function candidateRows(
  tree: GameTree,
  values: Map<string, NodeValue>,
  ids: readonly string[],
): CandidateRow[] {
  const rows: CandidateRow[] = [];
  for (const id of ids) {
    const node = tree.get(id);
    const value = values.get(id);
    if (!node || !value) continue;
    rows.push({
      id,
      san: node.san,
      order: rows.length,
      mine: assessmentOf(node),
      value,
      judged: value.objective !== null,
      lik: node.lik ?? null,
      src: node.src,
    });
  }
  return rows;
}

/**
 * Coverage as a single number for sorting: the fraction of the user's own
 * candidates examined under this move, or null where there is no coverage
 * story to tell (one candidate says nothing — see `hasCoverageStory`).
 */
function coverageFraction(v: NodeValue): number | null {
  if (v.named <= 1) return null;
  return v.examined / v.named;
}

/**
 * Which of the three groups a row belongs to, and the ONLY ordering decision
 * this module makes on its own:
 *
 *   0. the user's own candidates that have been judged
 *   1. the user's own candidates, named and not yet looked at
 *   2. everything the app put on the board — a book move, or a move appended
 *      because it was played
 *
 * Group 2 is not a ranking, it is the same distinction `isOwnCandidate` already
 * draws for coverage and sharpness: those moves are the app's chess, so they may
 * never be rendered as the user's own best next move (spec 226 C). Group 1 is
 * the hairline that stops a move merely named from carrying the same visual
 * weight as one actually examined — a named cause of the illegibility complaint
 * (user 2026-07-21). Within every group the incoming order survives untouched.
 */
function groupOf(row: CandidateRow): number {
  if (row.src !== undefined) return 2;
  return row.judged ? 0 : 1;
}

/**
 * The sort value of one row under one column, White-positive numbers reoriented
 * to the reader. Null means "this row has nothing to say here" and always sorts
 * last, in both directions — the alternative is a column whose descending order
 * is a wall of blanks.
 */
function sortValue(
  row: CandidateRow,
  key: CandidateSortKey,
  myColor: "white" | "black",
): number | string | null {
  const flip = myColor === "white" ? 1 : -1;
  switch (key) {
    case "move":
      return row.san;
    case "mine":
      // Oriented so "better" means better for the reader whichever colour they
      // have — the same reorientation `assessmentWords` already does, and for
      // the same reason: the glyphs stay standard, the reading stays theirs.
      return row.mine === null ? null : row.mine * flip;
    case "value":
      return row.value.objective === null ? null : row.value.objective * flip;
    case "coverage":
      return coverageFraction(row.value);
    case "likelihood":
      return row.lik;
  }
}

/** Which group a row is in — the table reads this to place its hairlines. */
export function candidateGroup(row: CandidateRow): number {
  return groupOf(row);
}

/**
 * Which way a column runs the first time it is clicked. Words read a → z;
 * numbers read biggest first, because that is the row the reader clicked the
 * column to find. Either way the next click reverses it, so this decides
 * nothing the user cannot immediately undo.
 */
export function defaultSortDir(key: CandidateSortKey): SortDir {
  return key === "move" ? "asc" : "desc";
}

/**
 * Sort the rows the way the reader asked.
 *
 * Two invariants hold under every key and both directions:
 *
 *  - The three groups never interleave (see `groupOf`): the user's own judged
 *    candidates, then their own named-but-unexamined ones, then anything the
 *    app supplied. A column sort reorders WITHIN a group and never across one,
 *    so a book move cannot reach the top of a list headed "my candidates" and
 *    a move merely named cannot outrank one actually looked at.
 *  - `key === null` sorts nothing: rows keep the order they arrived in inside
 *    their group. That is the default, and the grouping above is the whole of
 *    the app's opinion about their order.
 */
export function sortCandidateRows(
  rows: readonly CandidateRow[],
  key: CandidateSortKey | null,
  dir: SortDir,
  myColor: "white" | "black",
): CandidateRow[] {
  const grouped = (rs: readonly CandidateRow[], cmp?: (a: CandidateRow, b: CandidateRow) => number) =>
    [0, 1, 2].flatMap((g) => {
      const run = rs.filter((r) => groupOf(r) === g);
      return cmp ? run.sort(cmp) : run;
    });
  if (key === null) return grouped(rows);
  const sign = dir === "desc" ? -1 : 1;
  const cmp = (a: CandidateRow, b: CandidateRow): number => {
    const av = sortValue(a, key, myColor);
    const bv = sortValue(b, key, myColor);
    if (av === null && bv === null) return a.order - b.order;
    if (av === null) return 1;
    if (bv === null) return -1;
    const base =
      typeof av === "string" && typeof bv === "string"
        ? av.localeCompare(bv)
        : (av as number) - (bv as number);
    return base * sign || a.order - b.order;
  };
  return grouped(rows, cmp);
}

"use client";

// The Candidates table (spec 226) — the user's own description of what they
// wanted: *"I could write down all legal moves (that I see) on a piece of paper
// and then rank them… I can use excel to sort things"* (user 2026-07-21).
//
// It is Kotov's candidate list as one table instead of branches scattered
// through a tree: at the current node, one row per move already on the board
// there, one column per thing the notebook knows about it. The columns are
// clickable, so the reader ranks their own list by whichever fact they care
// about at that moment.
//
// The constraints it inherits, and the ones it adds:
//
//  1. Nothing renders over the board. This is a panel tab; it takes no space
//     from the board and never draws on it (rejected twice — user 2026-07-20).
//  2. It never names, counts or hints at a move the user did not already put on
//     the board. The rows are the node's existing children; there is no chess
//     in this file at all.
//  3. It never recommends and never ranks by attention-needed. The DEFAULT
//     order is whatever order it was handed — exploration order, or the
//     lexicographic ranking the strip's toggle asks for. Width has no header to
//     click at all (spec 226 I: displayed beside coverage, never ranked on),
//     and moves the app supplied are grouped out of the user's list rather than
//     ranked inside it.
//  4. No engine field, anywhere.
//  5. Nothing below 13px, no two cells restating one fact, and **it has to fit**.
//     The panel is `clamp(320px, 30vw, 460px)` wide, so a column that only
//     speaks on some nodes is rendered only on those nodes: a table the reader
//     has to scroll sideways cannot show a move and its coverage at once, which
//     is the one thing a table is for.

import { Fragment, useEffect, useState } from "react";
import {
  assessmentGlyph,
  coverageChip,
  coverageLabel,
  valueWords,
  widthLabel,
} from "@chessgui/core/notebook";
import type { NodeValue } from "@chessgui/core/notebook";
import {
  candidateGroup,
  candidateRows,
  defaultSortDir,
  sortCandidateRows,
} from "@chessgui/core/notebook-table";
import type { CandidateRow, CandidateSortKey, SortDir } from "@chessgui/core/notebook-table";
import { moveNumberPrefix } from "@chessgui/core/game-tree";
import type { GameTree, MoveNode } from "@chessgui/core/game-tree";
import { NotebookBadge } from "@chessgui/ui/notebook-value";
import { LIKELIHOOD_KEYS } from "@chessgui/ui/notebook-panel";

export interface NotebookTableProps {
  tree: GameTree;
  /** The ROOT of the tree — its children are the top level. In fair play this
   *  is the live position, so the tree is the whole forward exploration and
   *  stays put as the cursor moves through it. */
  node: MoveNode;
  /** The cursor's node, highlighted inside the tree and auto-revealed (its
   *  ancestors expand) whenever it changes. Omit to just render the tree. */
  currentId?: string;
  values: Map<string, NodeValue>;
  myColor: "white" | "black";
  /**
   * The rows' baseline order — `sortedChildren` when the strip's toggle says
   * "as I rank", `node.children` when it says "as I explored". It is also what
   * the table falls back to when the reader clears their column sort, which is
   * why the table never has to invent an order of its own.
   */
  order: readonly string[];
  onGoToNode: (id: string) => void;
  /** Mark a row "covered" (spec 226): promotes its "maybe X" to a firm ranking. */
  onSetSealed?: (id: string, sealed: boolean) => void;
  /**
   * Open the head-to-head on two candidates (spec 226 I) — the same affordance
   * the strip offers, so a reader working in the table never has to change tabs
   * to run the comparison. The PAIR IS THE USER'S: two taps, no suggestion.
   */
  onCompare?: (aId: string, bId: string) => void;
  /** Bumped on every tree mutation — `tree` is a stable instance reference. */
  version?: number;
}

interface Column {
  key: CandidateSortKey;
  label: string;
  title: string;
  /** Numeric columns read right-aligned, like the spreadsheet this imitates. */
  numeric?: boolean;
}

/**
 * The sortable columns, left to right in the order a player reads a line: what
 * the move is, what the branch under it backs up to, and how much of their own
 * list that rests on.
 *
 * "My symbol" and "He plays it" join them only on nodes where they have
 * something to say — see `NotebookTable`. Width is NOT here: it is rendered as
 * a plain cell with no header button, because spec 226 I forbids ranking on it
 * outright and a click would not make the app any less the thing that built the
 * ordering.
 */
export const CANDIDATE_COLUMNS: Column[] = [
  { key: "move", label: "Move", title: "The move — sort A to Z" },
  {
    key: "value",
    label: "Backs up to",
    title: "The backed-up value of the whole branch under it",
  },
  {
    key: "coverage",
    label: "Seen",
    title: "How many of my own candidates I examined under it — as far as I could see",
    numeric: true,
  },
];

/** Only drawn where it says something the "Backs up to" column does not. */
const MINE_COLUMN: Column = {
  key: "mine",
  label: "Mine",
  title: "What I wrote on this move itself, where it differs from what the branch backs up to",
};

/** Only drawn on the opponent's replies, which are the only moves that carry it. */
const LIK_COLUMN: Column = {
  key: "likelihood",
  label: "He plays it",
  title: "How likely he is to play it, on his replies",
};

const WIDTH_TITLE =
  "How many of his replies I marked likely. Read beside coverage — the two are only comparable at equal coverage, and nothing sorts on it";

const GROUP_CAPTIONS: Record<number, string> = {
  1: "named, not looked at",
  2: "also on the board — not my own list",
};

function SortArrow({ dir }: { dir: SortDir }) {
  return <span className="ml-1 text-[13px] opacity-70">{dir === "asc" ? "▲" : "▼"}</span>;
}

function sourceText(src: CandidateRow["src"]): string {
  if (src === "played") return "played";
  if (src === "database") return "book";
  // Silence is the ordinary case: a move the user named needs no label, and a
  // column full of "mine" spent the scarcest width on the screen saying nothing.
  return "";
}

function likText(row: CandidateRow): string {
  return LIKELIHOOD_KEYS.find((k) => k.value === row.lik)?.label ?? "";
}

export function NotebookTable({
  tree,
  node,
  currentId,
  values,
  myColor,
  order,
  onGoToNode,
  onSetSealed,
  onCompare,
}: NotebookTableProps) {
  // Null is the default and means "the order I was handed" — see the file
  // header. It is deliberately not a column.
  const [sort, setSort] = useState<{ key: CandidateSortKey; dir: SortDir } | null>(null);
  // A different node is a different list; carrying a sort across would have the
  // reader looking at an order they chose for a question they have left.
  useEffect(() => setSort(null), [node.id]);

  // Two at a time, oldest dropped — the same rule as the strip's picker, so the
  // affordance behaves identically on whichever tab the reader is on.
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => setPicked([]), [node.id]);
  const togglePick = (id: string) =>
    setPicked((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-2),
    );

  // Folder tree (spec 226, user 2026-07-23): a row whose move has explored
  // sub-lines under it can open in place, like a folder, rather than only
  // navigating away. Default collapsed — the top level IS the candidate list,
  // and a folder opens because the reader asked, not because the app decided.
  // Reset on a node change: a different position is a different list.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => setExpanded(new Set()), [node.id]);
  const toggleExpand = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Reveal the cursor: open every ancestor between the root and currentId so the
  // highlighted move is always visible in the tree. Only when currentId is
  // actually under this root (behind the live position, it is not) — otherwise
  // it would open unrelated branches. Opens; never closes what the reader opened.
  useEffect(() => {
    if (!currentId || currentId === node.id) return;
    const ancestors: string[] = [];
    let reached = false;
    let cur = tree.get(currentId)?.parent ? tree.get(tree.get(currentId)!.parent!) : undefined;
    while (cur) {
      if (cur.id === node.id) {
        reached = true;
        break;
      }
      ancestors.push(cur.id);
      cur = cur.parent ? tree.get(cur.parent) : undefined;
    }
    if (reached && ancestors.length) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const id of ancestors) next.add(id);
        return next;
      });
    }
  }, [currentId, node.id, tree]);

  const sortLevel = (ids: readonly string[]) =>
    sortCandidateRows(
      candidateRows(tree, values, ids),
      sort?.key ?? null,
      sort?.dir ?? "asc",
      myColor,
    );

  const rows = sortLevel(order);

  // The visible rows, depth-first: a row, then its children when it is open,
  // each carrying its indent depth and whether it can open at all. Every level
  // obeys the same column sort, so sorting sorts the whole tree, not just the
  // top. The tree the reader explored is finite and small, so the recursion is
  // cheap and needs no memo.
  interface VisibleRow {
    row: CandidateRow;
    depth: number;
    hasKids: boolean;
  }
  const buildVisible = (ids: readonly string[], depth: number): VisibleRow[] => {
    const out: VisibleRow[] = [];
    for (const row of sortLevel(ids)) {
      const kids = tree.get(row.id)?.children ?? [];
      out.push({ row, depth, hasKids: kids.length > 0 });
      if (kids.length > 0 && expanded.has(row.id)) {
        out.push(...buildVisible(kids, depth + 1));
      }
    }
    return out;
  };
  const visible = buildVisible(order, 0);

  // Three clicks per column: this way, the other way, and back to the order I
  // arrived in. The third state matters — without it the reader can never get
  // their own exploration order back without leaving the tab.
  const clickHeader = (key: CandidateSortKey) =>
    setSort((cur) => {
      if (!cur || cur.key !== key) return { key, dir: defaultSortDir(key) };
      if (cur.dir === defaultSortDir(key)) {
        return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
      }
      return null;
    });

  if (rows.length === 0) {
    return (
      <div className="p-3 text-[13px] text-muted-foreground/70" data-testid="notebook-table-empty">
        Nothing on the board at {node.parent === null ? "the starting position" : `${moveNumberPrefix(node)} ${node.san}`} yet.
      </div>
    );
  }

  // Columns that only earn their width on some nodes. "Mine" repeats the
  // backed-up glyph on every childless candidate — three rows in four, in the
  // user's own report — so it appears only where the two actually differ, which
  // is the only case it was ever for. Read over the VISIBLE rows, not just the
  // top level: opening a line of opponent replies brings their likelihoods into
  // view, so the "He plays it" column has to arrive with them (and leave when
  // the line collapses again).
  const visibleRows = visible.map((v) => v.row);
  const showMine = visibleRows.some((r) => r.mine !== null && r.value.objective !== r.mine);
  const showLik = visibleRows.some((r) => r.lik !== null);
  const showWidth = visibleRows.some((r) => r.value.likelyReplies > 0);
  const columns = showMine
    ? [CANDIDATE_COLUMNS[0], MINE_COLUMN, ...CANDIDATE_COLUMNS.slice(1)]
    : CANDIDATE_COLUMNS;
  const colCount = columns.length + (showWidth ? 1 : 0) + (showLik ? 1 : 0) + (onCompare ? 1 : 0);

  // Only the user's own judged candidates can be compared with each other — the
  // head-to-head is between two branches of their own list (spec 226 I).
  const comparable = rows.filter((r) => candidateGroup(r) === 0).length;

  return (
    <div className="h-full overflow-auto" data-testid="notebook-table">
      <table className="w-full text-[13px] border-collapse">
        <thead className="sticky top-0 bg-card z-10">
          <tr className="border-b border-white/15">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`px-1.5 py-1.5 font-medium text-muted-foreground ${
                  c.numeric ? "text-right" : "text-left"
                }`}
              >
                <button
                  type="button"
                  onClick={() => clickHeader(c.key)}
                  title={c.title}
                  data-testid={`notebook-table-sort-${c.key}`}
                  className={`text-[13px] whitespace-nowrap hover:text-foreground transition-colors ${
                    sort?.key === c.key ? "text-foreground" : ""
                  }`}
                >
                  {c.label}
                  {sort?.key === c.key && <SortArrow dir={sort.dir} />}
                </button>
              </th>
            ))}
            {showWidth && (
              // No button, no sort testid: this header is not a control, and
              // that is the whole of spec 226 I's "never ranked on".
              <th
                scope="col"
                className="px-1.5 py-1.5 font-medium text-right text-muted-foreground whitespace-nowrap"
                title={WIDTH_TITLE}
                data-testid="notebook-table-width-header"
              >
                Width
              </th>
            )}
            {showLik && (
              <th
                scope="col"
                className="px-1.5 py-1.5 font-medium text-left text-muted-foreground"
              >
                <button
                  type="button"
                  onClick={() => clickHeader(LIK_COLUMN.key)}
                  title={LIK_COLUMN.title}
                  data-testid={`notebook-table-sort-${LIK_COLUMN.key}`}
                  className={`text-[13px] whitespace-nowrap hover:text-foreground transition-colors ${
                    sort?.key === LIK_COLUMN.key ? "text-foreground" : ""
                  }`}
                >
                  {LIK_COLUMN.label}
                  {sort?.key === LIK_COLUMN.key && <SortArrow dir={sort.dir} />}
                </button>
              </th>
            )}
            {onCompare && <th scope="col" className="px-1 py-1.5" />}
          </tr>
        </thead>
        <tbody>
          {visible.map(({ row, depth, hasKids }, i) => {
            const group = candidateGroup(row);
            // A group caption belongs to the TOP level only (my candidates vs
            // the app's supplied moves). It fires when the previous top-level
            // row was a different group — expanded children in between do not
            // reset it, so the hairline still reads as "everything below here is
            // the next group". Deeper levels get no captions; their nesting is
            // the structure, not the grouping.
            const prevTop = [...visible.slice(0, i)].reverse().find((v) => v.depth === 0);
            const newGroup =
              depth === 0 && prevTop !== undefined && group !== candidateGroup(prevTop.row);
            const isOpen = expanded.has(row.id);
            return (
              <Fragment key={row.id}>
                {newGroup && (
                  <tr data-testid={`notebook-table-group-${group}`}>
                    <td
                      colSpan={colCount}
                      className="px-1.5 pt-2 pb-0.5 border-t border-white/10 text-[13px] text-muted-foreground/60"
                    >
                      {GROUP_CAPTIONS[group]}
                    </td>
                  </tr>
                )}
                <tr
                  onClick={() => {
                    // Clicking a move walks the board to it AND reveals its
                    // lines in place. The tree is rooted at live, so this drills
                    // in without re-rooting — no more "flip to the next level".
                    onGoToNode(row.id);
                    if (hasKids) setExpanded((s) => new Set(s).add(row.id));
                  }}
                  data-san={row.san}
                  data-depth={depth}
                  data-testid={row.judged ? "notebook-table-row" : "notebook-table-row-unjudged"}
                  className={`cursor-pointer hover:bg-white/5 ${
                    row.id === currentId ? "bg-white/10" : ""
                  } ${
                    // Quiet, not hidden: these are still on the board and the
                    // record of having named them matters, but they have
                    // nothing to report yet and must not compete with a line
                    // that does.
                    row.judged ? "" : "text-muted-foreground/60"
                  }`}
                >
                  <td
                    className="px-1.5 py-1 font-mono whitespace-nowrap"
                    // Indent by depth so the nesting reads as a folder tree;
                    // the disclosure triangle sits at the head of each move.
                    style={{ paddingLeft: 6 + depth * 16 }}
                  >
                    {hasKids ? (
                      <button
                        type="button"
                        // The triangle opens the line in place; it must not move
                        // the board, so it stops the row's navigate click.
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(row.id);
                        }}
                        data-testid="notebook-tree-toggle"
                        title={isOpen ? "Collapse this line" : "Open the lines I explored under it"}
                        className="mr-1 inline-block w-3 text-center text-muted-foreground/70 hover:text-foreground transition-colors"
                      >
                        {isOpen ? "▾" : "▸"}
                      </button>
                    ) : (
                      // A leaf keeps the same indent as its expandable siblings.
                      <span className="mr-1 inline-block w-3" aria-hidden />
                    )}
                    {/* The cream is on the JUDGED rows only — a hardcoded colour
                        here beat the row's mute, and since every other cell of
                        an unjudged row is empty the distinction vanished
                        entirely (user 2026-07-21: moves never judged carrying
                        the same visual weight). */}
                    <span className={row.judged ? "text-[#e8e4dd]" : ""}>{row.san}</span>
                    {sourceText(row.src) && (
                      <span
                        className="ml-1.5 font-sans text-[13px] text-muted-foreground/60"
                        title={
                          row.src === "played"
                            ? "Played in the game — not a move I named"
                            : "From the book, not my own list"
                        }
                      >
                        {sourceText(row.src)}
                      </span>
                    )}
                  </td>
                  {showMine && (
                    <td className="px-1.5 py-1 font-mono">
                      {/* Blank where it agrees with the backed-up value, which
                          is every childless candidate: printing both gave rows
                          reading "d4 | ⩱ | ⩱ worse" — one number, three times. */}
                      <span className={row.judged ? "text-[#c9d99a]" : ""}>
                        {row.mine === null || row.value.objective === row.mine
                          ? ""
                          : assessmentGlyph(row.mine)}
                      </span>
                    </td>
                  )}
                  <td className="px-1.5 py-1">
                    {/* No "?": the Seen column one cell over IS the coverage
                        statement, and the marker was a second drawing of it. */}
                    <NotebookBadge value={row.value} marker={false} />
                    <span className="text-muted-foreground">{valueWords(row.value, myColor)}</span>
                    {/* The seal: only where the value is BACKED UP (not the
                        user's own direct symbol) — that is the only reading a
                        "maybe" applies to, and the only one covering the replies
                        can make firm. row.value.firm here IS the sealed state,
                        since a row with no direct symbol is firm only when
                        sealed. */}
                    {onSetSealed && row.value.objective !== null && row.mine === null && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSetSealed(row.id, !row.value.firm);
                        }}
                        data-testid="notebook-seal"
                        title={
                          row.value.firm
                            ? "Covered — I've looked at enough of his replies here (click to unmark)"
                            : "Still “maybe”. Mark covered once I've looked at enough of his replies"
                        }
                        className={`ml-1.5 px-1 rounded-sm text-[13px] leading-none transition-colors ${
                          row.value.firm
                            ? "text-[#9bc700]"
                            : "text-muted-foreground/40 hover:text-foreground hover:bg-white/5"
                        }`}
                      >
                        ✓
                      </button>
                    )}
                  </td>
                  <td
                    className="px-1.5 py-1 text-right font-mono text-muted-foreground/80 whitespace-nowrap"
                    title={coverageLabel(row.value)}
                  >
                    {coverageChip(row.value)}
                  </td>
                  {showWidth && (
                    <td
                      className="px-1.5 py-1 text-right text-amber-300/70 whitespace-nowrap"
                      title={row.value.likelyReplies > 0 ? WIDTH_TITLE : undefined}
                      data-testid={row.value.likelyReplies > 0 ? "notebook-table-width" : undefined}
                    >
                      {widthLabel(row.value)}
                    </td>
                  )}
                  {showLik && (
                    <td className="px-1.5 py-1 text-amber-300/70 whitespace-nowrap">
                      {likText(row)}
                    </td>
                  )}
                  {onCompare && (
                    <td className="px-1 py-1 text-right">
                      {depth === 0 && group === 0 && comparable > 1 && (
                        <button
                          type="button"
                          // The row navigates; marking a candidate for a
                          // comparison must not move the board under it.
                          onClick={(e) => {
                            e.stopPropagation();
                            togglePick(row.id);
                          }}
                          data-testid="notebook-compare-pick"
                          title="Mark this one for a head-to-head"
                          className={`px-1 rounded-sm text-[13px] leading-none transition-colors ${
                            picked.includes(row.id)
                              ? "text-white bg-[rgba(155,199,0,0.25)]"
                              : "text-muted-foreground/50 hover:text-foreground hover:bg-white/5"
                          }`}
                        >
                          ⚖
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              </Fragment>
            );
          })}
          {/* Appears only once the USER has marked two. The app never proposes a
              pair — choosing which comparison is worth making is choosing what
              matters in the position, and that is their job. */}
          {onCompare && picked.length === 2 && (
            <tr>
              <td colSpan={colCount} className="px-1.5 py-2">
                <button
                  type="button"
                  onClick={() => onCompare(picked[0], picked[1])}
                  data-testid="notebook-compare-open"
                  className="px-2 py-1 rounded-md border border-[#9bc700]/60 text-[13px] text-[#c9d99a] hover:bg-[rgba(155,199,0,0.15)] text-left"
                >
                  Compare {tree.get(picked[0])?.san} and {tree.get(picked[1])?.san} side by side
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

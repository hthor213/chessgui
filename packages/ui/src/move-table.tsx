"use client";

// The fair-play move table (spec 219 F) — chess.com's Daily layout, which is
// what the user is already fluent in: one row per move number, White and Black
// side by side, and the time each side spent on that move.
//
// It exists alongside (not instead of) the flowing MoveList: the flowing list
// is the annotator's view, good for dense variation trees. This one is the
// game-record view, good for "where are we and how long has this taken" — the
// question a 3-days-per-move game actually raises.
//
// The live pointer is the organising idea, and it is where the table ENDS.
// Rows are the game: moves up to and including the live node, the ones that
// were actually played. Past it nothing was played, so there is no mainline to
// continue — the branches out of the live position are peers, listed below the
// divider with none of them privileged (user 2026-07-21, "these are all
// variations"). Confusing the two is the entire reason spec 219 F exists.
//
// 13px floor, like everything else in this panel (spec 226, user 2026-07-21).
// This is the tab the notebook strip sits on top of and the one the reader
// looks at most; the floor was raised around it first and it read as the one
// illegible thing left in the panel. Subordinate labels — move numbers, clocks,
// the "exploring" divider — earn their place with colour and case, never size.

import { ScrollArea } from "@chessgui/ui/ui/scroll-area";
import { nagsToGlyphs } from "@chessgui/core/annotations";
import { moveSlot } from "@chessgui/core/game-tree";
import type { GameTree, MoveNode } from "@chessgui/core/game-tree";
import { renderLine } from "@chessgui/ui/move-list";
import { sortedChildren } from "@chessgui/core/notebook";
import { NotebookBadge } from "@chessgui/ui/notebook-value";
import type { NotebookRender } from "@chessgui/ui/notebook-value";

export interface MoveTableProps {
  tree: GameTree;
  currentId: string;
  onGoToNode: (id: string) => void;
  /** Bumped on every tree mutation — `tree` is a stable instance reference. */
  version?: number;
  /** The real game's position; everything past it is exploration. */
  liveNodeId?: string | null;
  /** Show the per-move time column (chess.com daily `[%clk]` = time spent). */
  showTimes?: boolean;
  /**
   * The Notebook reading of the same tree (spec 226): backed-up values beside
   * the moves, and the user's alternatives ranked instead of chronological.
   * The played game itself keeps its order in every case — it is what
   * happened, not a candidate list.
   */
  notebook?: NotebookRender;
}

/**
 * Time a move took, chess.com-style: "31 mins", "1 hr", "2 days".
 *
 * For chess.com Daily games the PGN's `[%clk]` is the time SPENT on the move,
 * not the time remaining (established while calibrating performance Elo) — so
 * this renders the stored value directly rather than differencing it.
 */
export function formatMoveTime(seconds: number | undefined): string {
  if (seconds == null) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"}`;
  const hours = seconds / 3600;
  if (hours < 24) {
    const h = Math.round(hours * 10) / 10;
    return `${h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)} hr${h === 1 ? "" : "s"}`;
  }
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days % 1 === 0 ? days.toFixed(0) : days.toFixed(1)} days`;
}

/** One move number's worth of the mainline. Either side may be missing. */
interface Row {
  moveNo: number;
  white?: MoveNode;
  black?: MoveNode;
  /** Variation heads branching off this row's moves, in play order. */
  variations: { afterId: string; headIds: string[] }[];
}

/**
 * The mainline as rows, with each move's sibling variations attached to the
 * move they branch from.
 */
export function buildRows(tree: GameTree, stopAfterPly?: number | null): Row[] {
  const rows: Row[] = [];
  let id: string | undefined = tree.root().children[0];

  while (id) {
    const node: MoveNode | undefined = tree.get(id);
    if (!node) break;
    const { isWhite, moveNo } = moveSlot(node);
    // The table is the GAME. Past the live position nothing was played, so
    // there is no mainline to continue — the rows stop and the peers below
    // take over (spec 226, user 2026-07-21).
    if (stopAfterPly != null && node.ply > stopAfterPly) break;

    let row = rows[rows.length - 1];
    if (!row || row.moveNo !== moveNo || (isWhite ? row.white : row.black)) {
      row = { moveNo, variations: [] };
      rows.push(row);
    }
    if (isWhite) row.white = node;
    else row.black = node;

    const parent = node.parent ? tree.get(node.parent) : undefined;
    if (parent && parent.children[0] === node.id && parent.children.length > 1) {
      row.variations.push({ afterId: node.id, headIds: parent.children.slice(1) });
    }
    id = node.children[0];
  }
  return rows;
}

/**
 * The alternatives hanging off one played move, ranked when the notebook asks
 * for it. The played move keeps its column — it is what actually happened —
 * so only its siblings are re-ordered against each other.
 */
export function variationHeads(
  tree: GameTree,
  v: { afterId: string; headIds: string[] },
  notebook?: NotebookRender,
): string[] {
  if (!notebook?.sortByRank) return v.headIds;
  const parentId = tree.get(v.afterId)?.parent;
  if (!parentId) return v.headIds;
  return sortedChildren(tree, notebook.values, parentId).filter((id) => id !== v.afterId);
}

function Cell({
  node,
  isCurrent,
  isExploration,
  onClick,
  notebook,
}: {
  node: MoveNode | undefined;
  isCurrent: boolean;
  isExploration: boolean;
  onClick: () => void;
  notebook?: NotebookRender;
}) {
  if (!node) return <span />;
  return (
    <span className="inline-flex items-baseline min-w-0">
      <span
        className={[
          "font-mono text-sm px-1.5 py-0.5 rounded-sm cursor-pointer truncate",
          isCurrent
            ? "font-bold text-white bg-[rgba(155,199,0,0.25)]"
            : isExploration
              ? "italic text-[#7a7875] hover:bg-white/5"
              : "text-[#dcdcdc] hover:bg-white/5",
        ].join(" ")}
        onClick={onClick}
        data-testid={isExploration ? "move-cell-exploring" : "move-cell"}
      >
        {node.san}
        {node.nags.length ? nagsToGlyphs(node.nags) : ""}
      </span>
      {notebook && <NotebookBadge value={notebook.values.get(node.id)} />}
    </span>
  );
}

export function MoveTable({
  tree,
  currentId,
  onGoToNode,
  liveNodeId,
  showTimes = true,
  notebook,
}: MoveTableProps) {
  const liveNode = liveNodeId ? tree.get(liveNodeId) : undefined;
  const livePly = liveNode?.ply ?? null;
  const rows = buildRows(tree, livePly);

  /**
   * Exploration past the live position, as PEERS — no mainline (user
   * 2026-07-21: "these are all variations").
   *
   * Past the live node nothing was played, so "mainline" there means only
   * "what I typed first", and rendering one branch in the game's own column
   * while the rest get parenthesised states a preference the player never
   * expressed. Two things follow from flattening it. The honest one: the
   * branches are peers, so they look like peers. The practical one the user
   * named: peers can be REORDERED as the ranking changes, the way engine lines
   * trade places in a MultiPV readout, whereas a privileged mainline makes a
   * re-rank a structural event — parentheses appearing, indentation moving,
   * one line dropping out of the game's own column.
   *
   * Nesting resumes normally INSIDE each peer: there you really are following
   * a sequence.
   */
  const peers = liveNode ? peerLines(tree, liveNode, notebook) : [];

  if (rows.length === 0 && peers.length === 0) {
    return (
      <div className="px-2 py-3 text-sm text-muted-foreground">
        No moves yet — sync to pull the game from chess.com.
      </div>
    );
  }

  const cols = showTimes ? "grid-cols-[2.5rem_1fr_1fr_4.5rem]" : "grid-cols-[2.5rem_1fr_1fr]";

  return (
    <ScrollArea className="h-full">
      <div className={`grid ${cols} items-center gap-x-1 gap-y-0.5 pr-2`}>
        {rows.map((row, i) => (
          <div key={row.moveNo + "-" + i} className="contents">
            <span className="text-[13px] font-mono text-muted-foreground select-none text-right pr-1">
              {row.moveNo}.
            </span>
            <Cell
              node={row.white}
              isCurrent={row.white?.id === currentId}
              isExploration={false}
              onClick={() => row.white && onGoToNode(row.white.id)}
              notebook={notebook}
            />
            <Cell
              node={row.black}
              isCurrent={row.black?.id === currentId}
              isExploration={false}
              onClick={() => row.black && onGoToNode(row.black.id)}
              notebook={notebook}
            />
            {showTimes && (
              <span className="text-[13px] font-mono text-muted-foreground/70 text-right select-none leading-tight">
                {row.white?.clock != null && <>{formatMoveTime(row.white.clock)}</>}
                {row.white?.clock != null && row.black?.clock != null && <br />}
                {row.black?.clock != null && <>{formatMoveTime(row.black.clock)}</>}
              </span>
            )}
            {/* Variations span the full width — a White|Black grid can't hold
                a branching line, so they break out as indented blocks. */}
            {row.variations.map((v) =>
              variationHeads(tree, v, notebook).map((headId) => (
                <div
                  key={`var-${headId}`}
                  className="col-span-full my-0.5 ml-6 pl-2 border-l border-[#3a3835] text-[#9a9a9a] leading-6"
                >
                  <span className="text-[13px] mr-0.5 select-none">(</span>
                  {/* This loop is the one placing the branches off this move,
                      so the head must not emit its siblings a second time. */}
                  {renderLine(tree, headId, currentId, onGoToNode, 1, false, notebook, true)}
                  <span className="text-[13px] ml-0.5 select-none">)</span>
                </div>
              )),
            )}
          </div>
        ))}
      </div>

      {peers.length > 0 && (
        <div data-testid="exploring-peers">
          <div className="flex items-center gap-2 my-1 select-none" data-testid="exploring-divider">
            <span className="h-px flex-1 bg-amber-800/50" />
            <span className="text-[13px] uppercase tracking-wider text-amber-600/90">
              exploring
            </span>
            <span className="h-px flex-1 bg-amber-800/50" />
          </div>
          {peers.map((headId) => (
            <div
              key={`peer-${headId}`}
              data-testid="exploring-peer"
              data-san={tree.get(headId)?.san}
              className="flex items-start gap-1.5 px-1 py-0.5 leading-6"
            >
              <span className="text-[13px] text-muted-foreground/60 select-none">·</span>
              <span className="min-w-0">
                {/* depth 0, no parentheses: a peer is not subordinate to
                    anything. The head owns its own siblings' rendering here,
                    so renderLine must not emit them again. */}
                {renderLine(tree, headId, currentId, onGoToNode, 0, false, notebook, true)}
              </span>
            </div>
          ))}
        </div>
      )}
    </ScrollArea>
  );
}

/**
 * The branches out of the live position, in display order — every child of the
 * live node, with no mainline privilege. Ordered by the notebook ranking when
 * the reader asked for that, otherwise in the order they were explored.
 */
export function peerLines(
  tree: GameTree,
  liveNode: MoveNode,
  notebook?: NotebookRender,
): string[] {
  const kids = liveNode.children;
  if (kids.length === 0) return [];
  return notebook?.sortByRank
    ? sortedChildren(tree, notebook.values, liveNode.id)
    : kids;
}

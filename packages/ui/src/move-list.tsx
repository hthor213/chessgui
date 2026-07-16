"use client"

import { Card } from "@chessgui/ui/ui/card"
import { ScrollArea } from "@chessgui/ui/ui/scroll-area"
import { formatEval, nagsToGlyphs, nodeEval, splitComment } from "@chessgui/core/annotations"
import type { GameTree, MoveNode } from "@chessgui/core/game-tree"

interface MoveListProps {
  tree: GameTree;
  currentId: string;
  onGoToNode: (id: string) => void;
  // Bumped on every tree mutation so React re-renders even though `tree` is a
  // stable instance reference.
  version?: number;
  /**
   * Per-move eval badges on mainline moves (spec 202). Off in play mode and
   * under the spec 219 lockout — the evals are engine-derived, same gating
   * as the eval graph.
   */
  showEvals?: boolean;
}

function moveNumberLabel(node: MoveNode, forceBlack: boolean): string | null {
  const isWhite = node.ply % 2 === 1;
  const moveNo = Math.ceil(node.ply / 2);
  if (isWhite) return `${moveNo}.`;
  if (forceBlack) return `${moveNo}...`;
  return null;
}

function MoveToken({
  node,
  isCurrent,
  label,
  evalBadge,
  onClick,
}: {
  node: MoveNode;
  isCurrent: boolean;
  label: string | null;
  evalBadge: string | null;
  onClick: () => void;
}) {
  const nags = node.nags.length ? nagsToGlyphs(node.nags) : "";
  return (
    <span className="inline-flex items-baseline">
      {label && (
        <span className="text-xs text-muted-foreground font-mono mr-1 select-none">{label}</span>
      )}
      <span
        className={`text-sm font-mono px-1 py-px rounded-sm cursor-pointer ${
          isCurrent
            ? "font-bold text-white bg-[rgba(155,199,0,0.25)]"
            : "font-normal text-[#bababa] hover:bg-[rgba(255,255,255,0.06)]"
        } ${evalBadge ? "" : "mr-1"}`}
        onClick={onClick}
      >
        {node.san}
        {nags}
      </span>
      {evalBadge && (
        <span
          className="text-[10px] font-mono text-[#8a8783] bg-white/5 rounded-sm px-1 mr-1 select-none"
          data-testid="move-eval-badge"
        >
          {evalBadge}
        </span>
      )}
    </span>
  );
}

/** Human comment text (with [%…] tags stripped), rendered inline after a move. */
function CommentSpan({ comment }: { comment: string }) {
  const { text } = splitComment(comment);
  if (!text) return null;
  return <span className="text-xs italic text-[#8a8783] mr-1 break-words">{text}</span>;
}

// Render one line: follow children[0], emitting each move and, after it, any
// variations that branch from the same point (its siblings). Variations recurse
// as indented parenthesized blocks.
export function renderLine(
  tree: GameTree,
  firstId: string,
  currentId: string,
  onGoToNode: (id: string) => void,
  depth: number,
  showEvals = false,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let id: string | undefined = firstId;
  let forceBlackNumber = true; // first move in a line always prints its number

  while (id) {
    const node = tree.get(id);
    if (!node) break;
    // Eval badge on mainline moves only (depth 0) — variations stay compact.
    const ev = showEvals && depth === 0 ? nodeEval(node) : null;
    out.push(
      <MoveToken
        key={node.id}
        node={node}
        isCurrent={node.id === currentId}
        label={moveNumberLabel(node, forceBlackNumber)}
        evalBadge={ev ? formatEval(ev) : null}
        onClick={() => onGoToNode(node.id)}
      />,
    );
    forceBlackNumber = false;

    if (node.comment) {
      const { text } = splitComment(node.comment);
      if (text) {
        out.push(<CommentSpan key={`c-${node.id}`} comment={node.comment} />);
        // A comment interrupts the "1. e4 e5" pairing, so the next move
        // reprints its number ("1... e5").
        forceBlackNumber = true;
      }
    }

    // Variations attached to THIS move = its siblings after the mainline slot.
    const parent = node.parent ? tree.get(node.parent) : undefined;
    if (parent && parent.children[0] === node.id && parent.children.length > 1) {
      for (const varId of parent.children.slice(1)) {
        out.push(
          <div
            key={`var-${varId}`}
            className="my-0.5 text-[#9a9a9a] border-l border-[#3a3835]"
            style={{ paddingLeft: 8, marginLeft: depth * 6 }}
          >
            <span className="text-xs mr-0.5 select-none">(</span>
            {renderLine(tree, varId, currentId, onGoToNode, depth + 1, showEvals)}
            <span className="text-xs ml-0.5 select-none">)</span>
          </div>,
        );
      }
      // A variation block breaks the flow, so the next mainline move reprints
      // its move number.
      forceBlackNumber = true;
    }
    id = node.children[0];
  }
  return out;
}

export function MoveList({ tree, currentId, onGoToNode, showEvals = false }: MoveListProps) {
  const root = tree.root();
  const hasMoves = root.children.length > 0;

  return (
    // min-h keeps the list usable when the annotation bar + eval graph
    // squeeze the column on short windows — without it flex-1 collapses
    // to zero and the list becomes unclickable under its siblings.
    <Card className="bg-card/50 backdrop-blur-sm border-white/10 p-3 flex-1 min-h-40 overflow-hidden">
      <span className="text-xs font-semibold text-[#bababa] mb-2 block">Moves</span>
      <ScrollArea className="h-[calc(100%-28px)]">
        {!hasMoves ? (
          <span className="text-sm text-muted-foreground">Play a move to begin...</span>
        ) : (
          <div className="leading-6">
            {renderLine(tree, root.children[0], currentId, onGoToNode, 0, showEvals)}
          </div>
        )}
      </ScrollArea>
    </Card>
  );
}

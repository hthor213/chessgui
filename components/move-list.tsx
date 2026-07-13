"use client"

import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { GameTree, MoveNode } from "@/lib/game-tree"

interface MoveListProps {
  tree: GameTree;
  currentId: string;
  onGoToNode: (id: string) => void;
  // Bumped on every tree mutation so React re-renders even though `tree` is a
  // stable instance reference.
  version?: number;
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
  onClick,
}: {
  node: MoveNode;
  isCurrent: boolean;
  label: string | null;
  onClick: () => void;
}) {
  const nags = node.nags.length ? node.nags.map((n) => NAG_GLYPHS[n] ?? "").join("") : "";
  return (
    <span className="inline-flex items-baseline">
      {label && (
        <span className="text-xs text-muted-foreground font-mono mr-1 select-none">{label}</span>
      )}
      <span
        className={`text-sm font-mono px-1 py-px rounded-sm cursor-pointer mr-1 ${
          isCurrent
            ? "font-bold text-white bg-[rgba(155,199,0,0.25)]"
            : "font-normal text-[#bababa] hover:bg-[rgba(255,255,255,0.06)]"
        }`}
        onClick={onClick}
      >
        {node.san}
        {nags}
      </span>
    </span>
  );
}

// Common NAG codes → glyphs (display only; storage is spec 202's job).
const NAG_GLYPHS: Record<number, string> = {
  1: "!",
  2: "?",
  3: "!!",
  4: "??",
  5: "!?",
  6: "?!",
};

// Render one line: follow children[0], emitting each move and, after it, any
// variations that branch from the same point (its siblings). Variations recurse
// as indented parenthesized blocks.
export function renderLine(
  tree: GameTree,
  firstId: string,
  currentId: string,
  onGoToNode: (id: string) => void,
  depth: number,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let id: string | undefined = firstId;
  let forceBlackNumber = true; // first move in a line always prints its number

  while (id) {
    const node = tree.get(id);
    if (!node) break;
    out.push(
      <MoveToken
        key={node.id}
        node={node}
        isCurrent={node.id === currentId}
        label={moveNumberLabel(node, forceBlackNumber)}
        onClick={() => onGoToNode(node.id)}
      />,
    );
    forceBlackNumber = false;

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
            {renderLine(tree, varId, currentId, onGoToNode, depth + 1)}
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

export function MoveList({ tree, currentId, onGoToNode }: MoveListProps) {
  const root = tree.root();
  const hasMoves = root.children.length > 0;

  return (
    <Card className="bg-[#1e1c19] border-[#2a2825] p-3 flex-1 overflow-hidden">
      <span className="text-xs font-semibold text-[#bababa] mb-2 block">Moves</span>
      <ScrollArea className="h-[calc(100%-28px)]">
        {!hasMoves ? (
          <span className="text-sm text-muted-foreground">Play a move to begin...</span>
        ) : (
          <div className="leading-6">
            {renderLine(tree, root.children[0], currentId, onGoToNode, 0)}
          </div>
        )}
      </ScrollArea>
    </Card>
  );
}

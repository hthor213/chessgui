"use client";

// Compare mode (spec 226 I) — the head-to-head.
//
// Two candidates that back up to the same value are not therefore equal, and
// "is this ⩲ or ±?" is a question people answer inconsistently between Tuesday
// and Friday. "Which of these two would I rather have?" is answered instantly
// and consistently. So the panel steps aside, both representative positions go
// up as FULL boards — looking hard at two positions IS the task at that moment,
// and a small board is exactly what makes a position hard to judge — and the
// user's answer, with its reason, is written down.
//
// The same three constraints as the rest of the notebook:
//
//  1. Nothing here is generated. Both positions are reached by walking the
//     user's own stored children (mostLikelyPath), and the walk stops where
//     their tree stops. No move is named that they did not play.
//  2. Nothing here recommends. The app puts two of the user's positions side by
//     side, in the order they picked them, and records what they say. It does
//     not mark one, order them by anything, or hint at a winner.
//  3. No engine. The labels read the backed-up human value; the engine's field
//     on the node is not read here, the same separation as everywhere else in
//     the notebook.

import { useEffect, useState } from "react";
import type { Key } from "@lichess-org/chessground/types";
import { Board } from "@chessgui/ui/board";
import { mostLikelyPath, valueWords } from "@chessgui/core/notebook";
import type { NodeValue } from "@chessgui/core/notebook";
import { moveNumberPrefix, moverIsWhite } from "@chessgui/core/game-tree";
import type { GameTree, MoveNode } from "@chessgui/core/game-tree";

/**
 * A starter set of the reasons people actually give, so the common case is one
 * tap and the free text is left for what is specific to this position. They are
 * descriptions of taste, never of correctness — none of them is a judgement the
 * app is making, and the user can type their own.
 */
export const PREFERENCE_TAGS: readonly string[] = [
  "safer king",
  "clearer plan",
  "fewer ways to go wrong",
  "better structure",
  "more space",
  "I play these well",
  "I play these badly",
];

// The boards are static: this is a comparison, not a place to play moves. An
// empty destination map is the whole of what this file knows about legality,
// and it knows it by declining to have any.
const NO_MOVES = new Map<Key, Key[]>();

export interface NotebookCompareProps {
  tree: GameTree;
  values: Map<string, NodeValue>;
  /** Which side the user is playing — orients both boards and both readings. */
  myColor: "white" | "black";
  /** The two candidates, in the order the user picked them. */
  aId: string;
  bId: string;
  onRecord: (winnerId: string, loserId: string, reason: string, tags: string[]) => void;
  /** Leave without recording — the caller restores the previous view and cursor. */
  onCancel: () => void;
  coordinates?: boolean;
}

/** "1. e4 e5 2. Nf3" — the line walked to reach the position on the board. */
export function lineText(tree: GameTree, ids: readonly string[]): string {
  return ids
    .map((id, i) => {
      const n = tree.get(id);
      if (!n) return "";
      // Number White's moves, and the first move whatever its colour, so a line
      // starting on Black's turn reads "12… Qb6" rather than a bare SAN.
      return moverIsWhite(n) || i === 0 ? `${moveNumberPrefix(n)} ${n.san}` : n.san;
    })
    .filter(Boolean)
    .join(" ");
}

interface Side {
  node: MoveNode;
  leaf: MoveNode;
  line: string;
  truncated: boolean;
  words: string;
}

function sideOf(
  tree: GameTree,
  values: Map<string, NodeValue>,
  id: string,
  myColor: "white" | "black",
): Side | null {
  const node = tree.get(id);
  if (!node) return null;
  const walk = mostLikelyPath(tree, values, id, myColor);
  const leaf = tree.get(walk.leafId) ?? node;
  const v = values.get(id);
  return {
    node,
    leaf,
    line: lineText(tree, walk.path),
    truncated: walk.truncated,
    words: v ? valueWords(v, myColor) : "",
  };
}

export function NotebookCompare({
  tree,
  values,
  myColor,
  aId,
  bId,
  onRecord,
  onCancel,
  coordinates = true,
}: NotebookCompareProps) {
  const existing = tree.preferenceBetween(aId, bId);
  const [winner, setWinner] = useState<string | null>(existing?.winnerId ?? null);
  const [reason, setReason] = useState(existing?.reason ?? "");
  const [tags, setTags] = useState<string[]>(existing?.tags ?? []);
  const [custom, setCustom] = useState("");

  // A new pair is a new question: nothing said about the last two carries over.
  useEffect(() => {
    const prev = tree.preferenceBetween(aId, bId);
    setWinner(prev?.winnerId ?? null);
    setReason(prev?.reason ?? "");
    setTags(prev?.tags ?? []);
    setCustom("");
  }, [tree, aId, bId]);

  // Escape leaves the same way the button does — the caller puts the board and
  // the cursor back exactly where they were.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const a = sideOf(tree, values, aId, myColor);
  const b = sideOf(tree, values, bId, myColor);
  if (!a || !b) return null;

  const toggleTag = (t: string) =>
    setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  const addCustom = () => {
    const t = custom.trim();
    if (t && !tags.includes(t)) setTags((cur) => [...cur, t]);
    setCustom("");
  };

  const record = () => {
    if (!winner) return;
    onRecord(winner, winner === aId ? bId : aId, reason.trim(), tags);
  };

  return (
    <div
      className="flex-1 flex flex-col min-h-0 gap-3 p-3 lg:p-6 text-[13px]"
      data-testid="notebook-compare"
    >
      <div className="flex items-baseline gap-3 shrink-0">
        <span className="text-[15px] font-semibold text-[#e8e4dd]">
          Which of these would I rather have?
        </span>
        <span className="text-[13px] text-muted-foreground">
          the position each line most likely reaches
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          data-testid="compare-cancel"
          title="Back to the board (Esc) — nothing is recorded"
          className="px-2 py-1 rounded-md border border-input text-muted-foreground hover:text-foreground hover:bg-white/5"
        >
          ← Back
        </button>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6 min-h-0">
        {[a, b].map((s) => {
          const picked = winner === s.node.id;
          return (
            <div
              key={s.node.id}
              className="flex flex-col min-h-0 gap-2 items-center"
              data-testid="compare-side"
              data-san={s.node.san}
            >
              <div className="flex items-baseline gap-2 shrink-0 w-full justify-center">
                <span className="font-mono text-[17px] text-[#e8e4dd]">
                  {moveNumberPrefix(s.node)} {s.node.san}
                </span>
                {s.words && <span className="text-[13px] text-muted-foreground">{s.words}</span>}
              </div>
              {/* Board's sizing walks three parents up from its inner div, so
                  this wrapper is the box it measures — it needs a real height,
                  which the pinned flex column above gives it. */}
              <div className="flex-1 min-h-0 w-full flex items-center justify-center overflow-hidden">
                <Board
                  fen={s.leaf.fen}
                  orientation={myColor}
                  onMove={() => {}}
                  legalMoves={NO_MOVES}
                  viewOnly
                  coordinates={coordinates}
                  reserveBelow={0}
                />
              </div>
              <div
                className="shrink-0 w-full text-center text-[13px] text-muted-foreground font-mono leading-snug"
                data-testid="compare-line"
              >
                {/* Where the walk stopped is where the user stopped looking;
                    saying so is honest, and it is not a prod to look further. */}
                {s.line || "no line explored past this move"}
                {s.truncated && " …"}
              </div>
              <button
                type="button"
                onClick={() => setWinner(s.node.id)}
                data-testid={`compare-prefer-${s.node.san}`}
                className={`shrink-0 px-3 py-1.5 rounded-md text-[13px] border transition-colors ${
                  picked
                    ? "border-[#9bc700] bg-[rgba(155,199,0,0.2)] text-white"
                    : "border-input text-muted-foreground hover:text-foreground hover:bg-white/5"
                }`}
              >
                {picked ? "✓ I'd rather have this" : "I'd rather have this"}
              </button>
            </div>
          );
        })}
      </div>

      {/* The reason is the payload. The winner alone would order the list; the
          reasons accumulate into a description of the player's taste, which is
          what the record exists for (spec 226 goal 2). */}
      <div className="shrink-0 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5" data-testid="compare-tags">
          {PREFERENCE_TAGS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => toggleTag(t)}
              className={`px-2 py-1 rounded-md text-[13px] border transition-colors ${
                tags.includes(t)
                  ? "border-[#9bc700] bg-[rgba(155,199,0,0.2)] text-white"
                  : "border-input text-muted-foreground hover:text-foreground hover:bg-white/5"
              }`}
            >
              {t}
            </button>
          ))}
          {tags
            .filter((t) => !PREFERENCE_TAGS.includes(t))
            .map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => toggleTag(t)}
                title="Remove this tag"
                className="px-2 py-1 rounded-md text-[13px] border border-[#9bc700] bg-[rgba(155,199,0,0.2)] text-white"
              >
                {t} ×
              </button>
            ))}
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustom();
              }
            }}
            onBlur={addCustom}
            placeholder="+ my own tag"
            data-testid="compare-custom-tag"
            className="w-36 px-2 py-1 rounded-md text-[13px] bg-transparent border border-input text-foreground placeholder:text-muted-foreground/70"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="why — in my own words"
            data-testid="compare-reason"
            className="flex-1 px-2 py-1.5 rounded-md text-[13px] bg-transparent border border-input text-foreground placeholder:text-muted-foreground/70"
          />
          <button
            type="button"
            onClick={record}
            disabled={!winner}
            data-testid="compare-record"
            title="Write this head-to-head into the notebook"
            className="px-3 py-1.5 rounded-md text-[13px] border border-[#9bc700] text-[#c9d99a] hover:bg-[rgba(155,199,0,0.15)] disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Record
          </button>
        </div>
      </div>
    </div>
  );
}

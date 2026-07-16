"use client"

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import {
  MOVE_NAGS,
  POSITION_NAGS,
  NAG_GLYPHS,
  glyphToNag,
  toggleNag,
  splitComment,
  joinComment,
} from "@chessgui/core/annotations";
import type { MoveNode } from "@chessgui/core/game-tree";

interface AnnotationBarProps {
  /** The move under the cursor (annotations attach to it). */
  node: MoveNode;
  onSetNags: (id: string, nags: number[]) => void;
  onSetComment: (id: string, comment: string) => void;
  /** Keyboard shortcuts only fire while the board view is frontmost. */
  active: boolean;
}

const NAG_TITLES: Record<number, string> = {
  1: "Good move",
  2: "Mistake",
  3: "Brilliant",
  4: "Blunder",
  5: "Interesting",
  6: "Dubious",
  10: "Equal",
  14: "White slightly better",
  15: "Black slightly better",
  16: "White clearly better",
  17: "Black clearly better",
  18: "White winning",
  19: "Black winning",
};

// Positional NAGs offered as buttons ($13 "unclear" omitted to keep one row).
const POSITION_BUTTONS = POSITION_NAGS.filter((n) => n !== 13);

function isTextInput(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
  );
}

/**
 * NAG buttons + comment editor for the current move. Typing "!" / "?" combos
 * anywhere outside an input assigns move NAGs: keystrokes collect for 400ms,
 * then the combo (!, ?, !!, ??, !?, ?!) toggles on the current move. "="
 * toggles the equal-position NAG immediately.
 */
export function AnnotationBar({ node, onSetNags, onSetComment, active }: AnnotationBarProps) {
  const isRoot = node.parent === null;

  // Latest props in refs so the document-level key handler stays stable.
  const nodeRef = useRef(node);
  const onSetNagsRef = useRef(onSetNags);
  const activeRef = useRef(active);
  nodeRef.current = node;
  onSetNagsRef.current = onSetNags;
  activeRef.current = active;

  const bufferRef = useRef("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const flush = () => {
      const glyph = bufferRef.current;
      bufferRef.current = "";
      const n = nodeRef.current;
      if (n.parent === null) return; // no NAGs on the root
      const nag = glyphToNag(glyph);
      if (nag !== null) onSetNagsRef.current(n.id, toggleNag(n.nags, nag));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!activeRef.current || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTextInput(e.target)) return;

      if (e.key === "!" || e.key === "?") {
        e.preventDefault();
        bufferRef.current = (bufferRef.current + e.key).slice(-2);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flush, 400);
      } else if (e.key === "=") {
        e.preventDefault();
        const n = nodeRef.current;
        if (n.parent !== null) onSetNagsRef.current(n.id, toggleNag(n.nags, 10));
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // The textarea edits only the human text; [%…] tags (eval, clocks, arrows)
  // are preserved and re-attached on every change.
  const { text, tags } = splitComment(node.comment);
  // Track edits locally so typing isn't disturbed by the round-trip through
  // the tree; resync when the cursor moves to another node.
  const [draft, setDraft] = useState(text);
  const editedNodeRef = useRef(node.id);
  if (editedNodeRef.current !== node.id) {
    editedNodeRef.current = node.id;
    if (draft !== text) setDraft(text);
  }

  const nagButton = (nag: number) => {
    const on = node.nags.includes(nag);
    return (
      <button
        key={nag}
        disabled={isRoot}
        title={NAG_TITLES[nag] ?? `$${nag}`}
        className={`min-w-7 px-1.5 py-0.5 text-sm font-mono rounded-sm transition-colors ${
          on
            ? "text-white bg-[rgba(155,199,0,0.25)]"
            : "text-[#9a9a9a] hover:text-foreground hover:bg-white/5"
        } ${isRoot ? "opacity-40 cursor-default" : "cursor-pointer"}`}
        onClick={() => onSetNags(node.id, toggleNag(node.nags, nag))}
      >
        {NAG_GLYPHS[nag]}
      </button>
    );
  };

  return (
    <Card className="bg-[#1e1c19] border-[#2a2825] p-3 shrink-0 flex flex-col gap-2">
      <span className="text-xs font-semibold text-[#bababa]">
        Annotate{isRoot ? "" : ` — ${Math.ceil(node.ply / 2)}${node.ply % 2 === 1 ? "." : "..."} ${node.san}`}
      </span>
      <div className="flex flex-wrap gap-0.5" title='Keyboard: type ! or ? combos, "=" for equality'>
        {MOVE_NAGS.map(nagButton)}
        <span className="w-px bg-[#2a2825] mx-1 self-stretch" />
        {POSITION_BUTTONS.map(nagButton)}
      </div>
      <textarea
        rows={2}
        placeholder={isRoot ? "Comment on the starting position…" : "Comment on this move…"}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          onSetComment(node.id, joinComment(e.target.value, tags));
        }}
        className="w-full resize-none rounded-sm bg-[#171512] border border-[#2a2825] px-2 py-1 text-sm text-foreground placeholder:text-[#6a6763] focus:outline-none focus:border-[#4a4845]"
      />
    </Card>
  );
}

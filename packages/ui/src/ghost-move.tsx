"use client";

// The re-walk preview (spec 226 L): the move you played from here last time,
// shown ON THE BOARD without committing — the piece slides to its square,
// holds, and slides back. The board answers "this is what you did" where the
// move list would only name it.
//
// It is not a Chessground move (that would change the position and flash legal
// dots), so it is a self-contained overlay: a cburnett piece — reusing
// Chessground's own sprite via a `.cg-wrap` ancestor, so it matches the board
// exactly — animated with CSS transforms over the board square.
//
// Feel, to the user's spec (2026-07-21): the slide runs 10% slower than a
// normal move (~165ms vs Chessground's 150), holds ~500ms on the square, then
// returns, and stays slightly transparent throughout so it reads as a preview
// rather than a real piece.

import { useEffect, useRef, useState } from "react";

// Chessground renders pieces as a custom <piece> element; declare it so the
// ghost can reuse the exact cburnett sprite via the `.cg-wrap piece.role.color`
// rule rather than re-embedding an image.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      piece: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

const SLIDE_MS = 165; // 150 × 1.1
const HOLD_MS = 500;
const OPACITY = 0.55;

export interface GhostMoveProps {
  boardSize: number;
  orientation: "white" | "black";
  /** Square keys, e.g. "f8" → "d6". */
  from: string;
  to: string;
  role: "pawn" | "knight" | "bishop" | "rook" | "queen" | "king";
  color: "white" | "black";
  /** Fired once the piece has returned — the caller clears the ghost. */
  onDone: () => void;
}

function squareXY(
  square: string,
  sq: number,
  orientation: "white" | "black",
): { x: number; y: number } {
  const file = square.charCodeAt(0) - 97; // a..h → 0..7
  const rank = square.charCodeAt(1) - 49; // 1..8 → 0..7
  return orientation === "white"
    ? { x: file * sq, y: (7 - rank) * sq }
    : { x: (7 - file) * sq, y: rank * sq };
}

export function GhostMove({
  boardSize,
  orientation,
  from,
  to,
  role,
  color,
  onDone,
}: GhostMoveProps) {
  const sq = boardSize / 8;
  const a = squareXY(from, sq, orientation);
  const b = squareXY(to, sq, orientation);
  const [at, setAt] = useState<"from" | "to">("from");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // out → hold → back → done. A frame's delay before the first move so the
    // element paints at `from` and the transition actually runs.
    const t = timers.current;
    t.push(setTimeout(() => setAt("to"), 20));
    t.push(setTimeout(() => setAt("from"), 20 + SLIDE_MS + HOLD_MS));
    t.push(setTimeout(onDone, 20 + SLIDE_MS + HOLD_MS + SLIDE_MS));
    return () => {
      t.forEach(clearTimeout);
      t.length = 0;
    };
    // Keyed by the move in the parent, so a fresh preview remounts cleanly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pos = at === "from" ? a : b;
  return (
    <div
      className="cg-wrap"
      style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 15 }}
      data-testid="ghost-move"
      data-from={from}
      data-to={to}
    >
      <piece
        className={`${role} ${color}`}
        style={{
          position: "absolute",
          width: sq,
          height: sq,
          left: 0,
          top: 0,
          transform: `translate(${pos.x}px, ${pos.y}px)`,
          transition: `transform ${SLIDE_MS}ms ease`,
          opacity: OPACITY,
          backgroundSize: "contain",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center",
        }}
      />
    </div>
  );
}

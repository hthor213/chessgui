"use client";

// The Eval-Map overlay (spec 226): a disc on every square you explored a move
// to, coloured red→green by how good the line is, gray when unjudged. A DOM
// layer over the board (the same technique as the re-walk ghost) rather than a
// Chessground shape, because a square can carry MORE than one disc — two pieces
// reaching it — and Chessground stacks shapes at the square centre. Here they
// sit side by side, each with its piece letter inside.
//
// It never draws on a square the player did not try: the marks come from the
// node's children only, so the blank squares ARE the answer (fair-play axiom).

import type { EvalMark } from "@chessgui/core/eval-map";

export interface EvalMapProps {
  boardSize: number;
  orientation: "white" | "black";
  marks: EvalMark[];
  /** Click a disc to navigate into that explored line (spec 226): the map then
   *  redraws for the node you land on — the opponent's replies, then my counters.
   *  Omit and the discs are display-only. */
  onPick?: (childId: string) => void;
}

/** Square key ("d5") → top-left pixel of that square, respecting orientation.
 *  Same math as the ghost overlay so the two land on identical squares. */
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

export function EvalMap({ boardSize, orientation, marks, onPick }: EvalMapProps) {
  const sq = boardSize / 8;
  // Group by square so multiple candidates to one destination lay out together.
  const bySquare = new Map<string, EvalMark[]>();
  for (const m of marks) {
    const group = bySquare.get(m.destKey);
    if (group) group.push(m);
    else bySquare.set(m.destKey, [m]);
  }

  return (
    <div
      style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 14 }}
      data-testid="eval-map"
    >
      {[...bySquare.entries()].map(([key, group]) => {
        const { x, y } = squareXY(key, sq, orientation);
        const n = group.length;
        // One disc fills most of the square; several shrink to sit side by side.
        const disc = Math.min(sq * 0.62, (sq * 0.94) / n);
        return (
          <div
            key={key}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: sq,
              height: sq,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: sq * 0.04,
            }}
          >
            {group.map((m, i) => (
              <div
                key={i}
                data-square={key}
                data-letter={m.letter}
                role={onPick ? "button" : undefined}
                title={onPick ? "Go into this line" : undefined}
                onClick={onPick ? () => onPick(m.childId) : undefined}
                style={{
                  width: disc,
                  height: disc,
                  borderRadius: "50%",
                  background: m.color,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff",
                  fontWeight: 700,
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  fontSize: disc * 0.5,
                  lineHeight: 1,
                  boxShadow:
                    "0 0 0 1.5px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.45)",
                  // Only the discs take pointer events (the wrapper stays
                  // transparent), so a click drills in while a piece drag on any
                  // other square passes straight through to the board.
                  pointerEvents: onPick ? "auto" : "none",
                  cursor: onPick ? "pointer" : "default",
                }}
              >
                {m.letter}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

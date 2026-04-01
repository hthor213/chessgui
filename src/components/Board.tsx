import { useRef, useEffect, useState } from "react";
import { Chessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";
import "@lichess-org/chessground/assets/chessground.base.css";
import "@lichess-org/chessground/assets/chessground.brown.css";
import "@lichess-org/chessground/assets/chessground.cburnett.css";

interface BoardProps {
  fen: string;
  orientation: "white" | "black";
  onMove: (from: Key, to: Key) => void;
  legalMoves: Map<Key, Key[]>;
  lastMove?: [Key, Key];
}

export function Board({ fen, orientation, onMove, legalMoves, lastMove }: BoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const [boardSize, setBoardSize] = useState(560);

  useEffect(() => {
    const updateSize = () => {
      const available = window.innerHeight - 44 - 32; // header + padding
      const size = Math.min(available, window.innerWidth * 0.6);
      setBoardSize(Math.floor(size / 8) * 8); // snap to 8px grid
    };
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  useEffect(() => {
    if (!boardRef.current) return;

    if (!apiRef.current) {
      apiRef.current = Chessground(boardRef.current, {
        fen,
        orientation,
        movable: {
          color: "both",
          free: false,
          dests: legalMoves,
        },
        highlight: {
          lastMove: true,
          check: true,
        },
        animation: {
          enabled: true,
          duration: 150,
        },
        draggable: {
          showGhost: true,
        },
        events: {
          move: onMove,
        },
        lastMove: lastMove ? [lastMove[0], lastMove[1]] : undefined,
      });
    } else {
      apiRef.current.set({
        fen,
        orientation,
        lastMove: lastMove ? [lastMove[0], lastMove[1]] : undefined,
        movable: {
          dests: legalMoves,
        },
      });
    }
  }, [fen, orientation, legalMoves, lastMove, onMove]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      apiRef.current?.destroy();
    };
  }, []);

  return (
    <div
      ref={boardRef}
      style={{
        width: boardSize,
        height: boardSize,
        flexShrink: 0,
      }}
    />
  );
}

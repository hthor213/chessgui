import { useRef, useEffect, useState, useCallback } from "react";
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
  onBoardSize?: (size: number) => void;
  children?: React.ReactNode;
}

export function Board({ fen, orientation, onMove, legalMoves, lastMove, onBoardSize, children }: BoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const onMoveRef = useRef(onMove);
  const [boardSize, setBoardSize] = useState(560);

  onMoveRef.current = onMove;

  const handleMove = useCallback((from: Key, to: Key) => {
    console.log("CHESSGROUND MOVE EVENT:", from, "->", to);
    onMoveRef.current(from, to);
  }, []);

  useEffect(() => {
    const updateSize = () => {
      const available = window.innerHeight - 64;
      const maxWidth = window.innerWidth - 300 - 48;
      const size = Math.min(available, maxWidth, 720);
      const snapped = Math.floor(size / 8) * 8;
      setBoardSize(snapped);
      onBoardSize?.(snapped);
    };
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  useEffect(() => {
    if (!boardRef.current) return;

    // Destroy previous instance if exists
    if (apiRef.current) {
      apiRef.current.destroy();
      apiRef.current = null;
    }

    console.log("CHESSGROUND INIT, dests size:", legalMoves.size);

    apiRef.current = Chessground(boardRef.current, {
      fen,
      orientation,
      turnColor: fen.includes(" w ") ? "white" : "black",
      movable: {
        color: "both",
        free: false,
        dests: legalMoves,
        showDests: true,
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
        enabled: true,
        showGhost: true,
      },
      selectable: {
        enabled: true,
      },
      events: {
        move: handleMove,
      },
      lastMove: lastMove ? [lastMove[0], lastMove[1]] : undefined,
    });

    return () => {
      apiRef.current?.destroy();
      apiRef.current = null;
    };
  }, [fen, orientation, legalMoves, lastMove, handleMove]);

  return (
    <div style={{ position: "relative", width: boardSize, height: boardSize, flexShrink: 0 }}>
      <div
        ref={boardRef}
        style={{
          width: boardSize,
          height: boardSize,
        }}
      />
      {children}
    </div>
  );
}

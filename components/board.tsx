"use client"

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
  movableColor?: "white" | "black" | "both";
  onMove: (from: Key, to: Key) => void;
  legalMoves: Map<Key, Key[]>;
  lastMove?: [Key, Key];
  onBoardSize?: (size: number) => void;
  children?: React.ReactNode;
}

export function Board({ fen, orientation, movableColor = "both", onMove, legalMoves, lastMove, onBoardSize, children }: BoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const onMoveRef = useRef(onMove);
  const [boardSize, setBoardSize] = useState(560);

  onMoveRef.current = onMove;

  const handleMove = useCallback((from: Key, to: Key) => {
    onMoveRef.current(from, to);
  }, []);

  useEffect(() => {
    const container = boardRef.current?.parentElement?.parentElement;
    if (!container) return;

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      // Use the smaller of container width/height, leave room for controls below
      const size = Math.min(rect.width, rect.height - 48);
      const snapped = Math.max(160, Math.floor(size / 8) * 8);
      setBoardSize(snapped);
      onBoardSize?.(snapped);
    };
    updateSize();

    const ro = new ResizeObserver(updateSize);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!boardRef.current) return;

    // Destroy previous instance if exists
    if (apiRef.current) {
      apiRef.current.destroy();
      apiRef.current = null;
    }

    apiRef.current = Chessground(boardRef.current, {
      fen,
      orientation,
      turnColor: fen.includes(" w ") ? "white" : "black",
      movable: {
        color: movableColor,
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
  }, [fen, orientation, movableColor, legalMoves, lastMove, handleMove]);

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

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
  /** Read-only board (no piece interaction) — used for watching live games. */
  viewOnly?: boolean;
  /** Edit mode: any piece to any square, no legality — used by the position editor. */
  freeMove?: boolean;
  /** Fires when a square is clicked/tapped (edit mode placement). */
  onSelect?: (square: string) => void;
  children?: React.ReactNode;
}

export function Board({ fen, orientation, movableColor = "both", onMove, legalMoves, lastMove, onBoardSize, viewOnly = false, freeMove = false, onSelect, children }: BoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const onMoveRef = useRef(onMove);
  const onSelectRef = useRef(onSelect);
  const [boardSize, setBoardSize] = useState(560);

  onMoveRef.current = onMove;
  onSelectRef.current = onSelect;

  const handleMove = useCallback((from: Key, to: Key) => {
    onMoveRef.current(from, to);
  }, []);

  const handleSelect = useCallback((key: Key) => {
    onSelectRef.current?.(key);
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
      viewOnly,
      coordinates: true,
      turnColor: fen.includes(" w ") ? "white" : "black",
      movable: {
        color: freeMove ? "both" : viewOnly ? undefined : movableColor,
        free: freeMove,
        dests: freeMove ? undefined : legalMoves,
        showDests: !freeMove,
      },
      highlight: {
        lastMove: !freeMove,
        check: !freeMove,
      },
      animation: {
        enabled: true,
        duration: 150,
      },
      draggable: {
        enabled: !viewOnly,
        showGhost: true,
      },
      selectable: {
        enabled: !viewOnly,
      },
      events: {
        move: handleMove,
        select: onSelectRef.current ? handleSelect : undefined,
      },
      lastMove: lastMove ? [lastMove[0], lastMove[1]] : undefined,
    });

    return () => {
      apiRef.current?.destroy();
      apiRef.current = null;
    };
  }, [fen, orientation, movableColor, legalMoves, lastMove, handleMove, handleSelect, viewOnly, freeMove]);

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

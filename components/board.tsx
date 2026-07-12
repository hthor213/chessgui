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

/** Width of the gutters that hold the rank/file labels outside the board. */
const COORD_GUTTER = 26;

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"];

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
    // boardRef -> board square div -> outer wrapper (self-sized) -> layout container
    const container = boardRef.current?.parentElement?.parentElement?.parentElement;
    if (!container) return;

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      // Use the smaller of container width/height, leave room for controls
      // below and for the coordinate gutters on the left/bottom.
      const size = Math.min(rect.width - COORD_GUTTER, rect.height - 48 - COORD_GUTTER);
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
      coordinates: false,
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

  const files = orientation === "white" ? FILES : [...FILES].reverse();
  const ranks = orientation === "white" ? [...RANKS].reverse() : RANKS;

  return (
    <div style={{ position: "relative", width: boardSize + COORD_GUTTER, height: boardSize + COORD_GUTTER, flexShrink: 0 }}>
      {/* Rank labels, left of the board */}
      <div style={{ position: "absolute", left: 0, top: 0, width: COORD_GUTTER, height: boardSize, display: "flex", flexDirection: "column" }}>
        {ranks.map((r) => (
          <span key={r} className="flex-1 flex items-center justify-center text-sm font-semibold text-muted-foreground select-none">
            {r}
          </span>
        ))}
      </div>
      {/* Board + overlays (promotion dialog, etc.) stay aligned to the board square */}
      <div style={{ position: "absolute", left: COORD_GUTTER, top: 0, width: boardSize, height: boardSize }}>
        <div
          ref={boardRef}
          style={{
            width: boardSize,
            height: boardSize,
          }}
        />
        {children}
      </div>
      {/* File labels, below the board */}
      <div style={{ position: "absolute", left: COORD_GUTTER, top: boardSize, width: boardSize, height: COORD_GUTTER, display: "flex" }}>
        {files.map((f) => (
          <span key={f} className="flex-1 flex items-center justify-center text-sm font-semibold text-muted-foreground select-none">
            {f}
          </span>
        ))}
      </div>
    </div>
  );
}

"use client"

import { useRef, useEffect, useState, useCallback } from "react";
import { Chessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";
import type { DrawShape } from "@lichess-org/chessground/draw";
import "./board-theme.css";
import "./square-state.css";

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
  /**
   * Allow premoves (spec 001): with a one-sided `movableColor`, the user can
   * queue a move during the opponent's turn; it plays (through `onMove`) as
   * soon as the position turns theirs. Play mode only.
   */
  premovable?: boolean;
  /** Edit mode: any piece to any square, no legality — used by the position editor. */
  freeMove?: boolean;
  /** Fires when a square is clicked/tapped (edit mode placement). */
  onSelect?: (square: string) => void;
  /** Program-drawn shapes (e.g. engine best-move arrows). */
  autoShapes?: DrawShape[];
  /** User-drawn shapes (right-click drag) restored from the game tree. */
  userShapes?: DrawShape[];
  /** Fires when the user finishes drawing or clears shapes — persist them here. */
  onShapesChange?: (shapes: DrawShape[]) => void;
  children?: React.ReactNode;
}

/** Width of the gutters that hold the rank/file labels outside the board. */
const COORD_GUTTER = 26;

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"];

export function Board({ fen, orientation, movableColor = "both", onMove, legalMoves, lastMove, onBoardSize, viewOnly = false, premovable = false, freeMove = false, onSelect, autoShapes, userShapes, onShapesChange, children }: BoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const onMoveRef = useRef(onMove);
  const onSelectRef = useRef(onSelect);
  // The queued premove, mirrored out of Chessground: the instance is rebuilt
  // on every position change (see the creation effect), which would silently
  // drop a premove set during the opponent's turn.
  const premoveRef = useRef<[Key, Key] | null>(null);
  // Refs (not deps of the creation effect) so shape updates don't rebuild
  // the whole Chessground instance on every engine info line.
  const autoShapesRef = useRef(autoShapes);
  const userShapesRef = useRef(userShapes);
  const onShapesChangeRef = useRef(onShapesChange);
  const [boardSize, setBoardSize] = useState(560);

  onMoveRef.current = onMove;
  onSelectRef.current = onSelect;
  autoShapesRef.current = autoShapes;
  userShapesRef.current = userShapes;
  onShapesChangeRef.current = onShapesChange;

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

    // Touch-first tuning (spec 223): on coarse pointers tap-tap is the
    // primary move entry (selectable, already on), so a drag must not start
    // from the jitter of a tap — require a real pull before Chessground
    // treats the gesture as a drag. autoDistance would override the value
    // after the first drag, so it's pinned off here.
    const coarsePointer =
      typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

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
        ...(coarsePointer ? { distance: 12, autoDistance: false } : {}),
      },
      selectable: {
        enabled: !viewOnly,
      },
      // Chessground defaults premovable on; keep it explicitly tied to the
      // prop so analysis/editor/viewer boards never queue premoves.
      premovable: {
        enabled: premovable && !viewOnly && !freeMove,
        showDests: true,
        castle: true,
        events: {
          set: (orig: Key, dest: Key) => {
            premoveRef.current = [orig, dest];
          },
          unset: () => {
            premoveRef.current = null;
          },
        },
      },
      events: {
        move: handleMove,
        select: onSelectRef.current ? handleSelect : undefined,
      },
      lastMove: lastMove ? [lastMove[0], lastMove[1]] : undefined,
      drawable: {
        autoShapes: autoShapesRef.current ?? [],
        // User annotations (drawn with right-click drag) live in the game
        // tree; seed them on rebuild and persist edits via onChange. Fires
        // only on user draw/clear, never from setShapes, so no feedback loop.
        shapes: userShapesRef.current ?? [],
        onChange: (shapes: DrawShape[]) => onShapesChangeRef.current?.(shapes),
      },
    });

    // Carry the queued premove across the rebuild that just dropped it. When
    // the rebuild is the opponent's move arriving (it's now the premover's
    // turn), play it — playPremove fires the normal move event when the move
    // is legal in the new position, and clears it (via events.unset) when not.
    if (!premovable) {
      premoveRef.current = null;
    } else if (premoveRef.current) {
      const api = apiRef.current;
      api.state.premovable.current = premoveRef.current;
      if (api.state.turnColor === api.state.movable.color) {
        api.playPremove();
      } else {
        api.redrawAll(); // keep the current-premove highlight visible
      }
    }

    return () => {
      apiRef.current?.destroy();
      apiRef.current = null;
    };
  }, [fen, orientation, movableColor, legalMoves, lastMove, handleMove, handleSelect, viewOnly, premovable, freeMove]);

  // Update arrows in place as analysis deepens (no board rebuild). The
  // creation effect above already seeds shapes on rebuild via the ref.
  useEffect(() => {
    apiRef.current?.setAutoShapes(autoShapes ?? []);
  }, [autoShapes]);

  // Restore the current node's saved annotations when navigating without a
  // FEN change wouldn't rebuild — and after a save round-trips through state.
  useEffect(() => {
    apiRef.current?.setShapes(userShapes ?? []);
  }, [userShapes]);

  const files = orientation === "white" ? FILES : [...FILES].reverse();
  const ranks = orientation === "white" ? [...RANKS].reverse() : RANKS;

  return (
    // touchAction none (spec 223): the whole board area — gutters included —
    // owns its touch gestures, so a piece drag never scrolls or zooms the
    // page. No effect on mouse input.
    <div style={{ position: "relative", width: boardSize + COORD_GUTTER, height: boardSize + COORD_GUTTER, flexShrink: 0, touchAction: "none" }}>
      {/* Rank labels, left of the board */}
      <div style={{ position: "absolute", left: 0, top: 0, width: COORD_GUTTER, height: boardSize, display: "flex", flexDirection: "column" }}>
        {ranks.map((r) => (
          <span key={r} className="flex-1 flex items-center justify-center text-base font-semibold text-muted-foreground select-none">
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
          <span key={f} className="flex-1 flex items-center justify-center text-base font-semibold text-muted-foreground select-none">
            {f}
          </span>
        ))}
      </div>
    </div>
  );
}

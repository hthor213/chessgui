import { useState, useCallback, useMemo } from "react";
import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import type { NormalMove } from "chessops";
import type { Key } from "@lichess-org/chessground/types";

const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function squareToKey(square: number): Key {
  const file = String.fromCharCode(97 + (square & 7));
  const rank = String.fromCharCode(49 + (square >> 3));
  return `${file}${rank}` as Key;
}

function keyToSquare(key: Key): number {
  const file = key.charCodeAt(0) - 97;
  const rank = key.charCodeAt(1) - 49;
  return rank * 8 + file;
}

interface GameState {
  fen: string;
  moves: string[];
  positions: string[];
  currentMoveIndex: number;
}

export function useChessGame() {
  const [state, setState] = useState<GameState>({
    fen: INITIAL_FEN,
    moves: [],
    positions: [INITIAL_FEN],
    currentMoveIndex: -1,
  });
  const [orientation, setOrientation] = useState<"white" | "black">("white");

  const legalMoves = useMemo(() => {
    const setup = parseFen(state.fen);
    if (setup.isErr) return new Map<Key, Key[]>();

    const pos = Chess.fromSetup(setup.unwrap());
    if (pos.isErr) return new Map<Key, Key[]>();

    const chess = pos.unwrap();
    const dests = new Map<Key, Key[]>();

    for (const [from, squares] of chess.allDests()) {
      const fromKey = squareToKey(from);
      const toKeys: Key[] = [];
      for (const to of squares) {
        toKeys.push(squareToKey(to));
      }
      if (toKeys.length > 0) {
        dests.set(fromKey, toKeys);
      }
    }

    return dests;
  }, [state.fen]);

  const onMove = useCallback(
    (from: Key, to: Key) => {
      const setup = parseFen(state.fen);
      if (setup.isErr) return;

      const pos = Chess.fromSetup(setup.unwrap());
      if (pos.isErr) return;

      const chess = pos.unwrap();
      const move: NormalMove = {
        from: keyToSquare(from),
        to: keyToSquare(to),
        // Default promote to queen — TODO: promotion dialog
        promotion: undefined,
      };

      // Check if it's a pawn reaching last rank — auto-queen for now
      const piece = chess.board.get(move.from);
      if (piece?.role === "pawn") {
        const toRank = move.to >> 3;
        if (toRank === 0 || toRank === 7) {
          move.promotion = "queen";
        }
      }

      const san = makeSan(chess, move);
      chess.play(move);
      const newFen = makeFen(chess.toSetup());

      setState((prev) => {
        // Truncate future moves if we're not at the end
        const newMoves = [...prev.moves.slice(0, prev.currentMoveIndex + 1), san];
        const newPositions = [
          ...prev.positions.slice(0, prev.currentMoveIndex + 2),
          newFen,
        ];
        return {
          fen: newFen,
          moves: newMoves,
          positions: newPositions,
          currentMoveIndex: newMoves.length - 1,
        };
      });
    },
    [state.fen],
  );

  const goToMove = useCallback(
    (index: number) => {
      setState((prev) => {
        const posIndex = index + 1; // positions[0] is initial position
        if (posIndex < 0 || posIndex >= prev.positions.length) return prev;
        return {
          ...prev,
          fen: prev.positions[posIndex],
          currentMoveIndex: index,
        };
      });
    },
    [],
  );

  const lastMove = useMemo((): [Key, Key] | undefined => {
    // We don't track from/to squares yet — will add with proper move history
    return undefined;
  }, []);

  return {
    fen: state.fen,
    orientation,
    onMove,
    legalMoves,
    lastMove,
    moves: state.moves,
    currentMoveIndex: state.currentMoveIndex,
    goToMove,
    flipBoard: () => setOrientation((o) => (o === "white" ? "black" : "white")),
  };
}

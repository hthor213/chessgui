import { useState, useCallback, useMemo } from "react";
import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import type { NormalMove } from "chessops";
import type { Key } from "@lichess-org/chessground/types";

const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export type PromotionRole = "queen" | "rook" | "bishop" | "knight";

export interface PendingPromotion {
  from: Key;
  to: Key;
  color: "white" | "black";
}

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
  lastMoves: ([Key, Key] | undefined)[];
  currentMoveIndex: number;
  headers: Record<string, string>;
}

export function useChessGame() {
  const [state, setState] = useState<GameState>({
    fen: INITIAL_FEN,
    moves: [],
    positions: [INITIAL_FEN],
    lastMoves: [undefined],
    currentMoveIndex: -1,
    headers: {},
  });
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null);

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

  const playMove = useCallback(
    (from: Key, to: Key, promotion?: PromotionRole) => {
      const setup = parseFen(state.fen);
      if (setup.isErr) return;

      const pos = Chess.fromSetup(setup.unwrap());
      if (pos.isErr) return;

      const chess = pos.unwrap();
      const move: NormalMove = {
        from: keyToSquare(from),
        to: keyToSquare(to),
        promotion,
      };

      const san = makeSan(chess, move);
      chess.play(move);
      const newFen = makeFen(chess.toSetup());

      setState((prev) => {
        const newMoves = [...prev.moves.slice(0, prev.currentMoveIndex + 1), san];
        const newPositions = [
          ...prev.positions.slice(0, prev.currentMoveIndex + 2),
          newFen,
        ];
        const newLastMoves: ([Key, Key] | undefined)[] = [
          ...prev.lastMoves.slice(0, prev.currentMoveIndex + 2),
          [from, to],
        ];
        return {
          ...prev,
          fen: newFen,
          moves: newMoves,
          positions: newPositions,
          lastMoves: newLastMoves,
          currentMoveIndex: newMoves.length - 1,
        };
      });
    },
    [state.fen],
  );

  const onMove = useCallback(
    (from: Key, to: Key) => {
      const setup = parseFen(state.fen);
      if (setup.isErr) return;

      const pos = Chess.fromSetup(setup.unwrap());
      if (pos.isErr) return;

      const chess = pos.unwrap();
      const fromSquare = keyToSquare(from);
      const toSquare = keyToSquare(to);

      const piece = chess.board.get(fromSquare);
      if (piece?.role === "pawn") {
        const toRank = toSquare >> 3;
        if (toRank === 0 || toRank === 7) {
          setPendingPromotion({
            from,
            to,
            color: piece.color === "white" ? "white" : "black",
          });
          return;
        }
      }

      playMove(from, to);
    },
    [state.fen, playMove],
  );

  const confirmPromotion = useCallback(
    (role: PromotionRole) => {
      if (!pendingPromotion) return;
      playMove(pendingPromotion.from, pendingPromotion.to, role);
      setPendingPromotion(null);
    },
    [pendingPromotion, playMove],
  );

  const cancelPromotion = useCallback(() => {
    setPendingPromotion(null);
  }, []);

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

  const loadGame = useCallback(
    (sanMoves: string[], headers?: Record<string, string>) => {
      const setup = parseFen(INITIAL_FEN);
      if (setup.isErr) return;
      const pos = Chess.fromSetup(setup.unwrap());
      if (pos.isErr) return;
      const chess = pos.unwrap();

      const positions: string[] = [INITIAL_FEN];
      const moves: string[] = [];
      const lastMovesList: ([Key, Key] | undefined)[] = [undefined];

      for (const san of sanMoves) {
        const move = parseSan(chess, san);
        if (!move) break;
        const normalizedSan = makeSan(chess, move);
        chess.play(move);
        const fen = makeFen(chess.toSetup());
        moves.push(normalizedSan);
        positions.push(fen);
        const m = move as NormalMove;
        if (m.from !== undefined && m.to !== undefined) {
          lastMovesList.push([squareToKey(m.from), squareToKey(m.to)]);
        } else {
          lastMovesList.push(undefined);
        }
      }

      const finalIndex = moves.length - 1;
      setState({
        fen: positions[positions.length - 1],
        moves,
        positions,
        lastMoves: lastMovesList,
        currentMoveIndex: finalIndex,
        headers: headers || {},
      });
    },
    [],
  );

  const newGame = useCallback(() => {
    setState({
      fen: INITIAL_FEN,
      moves: [],
      positions: [INITIAL_FEN],
      lastMoves: [undefined],
      currentMoveIndex: -1,
      headers: {},
    });
  }, []);

  const lastMove = useMemo((): [Key, Key] | undefined => {
    const posIndex = state.currentMoveIndex + 1;
    return state.lastMoves[posIndex];
  }, [state.currentMoveIndex, state.lastMoves]);

  return {
    fen: state.fen,
    orientation,
    onMove,
    legalMoves,
    lastMove,
    moves: state.moves,
    currentMoveIndex: state.currentMoveIndex,
    goToMove,
    headers: state.headers,
    loadGame,
    newGame,
    flipBoard: () => setOrientation((o) => (o === "white" ? "black" : "white")),
    pendingPromotion,
    confirmPromotion,
    cancelPromotion,
  };
}

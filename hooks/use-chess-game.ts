import { useState, useCallback, useMemo, useEffect } from "react";
import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { parseUci } from "chessops";
import { chessgroundDests } from "chessops/compat";
import { normalizeUciCastling } from "@/lib/uci-parser";
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
  uciMoves: string[];
  positions: string[];
  lastMoves: ([Key, Key] | undefined)[];
  currentMoveIndex: number;
  startFen: string;
  headers: Record<string, string>;
}

const STORAGE_KEY = "chessgui-game";

function rebuildUciMoves(startFen: string, sanMoves: string[]): string[] {
  const setup = parseFen(startFen);
  if (setup.isErr) return [];
  const pos = Chess.fromSetup(setup.unwrap());
  if (pos.isErr) return [];
  const chess = pos.unwrap();
  const uciMoves: string[] = [];
  for (const san of sanMoves) {
    const move = parseSan(chess, san);
    if (!move) break;
    uciMoves.push(moveToUci(move as NormalMove, chess));
    chess.play(move);
  }
  return uciMoves;
}

function loadSavedState(): GameState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as GameState;
    // Sanity check: positions array must be consistent
    if (saved.positions?.length > 0 && saved.currentMoveIndex >= -1) {
      // Migrate old saves that lack uciMoves/startFen
      if (!saved.startFen) saved.startFen = INITIAL_FEN;
      if (!saved.uciMoves) {
        saved.uciMoves = rebuildUciMoves(saved.startFen, saved.moves);
      }
      return saved;
    }
  } catch { /* ignore corrupt data */ }
  return null;
}

// Convert chessops castling (king→rook) to standard UCI (king→destination)
const castlingToUci: Record<string, string> = {
  "e1h1": "e1g1", "e1a1": "e1c1",
  "e8h8": "e8g8", "e8a8": "e8c8",
};

const promoChar: Record<string, string> = {
  queen: "q", rook: "r", bishop: "b", knight: "n",
};

function moveToUci(move: NormalMove, chess: Chess): string {
  const from = squareToKey(move.from);
  const to = squareToKey(move.to);
  const key = `${from}${to}`;

  // Castling: chessops stores king→rook, UCI uses king→destination
  const piece = chess.board.get(move.from);
  if (piece?.role === "king" && castlingToUci[key]) {
    return castlingToUci[key];
  }

  const promo = move.promotion ? promoChar[move.promotion] || "" : "";
  return `${from}${to}${promo}`;
}

const defaultState: GameState = {
  fen: INITIAL_FEN,
  moves: [],
  uciMoves: [],
  positions: [INITIAL_FEN],
  lastMoves: [undefined],
  currentMoveIndex: -1,
  startFen: INITIAL_FEN,
  headers: {},
};

export function useChessGame() {
  const [state, setState] = useState<GameState>(defaultState);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from localStorage after mount (avoids SSR mismatch)
  useEffect(() => {
    const saved = loadSavedState();
    if (saved) setState(saved);
    setHydrated(true);
  }, []);

  // Persist game state to localStorage so it survives crashes and restarts
  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state, hydrated]);
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null);

  const legalMoves = useMemo(() => {
    const setup = parseFen(state.fen);
    if (setup.isErr) return new Map<Key, Key[]>();

    const pos = Chess.fromSetup(setup.unwrap());
    if (pos.isErr) return new Map<Key, Key[]>();

    // Use the official chessops chessground compatibility function.
    // It correctly handles castling dests (both king->rook and king->destination)
    // and iterates SquareSets properly.
    return chessgroundDests(pos.unwrap()) as Map<Key, Key[]>;
  }, [state.fen]);

  // Derived game status for the current position (checkmate / stalemate / draw /
  // check). Surfaces an explicit signal to the UI instead of leaving the user to
  // guess whether a position is terminal.
  const status = useMemo((): { over: boolean; label: string | null } => {
    const setup = parseFen(state.fen);
    if (setup.isErr) return { over: false, label: null };
    const pos = Chess.fromSetup(setup.unwrap());
    if (pos.isErr) return { over: false, label: null };
    const chess = pos.unwrap();
    if (chess.isCheckmate()) {
      const winner = chess.turn === "white" ? "Black" : "White";
      return { over: true, label: `Checkmate — ${winner} wins` };
    }
    if (chess.isStalemate()) return { over: true, label: "Stalemate — draw" };
    if (chess.isInsufficientMaterial()) return { over: true, label: "Draw — insufficient material" };
    if (chess.isCheck()) return { over: false, label: "Check" };
    return { over: false, label: null };
  }, [state.fen]);

  const playMove = useCallback(
    (from: Key, to: Key, promotion?: PromotionRole) => {
      const setup = parseFen(state.fen);
      if (setup.isErr) return;

      const pos = Chess.fromSetup(setup.unwrap());
      if (pos.isErr) return;

      const chess = pos.unwrap();

      // Convert user-friendly castling (king->destination) to chessops format (king->rook)
      const castlingMap: Record<string, Key> = {
        "e1g1": "h1", "e1c1": "a1", // white
        "e8g8": "h8", "e8c8": "a8", // black
      };
      const piece = chess.board.get(keyToSquare(from));
      let actualTo = to;
      if (piece?.role === "king") {
        actualTo = castlingMap[`${from}${to}`] || to;
      }

      const move: NormalMove = {
        from: keyToSquare(from),
        to: keyToSquare(actualTo),
        promotion,
      };

      const san = makeSan(chess, move);
      const uci = moveToUci(move, chess);
      chess.play(move);
      const newFen = makeFen(chess.toSetup());

      setState((prev) => {
        const newMoves = [...prev.moves.slice(0, prev.currentMoveIndex + 1), san];
        const newUciMoves = [...prev.uciMoves.slice(0, prev.currentMoveIndex + 1), uci];
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
          uciMoves: newUciMoves,
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
    (sanMoves: string[], headers?: Record<string, string>, startFen?: string) => {
      const setup = parseFen(startFen || INITIAL_FEN);
      if (setup.isErr) return;
      const pos = Chess.fromSetup(setup.unwrap());
      if (pos.isErr) return;
      const chess = pos.unwrap();
      const normStart = makeFen(chess.toSetup());

      const positions: string[] = [normStart];
      const moves: string[] = [];
      const uciMoves: string[] = [];
      const lastMovesList: ([Key, Key] | undefined)[] = [undefined];

      for (const san of sanMoves) {
        const move = parseSan(chess, san);
        if (!move) break;
        const normalizedSan = makeSan(chess, move);
        const uci = moveToUci(move as NormalMove, chess);
        chess.play(move);
        const fen = makeFen(chess.toSetup());
        moves.push(normalizedSan);
        uciMoves.push(uci);
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
        uciMoves,
        positions,
        lastMoves: lastMovesList,
        currentMoveIndex: finalIndex,
        startFen: normStart,
        headers: headers || {},
      });
    },
    [],
  );

  // Reset the game to an arbitrary position with empty history (position editor).
  const loadFen = useCallback((fen: string) => {
    const setup = parseFen(fen);
    if (setup.isErr) return;
    const pos = Chess.fromSetup(setup.unwrap());
    if (pos.isErr) return;
    const normFen = makeFen(pos.unwrap().toSetup());
    setState({
      fen: normFen,
      moves: [],
      uciMoves: [],
      positions: [normFen],
      lastMoves: [undefined],
      currentMoveIndex: -1,
      startFen: normFen,
      headers: {},
    });
  }, []);

  const newGame = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setState({
      fen: INITIAL_FEN,
      moves: [],
      uciMoves: [],
      positions: [INITIAL_FEN],
      lastMoves: [undefined],
      currentMoveIndex: -1,
      startFen: INITIAL_FEN,
      headers: {},
    });
  }, []);

  const playUciMove = useCallback(
    (uci: string): boolean => {
      try {
        const setup = parseFen(state.fen);
        if (setup.isErr) return false;
        const pos = Chess.fromSetup(setup.unwrap());
        if (pos.isErr) return false;
        const chess = pos.unwrap();

        // Convert standard UCI castling to chessops format (king->rook)
        // Stockfish sends e1g1 (standard UCI), but chessops expects e1h1 (king-captures-rook)
        const normalizedUci = normalizeUciCastling(uci);

        const move = parseUci(normalizedUci);
        if (!move) return false;

        const san = makeSan(chess, move);
        chess.play(move);
        const newFen = makeFen(chess.toSetup());

        // Determine display squares (king destination for castling, not rook)
        const m = move as NormalMove;
        const fromKey = squareToKey(m.from);
        let toKey = squareToKey(m.to);
        // Convert chessops castling (king->rook) to display (king->destination)
        const castlingDisplay: Record<string, Key> = {
          "e1h1": "g1", "e1a1": "c1",
          "e8h8": "g8", "e8a8": "c8",
        };
        const displayTo = castlingDisplay[`${fromKey}${toKey}`];
        if (displayTo) toKey = displayTo;

        setState((prev) => {
          const newMoves = [...prev.moves.slice(0, prev.currentMoveIndex + 1), san];
          const newUciMoves = [...prev.uciMoves.slice(0, prev.currentMoveIndex + 1), uci];
          const newPositions = [
            ...prev.positions.slice(0, prev.currentMoveIndex + 2),
            newFen,
          ];
          const newLastMoves: ([Key, Key] | undefined)[] = [
            ...prev.lastMoves.slice(0, prev.currentMoveIndex + 2),
            [fromKey, toKey],
          ];
          return {
            ...prev,
            fen: newFen,
            moves: newMoves,
            uciMoves: newUciMoves,
            positions: newPositions,
            lastMoves: newLastMoves,
            currentMoveIndex: newMoves.length - 1,
          };
        });
        return true;
      } catch (e) {
        console.error("[playUciMove] failed:", uci, e);
        return false;
      }
    },
    [state.fen],
  );

  const lastMove = useMemo((): [Key, Key] | undefined => {
    const posIndex = state.currentMoveIndex + 1;
    return state.lastMoves[posIndex];
  }, [state.currentMoveIndex, state.lastMoves]);

  return {
    fen: state.fen,
    orientation,
    onMove,
    legalMoves,
    status,
    lastMove,
    moves: state.moves,
    uciMoves: state.uciMoves,
    startFen: state.startFen,
    currentMoveIndex: state.currentMoveIndex,
    goToMove,
    headers: state.headers,
    loadGame,
    loadFen,
    newGame,
    playUciMove,
    setOrientation,
    flipBoard: () => setOrientation((o) => (o === "white" ? "black" : "white")),
    pendingPromotion,
    confirmPromotion,
    cancelPromotion,
  };
}

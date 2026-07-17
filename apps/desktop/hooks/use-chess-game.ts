import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { Chess, castlingSide, normalizeMove } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { chessgroundDests } from "chessops/compat";
import { kingCastlesTo } from "chessops";
import type { NormalMove } from "chessops";
import type { Key } from "@lichess-org/chessground/types";
import {
  GameTree,
  INITIAL_FEN,
  keyToSquare,
  squareToKey,
  type ArrowAnnotation,
  type MoveNode,
  type NodeEval,
  type SerializedTree,
} from "@chessgui/core/game-tree";
import { treeToPgn } from "@chessgui/core/pgn";
import type { ActiveGameMeta } from "@chessgui/core/active-game";
import { getProviders } from "@/lib/platform";

export type PromotionRole = "queen" | "rook" | "bishop" | "knight";

export interface PendingPromotion {
  from: Key;
  to: Key;
  color: "white" | "black";
}

// The persisted / snapshotted game is now the serialized variation tree. The
// name is kept so page.tsx's snapshot ref type stays stable.
export type GameState = SerializedTree;

const STORAGE_KEY = "chessgui-game";

// Rebuild a tree from whatever is in storage. Handles three cases: a
// current serialized tree, a legacy flat-move save, or garbage — never throws.
function loadSavedTree(): GameTree | null {
  try {
    const raw = getProviders().storage.get(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved && saved.nodes && saved.rootId) {
      return GameTree.fromJSON(saved as SerializedTree);
    }
    // Legacy shape: { moves: string[], startFen?, headers? }
    if (Array.isArray(saved?.moves)) {
      const tree = GameTree.fromMoves(
        saved.moves,
        saved.startFen || INITIAL_FEN,
        saved.headers || {},
      );
      tree.goToEnd();
      return tree;
    }
  } catch {
    /* ignore corrupt data */
  }
  return null;
}

export function useChessGame() {
  const treeRef = useRef<GameTree>(GameTree.create());
  const [version, setVersion] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // Hydrate from localStorage after mount (avoids SSR mismatch).
  useEffect(() => {
    const saved = loadSavedTree();
    if (saved) {
      treeRef.current = saved;
      setVersion((v) => v + 1);
    }
    setHydrated(true);
  }, []);

  // Persist after every mutation so the game survives crashes and restarts.
  useEffect(() => {
    if (hydrated) {
      getProviders().storage.set(STORAGE_KEY, JSON.stringify(treeRef.current.toJSON()));
    }
  }, [version, hydrated]);

  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null);

  // Derived view of the tree at the current cursor. Recomputed whenever a
  // mutation bumps `version`.
  const view = useMemo(() => {
    const tree = treeRef.current;
    const current = tree.currentNode();
    const line = tree.currentLine();
    return {
      fen: current.fen,
      moves: line.map((n) => n.san),
      uciMoves: line.map((n) => n.uci),
      currentMoveIndex: tree.currentIndex(),
      startFen: tree.startFen,
      headers: tree.headers,
      currentNode: current,
      currentNodeId: current.id,
      // Spec 219: the active-game flag rides the tree, so every load path
      // (hydration, loadTree, restoreSnapshot) re-applies the lockout.
      activeGame: tree.activeGame,
      // Chess960 (spec 011): rides the tree the same way, so every load
      // path re-applies the engine's UCI_Chess960 wiring.
      variant: tree.variant,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const legalMoves = useMemo(() => {
    const setup = parseFen(view.fen);
    if (setup.isErr) return new Map<Key, Key[]>();
    const pos = Chess.fromSetup(setup.unwrap());
    if (pos.isErr) return new Map<Key, Key[]>();
    return chessgroundDests(pos.unwrap()) as Map<Key, Key[]>;
  }, [view.fen]);

  const status = useMemo((): { over: boolean; label: string | null } => {
    const setup = parseFen(view.fen);
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
  }, [view.fen]);

  const playMove = useCallback(
    (from: Key, to: Key, promotion?: PromotionRole) => {
      const tree = treeRef.current;
      const setup = parseFen(tree.currentNode().fen);
      if (setup.isErr) return;
      const pos = Chess.fromSetup(setup.unwrap());
      if (pos.isErr) return;
      const chess = pos.unwrap();

      // Board input may express castling as king→destination (e1g1);
      // normalizeMove converts it to chessops' king→rook form when — and only
      // when — the move actually castles in this position (Chess960-safe).
      const move = normalizeMove(chess, {
        from: keyToSquare(from),
        to: keyToSquare(to),
        promotion,
      }) as NormalMove;
      // addMove creates a variation when a different move is played mid-game,
      // reuses an existing branch for the same move, and never truncates.
      if (tree.addMove(move)) bump();
    },
    [bump],
  );

  const onMove = useCallback(
    (from: Key, to: Key) => {
      const setup = parseFen(treeRef.current.currentNode().fen);
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
    [playMove],
  );

  const confirmPromotion = useCallback(
    (role: PromotionRole) => {
      if (!pendingPromotion) return;
      playMove(pendingPromotion.from, pendingPromotion.to, role);
      setPendingPromotion(null);
    },
    [pendingPromotion, playMove],
  );

  const cancelPromotion = useCallback(() => setPendingPromotion(null), []);

  // Navigate the current line by ply index (-1 = start). Preserves the flat
  // index-based API the keyboard handlers and move list rely on.
  const goToMove = useCallback(
    (index: number) => {
      const tree = treeRef.current;
      if (index < 0) {
        tree.goToStart();
      } else {
        const line = tree.currentLine();
        if (index >= line.length) return;
        tree.goTo(line[index].id);
      }
      bump();
    },
    [bump],
  );

  // Play-mode take-back: truncate the user's last move (and the engine's
  // reply, if it has already answered) and land on the most recent position
  // where it's the user's turn. Unlike goToMove navigation, this deletes the
  // moves from the tree — a game in progress isn't a variation to branch off.
  // Returns false when there's nothing to take back (already at a user turn).
  const takeBack = useCallback(
    (playerColor: "white" | "black"): boolean => {
      if (treeRef.current.takeBack(playerColor)) {
        bump();
        return true;
      }
      return false;
    },
    [bump],
  );

  // Jump straight to any node in the tree (used by the variation-aware list).
  const goToNode = useCallback(
    (id: string) => {
      if (treeRef.current.goTo(id)) bump();
    },
    [bump],
  );

  // Up/Down keys: walk into / between / out of variations (logic lives on
  // GameTree so it's unit-tested with the rest of the tree ops).
  const cycleVariation = useCallback(
    (direction: 1 | -1) => {
      if (treeRef.current.cycleVariation(direction)) bump();
    },
    [bump],
  );

  const promoteVariation = useCallback(
    (id: string) => {
      if (treeRef.current.promoteVariation(id)) bump();
    },
    [bump],
  );

  const deleteVariation = useCallback(
    (id: string) => {
      if (treeRef.current.deleteVariation(id)) bump();
    },
    [bump],
  );

  const setComment = useCallback(
    (id: string, comment: string) => {
      treeRef.current.setComment(id, comment);
      bump();
    },
    [bump],
  );

  const setNags = useCallback(
    (id: string, nags: number[]) => {
      treeRef.current.setNags(id, nags);
      bump();
    },
    [bump],
  );

  const setArrows = useCallback(
    (id: string, arrows: ArrowAnnotation[]) => {
      treeRef.current.setArrows(id, arrows);
      bump();
    },
    [bump],
  );

  // Live eval capture: the tree refuses shallower-than-stored writes, so this
  // only bumps (re-render + persist) when something actually changed.
  const setEval = useCallback(
    (id: string, ev: NodeEval) => {
      if (treeRef.current.setEval(id, ev)) bump();
    },
    [bump],
  );

  const loadGame = useCallback(
    (sanMoves: string[], headers?: Record<string, string>, startFen?: string) => {
      const tree = GameTree.fromMoves(sanMoves, startFen || INITIAL_FEN, headers || {});
      tree.goToEnd();
      treeRef.current = tree;
      bump();
    },
    [bump],
  );

  // Load a fully-built tree (PGN import with variations/comments/NAGs). Lands
  // on the final mainline move, matching the flat-import behavior.
  const loadTree = useCallback(
    (tree: GameTree) => {
      tree.goToEnd();
      treeRef.current = tree;
      bump();
    },
    [bump],
  );

  // Serialize the current game to standard PGN (headers, variations,
  // comments, NAGs, [%eval]/[%cal]/[%csl] tags).
  const exportPgn = useCallback((): string => treeToPgn(treeRef.current), []);

  // Reset to an arbitrary position with empty history (position editor).
  const loadFen = useCallback(
    (fen: string) => {
      const setup = parseFen(fen);
      if (setup.isErr) return;
      const pos = Chess.fromSetup(setup.unwrap());
      if (pos.isErr) return;
      treeRef.current = GameTree.create(fen);
      bump();
    },
    [bump],
  );

  // Snapshot/restore the whole game — used by thinking mode to bring back the
  // game that was on the board before a screenshot paste replaced it. The
  // snapshot is a serialized, independent copy.
  const getSnapshot = useCallback((): GameState => treeRef.current.toJSON(), []);
  const restoreSnapshot = useCallback(
    (snap: GameState) => {
      treeRef.current = GameTree.fromJSON(snap);
      bump();
    },
    [bump],
  );

  // Flag / unflag the current game as an ACTIVE chess.com daily game
  // (spec 219 A). Flagging happens in position setup; clearing is reserved
  // for the archive step and the fair-play-confirmed deletion — the UI must
  // never offer a mid-game unflag toggle (spec 219 B "no bypass").
  const setActiveGame = useCallback(
    (meta: ActiveGameMeta | null) => {
      treeRef.current.activeGame = meta;
      bump();
    },
    [bump],
  );

  const newGame = useCallback(() => {
    getProviders().storage.remove(STORAGE_KEY);
    treeRef.current = GameTree.create();
    bump();
  }, [bump]);

  const playUciMove = useCallback(
    (uci: string): boolean => {
      try {
        const id = treeRef.current.addMoveUci(uci);
        if (id) {
          bump();
          return true;
        }
        return false;
      } catch (e) {
        console.error("[playUciMove] failed:", uci, e);
        return false;
      }
    },
    [bump],
  );

  // Highlight squares for the last move. Castling highlights the king's
  // destination (not the rook), derived against the position before the move
  // so it stays correct in Chess960 where the stored UCI is king-takes-rook.
  const lastMove = useMemo((): [Key, Key] | undefined => {
    const node = view.currentNode;
    if (!node.move || node.parent == null) return undefined;
    const parent = treeRef.current.get(node.parent);
    if (!parent) return undefined;
    const setup = parseFen(parent.fen);
    if (setup.isErr) return undefined;
    const pos = Chess.fromSetup(setup.unwrap());
    if (pos.isErr) return undefined;
    const chess = pos.unwrap();
    const side = castlingSide(chess, node.move);
    const from = squareToKey(node.move.from) as Key;
    const to = squareToKey(side ? kingCastlesTo(chess.turn, side) : node.move.to) as Key;
    return [from, to];
  }, [view.currentNode]);

  return {
    fen: view.fen,
    orientation,
    onMove,
    legalMoves,
    status,
    lastMove,
    moves: view.moves,
    uciMoves: view.uciMoves,
    startFen: view.startFen,
    currentMoveIndex: view.currentMoveIndex,
    goToMove,
    takeBack,
    headers: view.headers,
    loadGame,
    loadTree,
    exportPgn,
    loadFen,
    newGame,
    getSnapshot,
    restoreSnapshot,
    playUciMove,
    // Active game mode (spec 219)
    activeGame: view.activeGame,
    variant: view.variant,
    setActiveGame,
    setOrientation,
    flipBoard: () => setOrientation((o) => (o === "white" ? "black" : "white")),
    pendingPromotion,
    confirmPromotion,
    cancelPromotion,
    // Tree-aware surface (spec 016)
    tree: treeRef.current,
    currentNodeId: view.currentNodeId,
    currentNode: view.currentNode as MoveNode,
    goToNode,
    cycleVariation,
    promoteVariation,
    deleteVariation,
    setComment,
    setNags,
    setArrows,
    setEval,
    treeVersion: version,
  };
}

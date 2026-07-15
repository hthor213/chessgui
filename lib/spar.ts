// Pure chess helpers for the "Spar vs rival" screen (spec 214, Tier 0).
//
// The spar screen runs its own small game loop (independent of the main game
// tree, like the calibration screen) so a sparring game never touches the user's
// analysis. These helpers apply moves and read game state via chessops; keeping
// them pure makes the loop testable without a board or a Tauri shell.

import { Chess } from "chessops/chess";
import { parseFen, makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { parseEngineUci } from "@/lib/uci-parser";

export type SparColor = "white" | "black";

export interface SparPly {
  fen: string; // position AFTER the move
  san: string;
  uci: string;
}

export interface SparStatus {
  over: boolean;
  /** Human-readable outcome, e.g. "Checkmate — White wins", or null if ongoing. */
  label: string | null;
}

/** Side to move in a FEN. */
export function turnOf(fen: string): SparColor {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

/** Parse a FEN into a chessops position, or null if it is malformed. */
function positionOf(fen: string): Chess | null {
  const setup = parseFen(fen);
  if (setup.isErr) return null;
  const pos = Chess.fromSetup(setup.unwrap());
  return pos.isErr ? null : pos.unwrap();
}

/**
 * Apply a UCI move to `fen`, returning the resulting ply (new FEN + SAN) or null
 * if the move is illegal / malformed. Handles engine-style castling (king-to-rook
 * or king-two-squares) via `parseEngineUci`, matching how the rest of the app
 * ingests external UCI.
 */
export function applyUci(fen: string, uci: string): SparPly | null {
  const pos = positionOf(fen);
  if (!pos) return null;
  const move = parseEngineUci(pos, uci);
  if (!move || !pos.isLegal(move)) return null;
  const san = makeSan(pos, move);
  pos.play(move);
  return { fen: makeFen(pos.toSetup()), san, uci };
}

/** Build the UCI for a board drag, auto-queening a pawn that reaches the last
 *  rank (the spar board offers no underpromotion picker — Tier 0). */
export function dragToUci(fen: string, from: string, to: string): string {
  const pos = positionOf(fen);
  let promo = "";
  if (pos) {
    const fromSq = parseSquareIndex(from);
    const isPawn = fromSq >= 0 && pos.board.pawn.has(fromSq);
    const lastRank = turnOf(fen) === "white" ? "8" : "1";
    if (isPawn && to[1] === lastRank) promo = "q";
  }
  return `${from}${to}${promo}`;
}

/** a1..h8 -> 0..63 (chessops square index), or -1 if not a square. */
function parseSquareIndex(sq: string): number {
  if (sq.length < 2) return -1;
  const file = sq.charCodeAt(0) - 97;
  const rank = sq.charCodeAt(1) - 49;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return -1;
  return rank * 8 + file;
}

/** Terminal state of a position, with a readable label for the UI. */
export function sparStatus(fen: string): SparStatus {
  const pos = positionOf(fen);
  if (!pos) return { over: false, label: null };
  if (!pos.isEnd()) return { over: false, label: null };
  if (pos.isCheckmate()) {
    // The side to move is checkmated, so the other side won.
    const winner = pos.turn === "white" ? "Black" : "White";
    return { over: true, label: `Checkmate — ${winner} wins` };
  }
  if (pos.isStalemate()) return { over: true, label: "Draw — stalemate" };
  if (pos.isInsufficientMaterial()) return { over: true, label: "Draw — insufficient material" };
  return { over: true, label: "Draw" };
}

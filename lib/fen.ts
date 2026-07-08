import { Chess } from "chessops/chess";
import { parseFen, makeBoardFen } from "chessops/fen";
import { Board } from "chessops/board";
import { makeSquare, parseSquare } from "chessops/util";
import type { Color, Piece } from "chessops";

export type PieceMap = Map<string, Piece>;

export interface CastlingOptions {
  K: boolean;
  Q: boolean;
  k: boolean;
  q: boolean;
}

// Map the FEN/position error codes chessops emits to human-readable messages.
function messageForError(code: string): string {
  if (code.includes("KINGS")) return "Each side needs exactly one king.";
  if (code.includes("PAWNS_ON_BACKRANK")) return "Pawns can't sit on the first or last rank.";
  if (code.includes("OPPOSITE_CHECK")) return "The side not to move is in check — switch the side to move.";
  if (code.includes("EMPTY")) return "The board needs a king for each side.";
  if (code.includes("CASTLING")) return "Castling rights don't match the kings and rooks on the board.";
  if (code.includes("EP_SQUARE")) return "Invalid en passant square.";
  if (code.includes("TURN")) return "Invalid side to move.";
  if (code.includes("HALFMOVES") || code.includes("FULLMOVES")) return "Invalid move counters.";
  if (code.includes("BOARD")) return "Invalid board layout.";
  return "That's not a valid position.";
}

// Impossible material (e.g. three queens) is intentionally accepted — only
// structurally illegal positions (kings, pawns on back ranks, opponent in
// check, castling-rights sanity) are rejected.
export function validateFen(fen: string): { ok: true } | { ok: false; error: string } {
  const setup = parseFen(fen);
  if (setup.isErr) {
    return { ok: false, error: setup.unwrap(() => "", (e) => messageForError(e.message)) };
  }
  const pos = Chess.fromSetup(setup.unwrap());
  if (pos.isErr) {
    return { ok: false, error: pos.unwrap(() => "", (e) => messageForError(e.message)) };
  }
  return { ok: true };
}

// Pad a 4- or 5-field FEN out to a full 6-field FEN (default counters).
export function padFen(fen: string): string {
  const parts = fen.trim().split(/\s+/);
  if (parts.length === 4) return [...parts, "0", "1"].join(" ");
  if (parts.length === 5) return [...parts, "1"].join(" ");
  return parts.join(" ");
}

export function fenToPieceMap(fen: string): PieceMap {
  const map: PieceMap = new Map();
  const setup = parseFen(fen);
  if (setup.isErr) return map;
  for (const [square, piece] of setup.unwrap().board) {
    map.set(makeSquare(square), piece);
  }
  return map;
}

export function pieceMapToFen(pieces: PieceMap, turn: Color, castling: CastlingOptions): string {
  const board = Board.empty();
  for (const [sq, piece] of pieces) {
    const square = parseSquare(sq);
    if (square !== undefined) board.set(square, piece);
  }
  const boardFen = makeBoardFen(board);
  const castle =
    (castling.K ? "K" : "") +
    (castling.Q ? "Q" : "") +
    (castling.k ? "k" : "") +
    (castling.q ? "q" : "");
  return `${boardFen} ${turn === "white" ? "w" : "b"} ${castle || "-"} - 0 1`;
}

// Which castling rights are structurally possible given a king + rook on their
// home squares. Used to auto-disable castling checkboxes in the editor.
export function computeCastlingOptions(pieces: PieceMap): CastlingOptions {
  const at = (sq: string, role: "king" | "rook", color: Color) => {
    const p = pieces.get(sq);
    return !!p && p.role === role && p.color === color;
  };
  return {
    K: at("e1", "king", "white") && at("h1", "rook", "white"),
    Q: at("e1", "king", "white") && at("a1", "rook", "white"),
    k: at("e8", "king", "black") && at("h8", "rook", "black"),
    q: at("e8", "king", "black") && at("a8", "rook", "black"),
  };
}

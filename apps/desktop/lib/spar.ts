// Pure chess helpers for the "Spar vs rival" screen (spec 214, Tier 0).
//
// The spar screen runs its own small game loop (independent of the main game
// tree, like the calibration screen) so a sparring game never touches the user's
// analysis. These helpers apply moves and read game state via chessops; keeping
// them pure makes the loop testable without a board or a Tauri shell.

import { Chess } from "chessops/chess";
import { parseFen, makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { parseEngineUci } from "@chessgui/core/uci-parser";

// SparColor extracted to @chessgui/core (spec 220 step 5); re-exported so
// existing importers keep working.
import type { SparColor } from "@chessgui/core/spar-types";
export type { SparColor };

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

// ---------------------------------------------------------------------------
// Draw-offer acceptance (spec 214, "Spar modes + game controls")
// ---------------------------------------------------------------------------

/**
 * The rule an "Offer draw" click is judged by. No one-shot engine-eval Tauri
 * command exists yet (checked src-tauri/src — the app's engine analysis is a
 * persistent streaming process, not a single evaluate-this-FEN call), so
 * acceptance uses an honest material/quietness proxy instead of a hidden coin
 * flip. Shown verbatim in the UI (tooltip) — the rule is never hidden dice.
 */
export const DRAW_OFFER_RULE_DESCRIPTION =
  "Accepts a draw offer when material is exactly equal, it's at least move 30, and neither side has captured or given check in the last 6 plies.";

const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

/** Material balance (white − black) in standard point values, read straight
 *  off a FEN's board field. Kings excluded — always present, never decisive. */
function materialBalance(fen: string): number {
  const board = fen.split(" ")[0] ?? "";
  let balance = 0;
  for (const ch of board) {
    const value = PIECE_VALUES[ch.toLowerCase()];
    if (!value) continue;
    balance += ch === ch.toLowerCase() ? -value : value;
  }
  return balance;
}

/** Fullmove number from a FEN (field 6, 1-indexed; defaults to 1 if missing). */
function fullmoveOf(fen: string): number {
  const n = parseInt(fen.split(" ")[5] ?? "1", 10);
  return Number.isFinite(n) ? n : 1;
}

/**
 * Whether a draw offer at `fen` (the position right after the offering move)
 * is accepted under DRAW_OFFER_RULE_DESCRIPTION: material exactly equal,
 * fullmove >= 30, and the last 6 recorded plies were quiet (no captures or
 * checks — read straight off their SAN, which already encodes both via "x"
 * and a "+"/"#" suffix). Needs at least 6 recorded plies to judge quietness.
 */
export function evaluateDrawOffer(fen: string, plies: SparPly[]): boolean {
  if (materialBalance(fen) !== 0) return false;
  if (fullmoveOf(fen) < 30) return false;
  if (plies.length < 6) return false;
  const lastSix = plies.slice(-6);
  return lastSix.every((p) => !p.san.includes("x") && !/[+#]$/.test(p.san));
}

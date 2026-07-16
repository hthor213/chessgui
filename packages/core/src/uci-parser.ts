import { Chess, castlingSide, normalizeMove, type Position } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { isNormal, kingCastlesTo, makeSquare, makeUci, parseUci, squareFile, squareRank, type Move } from "chessops";

export interface UciScore {
  type: "cp" | "mate";
  value: number;
}

export interface UciInfo {
  depth: number;
  seldepth?: number;
  multipv: number;
  score: UciScore;
  nodes?: number;
  nps?: number;
  time?: number;
  pv: string[]; // UCI long algebraic
}

export interface PvLine {
  multipv: number;
  score: UciScore;
  depth: number;
  sanMoves: string[];
  uciMoves: string[];
}

export function parseUciInfo(line: string): UciInfo | null {
  if (!line.startsWith("info ") || !line.includes(" pv ")) return null;

  const tokens = line.split(/\s+/);
  const info: Partial<UciInfo> = { multipv: 1 };

  for (let i = 1; i < tokens.length; i++) {
    switch (tokens[i]) {
      case "depth":
        info.depth = parseInt(tokens[++i]);
        break;
      case "seldepth":
        info.seldepth = parseInt(tokens[++i]);
        break;
      case "multipv":
        info.multipv = parseInt(tokens[++i]);
        break;
      case "score":
        if (tokens[i + 1] === "cp") {
          info.score = { type: "cp", value: parseInt(tokens[i + 2]) };
          i += 2;
        } else if (tokens[i + 1] === "mate") {
          info.score = { type: "mate", value: parseInt(tokens[i + 2]) };
          i += 2;
        }
        break;
      case "nodes":
        info.nodes = parseInt(tokens[++i]);
        break;
      case "nps":
        info.nps = parseInt(tokens[++i]);
        break;
      case "time":
        info.time = parseInt(tokens[++i]);
        break;
      case "pv":
        info.pv = tokens.slice(i + 1);
        i = tokens.length; // consume rest
        break;
    }
  }

  if (info.depth === undefined || !info.score || !info.pv?.length) return null;

  return info as UciInfo;
}

// --- UCI castling normalization ------------------------------------------
//
// Engines speak standard UCI castling (e1g1 = king to its destination) unless
// UCI_Chess960 is set, while chessops represents castling as king-takes-rook
// (e1h1). The conversion is position-dependent: only a king move can castle,
// and in Chess960 the king/rook start squares are arbitrary, so string maps
// are not safe. These helpers use chessops' own castling logic.

/**
 * Parse a UCI move coming FROM an engine into chessops' internal
 * representation. Accepts both standard castling UCI (e1g1) and
 * king-takes-rook form (e1h1); non-castling moves pass through unchanged.
 */
export function parseEngineUci(pos: Position, uci: string): Move | undefined {
  const move = parseUci(uci);
  if (!move) return undefined;
  return normalizeMove(pos, move);
}

// A castling move is expressible in standard UCI only when the pieces stand
// on the classical squares (king on e-file, rook in the corner). Otherwise —
// i.e. Chess960 — king-takes-rook is the only unambiguous notation.
function isClassicalCastling(pos: Position, move: Move): boolean {
  if (!isNormal(move)) return false;
  const side = castlingSide(pos, move);
  if (!side) return false;
  const backrank = pos.turn === "white" ? 0 : 7;
  if (squareRank(move.from) !== backrank || squareFile(move.from) !== 4) return false;
  const rook = pos.castles.rook[pos.turn][side];
  return rook === backrank * 8 + (side === "h" ? 7 : 0);
}

/**
 * Render a chessops move as UCI for sending TO an engine: standard castling
 * notation (e1g1) for classical setups, king-takes-rook for Chess960.
 */
export function makeEngineUci(pos: Position, move: Move): string {
  if (isNormal(move) && isClassicalCastling(pos, move)) {
    const side = castlingSide(pos, move)!;
    return makeUci({ from: move.from, to: kingCastlesTo(pos.turn, side) });
  }
  return makeUci(move);
}

/**
 * First-move arrow for a PV line: origin/destination squares for display.
 * Castling arrows point at the king's destination square, not the rook.
 * Returns null for unparseable or illegal moves (e.g. a stale PV that
 * belongs to a previous position).
 */
export function uciToArrow(fen: string, uci: string): { orig: string; dest: string } | null {
  const setup = parseFen(fen);
  if (setup.isErr) return null;
  const pos = Chess.fromSetup(setup.unwrap());
  if (pos.isErr) return null;
  const chess = pos.unwrap();

  const move = parseEngineUci(chess, uci);
  if (!move || !isNormal(move) || !chess.isLegal(move)) return null;

  const side = castlingSide(chess, move);
  const dest = side ? kingCastlesTo(chess.turn, side) : move.to;
  return { orig: makeSquare(move.from), dest: makeSquare(dest) };
}

export function uciMovesToSan(fen: string, uciMoves: string[], maxMoves = 8): string[] {
  const setup = parseFen(fen);
  if (setup.isErr) return uciMoves.slice(0, maxMoves);

  const pos = Chess.fromSetup(setup.unwrap());
  if (pos.isErr) return uciMoves.slice(0, maxMoves);

  const chess = pos.unwrap();
  const sanMoves: string[] = [];

  for (const uci of uciMoves.slice(0, maxMoves)) {
    const move = parseEngineUci(chess, uci);
    if (!move) break;

    try {
      const san = makeSan(chess, move);
      sanMoves.push(san);
      chess.play(move);
    } catch {
      break;
    }
  }

  return sanMoves;
}

export function formatScore(score: UciScore, turn: "white" | "black"): string {
  const flip = turn === "black" ? -1 : 1;

  if (score.type === "mate") {
    const v = score.value * flip;
    return v > 0 ? `+M${v}` : `-M${Math.abs(v)}`;
  }

  const cp = (score.value * flip) / 100;
  const sign = cp > 0 ? "+" : "";
  return `${sign}${cp.toFixed(2)}`;
}

export function scoreToNumeric(score: UciScore, turn: "white" | "black"): number {
  const flip = turn === "black" ? -1 : 1;
  if (score.type === "mate") {
    return score.value * flip > 0 ? 1000 : -1000;
  }
  return (score.value * flip) / 100;
}

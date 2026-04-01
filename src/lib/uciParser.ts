import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { parseUci } from "chessops";

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

export function uciMovesToSan(fen: string, uciMoves: string[], maxMoves = 8): string[] {
  const setup = parseFen(fen);
  if (setup.isErr) return uciMoves.slice(0, maxMoves);

  const pos = Chess.fromSetup(setup.unwrap());
  if (pos.isErr) return uciMoves.slice(0, maxMoves);

  const chess = pos.unwrap();
  const sanMoves: string[] = [];

  for (const uci of uciMoves.slice(0, maxMoves)) {
    const move = parseUci(uci);
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

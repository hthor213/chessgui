// The Eval-Map (spec 226): the moves you explored from a position, coloured on
// the board by how good they turned out — red (bad for me) through yellow to
// green (good for me), gray when you moved there but never judged the line.
//
// This is coverage made spatial. It reads ONLY the children of a node — the
// moves the player actually put on the board — never the legal-move list. A
// legal square you never tried gets nothing: no disc, no hint the piece could
// go there. That silence is the fair-play axiom (spec 226: display state, never
// recommend) drawn on the board, not a limitation of the drawing.

import { FILE_NAMES, squareFile } from "chessops";
import { parseFen } from "chessops/fen";
import type { GameTree } from "./game-tree";
import { squareToKey } from "./game-tree";
import type { NodeValue } from "./notebook";

export interface EvalMark {
  /** Destination square of the candidate move, e.g. "d5". */
  destKey: string;
  /** hsl(...) fill: red→yellow→green by value, gray when unjudged. */
  color: string;
  /** What sits inside the disc: the piece letter, or a pawn's from-file, so
   *  two pieces reaching one square read apart (N vs the e-pawn). */
  letter: string;
  /** The reader's-side value that set the colour, or null (gray). Kept for
   *  tests and any tie-breaking; the UI only needs `color`. */
  mine: number | null;
}

const ROLE_LETTER: Record<string, string> = {
  knight: "N",
  bishop: "B",
  rook: "R",
  queen: "Q",
  king: "K",
};

/**
 * red at −3, yellow at 0, green at +3 (the reader's own side). Gray when the
 * move was played but the line under it was never judged (`objective` null).
 */
export function evalMapColor(mine: number | null): string {
  if (mine === null) return "hsl(0 0% 48%)";
  const m = Math.max(-3, Math.min(3, mine));
  const hue = ((m + 3) / 6) * 120; // −3→0° red, 0→60° yellow, +3→120° green
  return `hsl(${Math.round(hue)} 65% 45%)`;
}

/**
 * The Eval-Map marks for the candidates the player explored from `nodeId`: one
 * disc per OWN candidate child (`src === undefined` — never a supplied database
 * move or a synced-in played move, spec 226 C), placed on that move's
 * destination square and coloured by the backed line value from the reader's
 * side. Two candidates that share a destination yield two marks on that square.
 */
export function buildEvalMap(
  tree: GameTree,
  values: Map<string, NodeValue>,
  nodeId: string,
  myColor: "white" | "black",
): EvalMark[] {
  const node = tree.get(nodeId);
  if (!node) return [];
  const setup = parseFen(node.fen);
  if (setup.isErr) return [];
  const board = setup.unwrap().board;
  const marks: EvalMark[] = [];
  for (const childId of node.children) {
    const child = tree.get(childId);
    if (!child?.move || child.src !== undefined) continue; // own candidates only
    const piece = board.get(child.move.from);
    const letter = !piece
      ? ""
      : piece.role === "pawn"
        ? FILE_NAMES[squareFile(child.move.from)]
        : (ROLE_LETTER[piece.role] ?? "");
    const objective = values.get(childId)?.objective ?? null;
    const mine = objective === null ? null : myColor === "white" ? objective : -objective;
    marks.push({ destKey: squareToKey(child.move.to), color: evalMapColor(mine), letter, mine });
  }
  return marks;
}

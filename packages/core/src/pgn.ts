// PGN import/export on top of the variation tree (spec 013). Leans on
// chessops/pgn for the hard parts — parsing, serialization, and the
// {%cal]/[%csl]/[%eval]/[%clk} comment-tag grammar — and maps between
// chessops' PgnNodeData and our MoveNode. Pure and unit-tested; the acceptance
// bar is import→export→import producing an identical tree.

import {
  parsePgn,
  makePgn,
  parseComment,
  makeComment,
  startingPosition,
  Node,
  ChildNode,
  type Game,
  type PgnNodeData,
  type CommentShape,
  type CommentShapeColor,
  type Evaluation,
} from "chessops/pgn";
import { makeFen } from "chessops/fen";
import { parseSquare, makeSquare } from "chessops";
import {
  GameTree,
  INITIAL_FEN,
  type ArrowAnnotation,
  type MoveNode,
  type NodeEval,
} from "./game-tree";

const SHAPE_COLORS: ReadonlySet<string> = new Set(["green", "red", "yellow", "blue"]);

function brushToColor(brush: string): CommentShapeColor {
  return (SHAPE_COLORS.has(brush) ? brush : "green") as CommentShapeColor;
}

// PGN [%eval] is in pawns (white-perspective); the tree stores centipawns.
// Convert at this boundary in both directions.
function evalToNode(ev: Evaluation): NodeEval {
  return "pawns" in ev
    ? { cp: Math.round(ev.pawns * 100), depth: ev.depth }
    : { mate: ev.mate, depth: ev.depth };
}

function nodeToEval(ev: NodeEval): Evaluation {
  return ev.mate !== undefined
    ? { mate: ev.mate, depth: ev.depth }
    : { pawns: (ev.cp ?? 0) / 100, depth: ev.depth };
}

// ---- Import -------------------------------------------------------------

// Fold every comment string on a chessops node (both the before-move
// `startingComments` and after-move `comments`) into our per-node fields.
// parseComment strips the [%…] tags out of the text, so text and structured
// annotations land in separate fields — the same on every import, which is
// what makes the round-trip stable.
function applyPgnData(tree: GameTree, id: string, data: PgnNodeData): void {
  const node = tree.get(id);
  if (!node) return;
  if (data.nags && data.nags.length) node.nags = [...data.nags];

  const strings = [...(data.startingComments || []), ...(data.comments || [])];
  if (strings.length === 0) return;

  const texts: string[] = [];
  const arrows: ArrowAnnotation[] = [];
  let evaluation: Evaluation | undefined;
  let clock: number | undefined;

  for (const s of strings) {
    const c = parseComment(s);
    if (c.text) texts.push(c.text);
    for (const shape of c.shapes) {
      // Circles ([%csl], from === to) are stored dest-less — the same
      // convention the board's user-drawn shapes use.
      if (shape.from === shape.to) {
        arrows.push({ orig: makeSquare(shape.from), brush: shape.color });
      } else {
        arrows.push({ orig: makeSquare(shape.from), dest: makeSquare(shape.to), brush: shape.color });
      }
    }
    if (c.evaluation) evaluation = c.evaluation;
    if (c.clock !== undefined) clock = c.clock;
  }

  node.comment = texts.join(" ");
  // makeComment always writes [%csl] (single-square circles) before [%cal]
  // (arrows), so canonicalize to that order on import too — otherwise the
  // arrow order would flip on the first round-trip.
  if (arrows.length) {
    node.arrows = [
      ...arrows.filter((a) => a.dest === undefined),
      ...arrows.filter((a) => a.dest !== undefined),
    ];
  }
  if (evaluation) node.eval = evalToNode(evaluation);
  if (clock !== undefined) node.clock = clock;
}

function buildTreeFromGame(game: Game<PgnNodeData>): GameTree {
  const headers: Record<string, string> = {};
  for (const [k, v] of game.headers) headers[k] = v;

  const posR = startingPosition(game.headers);
  const startFen = posR.isOk ? makeFen(posR.unwrap().toSetup()) : INITIAL_FEN;

  const tree = GameTree.create(startFen, headers);

  // Game-level comment (before the first move) lives on the root node.
  if (game.comments && game.comments.length) {
    const texts = game.comments.map((c) => parseComment(c).text).filter(Boolean);
    if (texts.length) tree.root().comment = texts.join(" ");
  }

  // Depth-first: children[0] is the mainline, the rest are variations, which
  // GameTree.addMoveSan reproduces automatically (first move appended is
  // mainline, later divergent moves become branches).
  const addChildren = (pgnNode: Node<PgnNodeData>, parentId: string): void => {
    for (const child of pgnNode.children) {
      tree.goTo(parentId);
      const id = tree.addMoveSan(child.data.san);
      if (!id) continue; // skip an illegal move and its subtree
      applyPgnData(tree, id, child.data);
      addChildren(child, id);
    }
  };
  addChildren(game.moves, tree.rootId);

  tree.goToStart();
  return tree;
}

/** Parse a PGN string into one GameTree per game (variations preserved). */
export function parsePgnToTrees(pgn: string): GameTree[] {
  return parsePgn(pgn).map(buildTreeFromGame);
}

// ---- Export -------------------------------------------------------------

function nodeToData(node: MoveNode): PgnNodeData {
  const data: PgnNodeData = { san: node.san };
  if (node.nags.length) data.nags = [...node.nags];

  const shapes: CommentShape[] = [];
  for (const a of node.arrows) {
    const from = parseSquare(a.orig);
    // Dest-less entries are circles; chessops encodes a circle as from === to.
    const to = a.dest === undefined ? from : parseSquare(a.dest);
    if (from === undefined || to === undefined) continue;
    shapes.push({ color: brushToColor(a.brush), from, to });
  }

  const comment = makeComment({
    text: node.comment || undefined,
    shapes,
    evaluation: node.eval ? nodeToEval(node.eval) : undefined,
    clock: node.clock,
  });
  if (comment) data.comments = [comment];

  return data;
}

function buildPgnNode(tree: GameTree, nodeId: string): ChildNode<PgnNodeData> {
  const node = tree.get(nodeId)!;
  const pgnNode = new ChildNode<PgnNodeData>(nodeToData(node));
  for (const childId of node.children) {
    pgnNode.children.push(buildPgnNode(tree, childId));
  }
  return pgnNode;
}

/** Serialize a GameTree to standard PGN with variations and annotations. */
export function treeToPgn(tree: GameTree): string {
  const headers = new Map<string, string>();
  for (const [k, v] of Object.entries(tree.headers)) headers.set(k, v);

  // A non-standard start needs [FEN]/[SetUp]; if the tree came from such a
  // PGN the headers already carry them, so only add when missing.
  if (tree.startFen !== INITIAL_FEN && !headers.has("FEN")) {
    headers.set("FEN", tree.startFen);
    headers.set("SetUp", "1");
  }

  const root = new Node<PgnNodeData>();
  for (const childId of tree.root().children) {
    root.children.push(buildPgnNode(tree, childId));
  }

  const game: Game<PgnNodeData> = { headers, moves: root };
  const rootComment = tree.root().comment;
  if (rootComment) game.comments = [rootComment];

  return makePgn(game);
}

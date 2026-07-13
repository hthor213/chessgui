// Pure variation-tree model for a chess game. No React, no I/O — just the tree
// and its operations, so it can be unit-tested in isolation. Modeled on
// ChessX's GameCursor (see specs/016-game-tree.md): a flat Map of nodes keyed
// by id, each holding the position FEN *after* its move, its parent, and its
// children where children[0] is the mainline and children[1..] are variations.

import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { isNormal } from "chessops";
import type { NormalMove } from "chessops";
import { makeEngineUci, parseEngineUci } from "@/lib/uci-parser";

export const INITIAL_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export interface ArrowAnnotation {
  orig: string;
  dest: string;
  brush: string;
}

// Numeric evaluation attached to a position (from a PGN [%eval] tag or the
// engine). Exactly one of pawns/mate is set. Mirrors chessops' Evaluation.
export interface NodeEval {
  pawns?: number;
  mate?: number;
  depth?: number;
}

export interface MoveNode {
  id: string;
  move: NormalMove | null; // null for the root node
  san: string; // "" for root
  uci: string; // canonical engine UCI (960-safe via makeEngineUci); "" for root
  fen: string; // position AFTER this move (root: the start position)
  parent: string | null;
  children: string[]; // children[0] = mainline continuation, [1..] = variations
  ply: number; // half-move count from the start (root = 0)
  comment: string;
  nags: number[];
  arrows: ArrowAnnotation[];
  eval?: NodeEval; // [%eval] — position assessment after this move
  clock?: number; // [%clk] — clock time in seconds after this move
}

// Serialized shape for localStorage / snapshots. A plain object graph so it
// round-trips through JSON without custom reviver logic.
export interface SerializedTree {
  v: 2;
  nodes: Record<string, MoveNode>;
  rootId: string;
  currentId: string;
  startFen: string;
  headers: Record<string, string>;
  seq: number;
}

// Backwards-compatible alias: page.tsx snapshots the game as an opaque blob.
export type GameSnapshot = SerializedTree;

// ---- square / uci helpers (shared with the hook) ----

export function squareToKey(square: number): string {
  const file = String.fromCharCode(97 + (square & 7));
  const rank = String.fromCharCode(49 + (square >> 3));
  return `${file}${rank}`;
}

export function keyToSquare(key: string): number {
  const file = key.charCodeAt(0) - 97;
  const rank = key.charCodeAt(1) - 49;
  return rank * 8 + file;
}

function chessFromFen(fen: string): Chess {
  const setup = parseFen(fen);
  if (setup.isErr) throw new Error(`invalid FEN: ${fen}`);
  const pos = Chess.fromSetup(setup.unwrap());
  if (pos.isErr) throw new Error(`illegal position: ${fen}`);
  return pos.unwrap();
}

/**
 * A variation tree with an internal cursor. All mutations happen in place on
 * the node Map (no deep cloning); the React layer bumps a version counter to
 * trigger re-renders and calls `toJSON()` when it needs an immutable snapshot.
 */
export class GameTree {
  nodes: Map<string, MoveNode>;
  rootId: string;
  currentId: string;
  startFen: string;
  headers: Record<string, string>;
  private seq: number;

  private constructor(startFen: string, headers: Record<string, string>, seq = 0) {
    // Normalize the start FEN through chessops so it matches positions we
    // compute after moves (castling rights, en-passant square, etc.).
    const normFen = makeFen(chessFromFen(startFen).toSetup());
    this.seq = seq;
    const rootId = this.nextId();
    const root: MoveNode = {
      id: rootId,
      move: null,
      san: "",
      uci: "",
      fen: normFen,
      parent: null,
      children: [],
      ply: 0,
      comment: "",
      nags: [],
      arrows: [],
    };
    this.nodes = new Map([[rootId, root]]);
    this.rootId = rootId;
    this.currentId = rootId;
    this.startFen = normFen;
    this.headers = headers;
  }

  static create(startFen: string = INITIAL_FEN, headers: Record<string, string> = {}): GameTree {
    return new GameTree(startFen, headers);
  }

  /** Build a tree from a flat SAN list (mainline only) — the legacy shape. */
  static fromMoves(
    sans: string[],
    startFen: string = INITIAL_FEN,
    headers: Record<string, string> = {},
  ): GameTree {
    const tree = new GameTree(startFen, headers);
    for (const san of sans) {
      const id = tree.addMoveSan(san);
      if (!id) break; // stop on the first illegal move rather than throwing
    }
    tree.goToStart();
    return tree;
  }

  private nextId(): string {
    return `n${this.seq++}`;
  }

  // ---- accessors ----

  get(id: string): MoveNode | undefined {
    return this.nodes.get(id);
  }

  root(): MoveNode {
    return this.nodes.get(this.rootId)!;
  }

  currentNode(): MoveNode {
    return this.nodes.get(this.currentId)!;
  }

  atStart(): boolean {
    return this.currentId === this.rootId;
  }

  atEnd(): boolean {
    return this.currentNode().children.length === 0;
  }

  /** True when the cursor sits on the main line (all children[0] from root). */
  isMainline(): boolean {
    let node = this.currentNode();
    while (node.parent) {
      const parent = this.nodes.get(node.parent)!;
      if (parent.children[0] !== node.id) return false;
      node = parent;
    }
    return true;
  }

  variationCount(): number {
    const c = this.currentNode().children.length;
    return c > 0 ? c - 1 : 0;
  }

  // ---- navigation ----

  goTo(id: string): boolean {
    if (!this.nodes.has(id)) return false;
    this.currentId = id;
    return true;
  }

  forward(): boolean {
    const node = this.currentNode();
    if (node.children.length === 0) return false;
    this.currentId = node.children[0];
    return true;
  }

  backward(): boolean {
    const node = this.currentNode();
    if (!node.parent) return false;
    this.currentId = node.parent;
    return true;
  }

  goToStart(): void {
    this.currentId = this.rootId;
  }

  goToEnd(): void {
    let node = this.currentNode();
    while (node.children.length > 0) {
      node = this.nodes.get(node.children[0])!;
    }
    this.currentId = node.id;
  }

  /** Move into the variation at children[index] of the current node. */
  enterVariation(index: number): boolean {
    const node = this.currentNode();
    if (index < 0 || index >= node.children.length) return false;
    this.currentId = node.children[index];
    return true;
  }

  /** Nodes from the root (inclusive) to the given node (inclusive). */
  pathToNode(id: string): MoveNode[] {
    const out: MoveNode[] = [];
    let cur: MoveNode | undefined = this.nodes.get(id);
    while (cur) {
      out.push(cur);
      cur = cur.parent ? this.nodes.get(cur.parent) : undefined;
    }
    return out.reverse();
  }

  /**
   * The full line through the current node: the moves played to reach it,
   * followed by its mainline continuation. Excludes the root. This is the
   * flat-array view the UI and engine consume.
   */
  currentLine(): MoveNode[] {
    const path = this.pathToNode(this.currentId).slice(1); // drop root
    let tip = this.currentNode();
    const cont: MoveNode[] = [];
    while (tip.children.length > 0) {
      tip = this.nodes.get(tip.children[0])!;
      cont.push(tip);
    }
    return [...path, ...cont];
  }

  /** Index of the current node within `currentLine()` (-1 at the root). */
  currentIndex(): number {
    return this.pathToNode(this.currentId).length - 2;
  }

  /** Siblings of the branch that the current node belongs to (for up/down nav). */
  siblingBranchRoots(): string[] {
    const node = this.currentNode();
    if (!node.parent) return [];
    return this.nodes.get(node.parent)!.children;
  }

  // ---- mutation ----

  private appendChild(parent: MoveNode, move: NormalMove, san: string, uci: string, fen: string): MoveNode {
    const child: MoveNode = {
      id: this.nextId(),
      move,
      san,
      uci,
      fen,
      parent: parent.id,
      children: [],
      ply: parent.ply + 1,
      comment: "",
      nags: [],
      arrows: [],
    };
    this.nodes.set(child.id, child);
    parent.children.push(child.id);
    return child;
  }

  /**
   * Play a move from the current node. If a child with the same UCI already
   * exists, reuse it (no duplicate branches). Otherwise append a new child:
   * the first child becomes the mainline, later ones become variations. Never
   * truncates — playing a different move mid-game creates a variation. Moves
   * the cursor to the resulting node and returns its id, or null if illegal.
   */
  addMove(move: NormalMove): string | null {
    const parent = this.currentNode();
    let chess: Chess;
    try {
      chess = chessFromFen(parent.fen);
    } catch {
      return null;
    }
    let san: string;
    try {
      san = makeSan(chess, move);
    } catch {
      return null;
    }
    // makeSan returns "--" for a null/illegal move in some chessops versions.
    if (!san || san === "--") return null;
    // Canonical UCI: standard castling (e1g1) for classical setups,
    // king-takes-rook for Chess960 — computed against the pre-move position.
    const uci = makeEngineUci(chess, move);

    const existing = parent.children.find((cid) => this.nodes.get(cid)!.uci === uci);
    if (existing) {
      this.currentId = existing;
      return existing;
    }

    chess.play(move);
    const fen = makeFen(chess.toSetup());
    const child = this.appendChild(parent, move, san, uci, fen);
    this.currentId = child.id;
    return child.id;
  }

  addMoveSan(san: string): string | null {
    const parent = this.currentNode();
    let chess: Chess;
    try {
      chess = chessFromFen(parent.fen);
    } catch {
      return null;
    }
    const move = parseSan(chess, san);
    if (!move || !("from" in move)) return null;
    return this.addMove(move as NormalMove);
  }

  // Accepts engine UCI in either standard (e1g1) or king-takes-rook (e1h1)
  // castling form; parseEngineUci normalizes against the current position.
  addMoveUci(uci: string): string | null {
    const parent = this.currentNode();
    let chess: Chess;
    try {
      chess = chessFromFen(parent.fen);
    } catch {
      return null;
    }
    const move = parseEngineUci(chess, uci);
    if (!move || !isNormal(move)) return null;
    return this.addMove(move);
  }

  /**
   * Promote the variation containing `id` toward the mainline: the branch that
   * diverges from its parent's mainline is moved one slot earlier (a plain swap
   * with the current mainline at that branch point). Repeated calls walk a deep
   * sideline all the way to the top.
   */
  promoteVariation(id: string): boolean {
    // Find the branch-start: the ancestor (or self) whose parent lists it as a
    // non-first child. That node is the head of the variation to promote.
    let node = this.nodes.get(id);
    while (node && node.parent) {
      const parent = this.nodes.get(node.parent)!;
      const idx = parent.children.indexOf(node.id);
      if (idx > 0) {
        // swap with the sibling one slot earlier
        parent.children[idx] = parent.children[idx - 1];
        parent.children[idx - 1] = node.id;
        return true;
      }
      node = parent;
    }
    return false;
  }

  /** Remove `id` and its whole subtree. Returns false for the root. */
  deleteVariation(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node || !node.parent) return false; // never delete the root
    const parent = this.nodes.get(node.parent)!;

    // Collect the subtree.
    const doomed: string[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      doomed.push(cur);
      const n = this.nodes.get(cur);
      if (n) stack.push(...n.children);
    }
    const doomedSet = new Set(doomed);

    // Detach from parent and delete the nodes.
    parent.children = parent.children.filter((cid) => cid !== id);
    for (const d of doomed) this.nodes.delete(d);

    // If the cursor was inside the deleted subtree, retreat to the parent.
    if (doomedSet.has(this.currentId)) this.currentId = parent.id;
    return true;
  }

  // ---- annotations (storage only; UI lands in spec 202) ----

  setComment(id: string, comment: string): void {
    const node = this.nodes.get(id);
    if (node) node.comment = comment;
  }

  setNags(id: string, nags: number[]): void {
    const node = this.nodes.get(id);
    if (node) node.nags = [...nags];
  }

  setArrows(id: string, arrows: ArrowAnnotation[]): void {
    const node = this.nodes.get(id);
    if (node) node.arrows = [...arrows];
  }

  // ---- serialization ----

  toJSON(): SerializedTree {
    const nodes: Record<string, MoveNode> = {};
    for (const [id, node] of this.nodes) nodes[id] = node;
    return {
      v: 2,
      nodes,
      rootId: this.rootId,
      currentId: this.currentId,
      startFen: this.startFen,
      headers: this.headers,
      seq: this.seq,
    };
  }

  static fromJSON(data: SerializedTree): GameTree {
    const tree = GameTree.create(data.startFen, data.headers);
    tree.nodes = new Map(Object.entries(data.nodes));
    tree.rootId = data.rootId;
    tree.currentId = tree.nodes.has(data.currentId) ? data.currentId : data.rootId;
    tree.startFen = data.startFen;
    tree.headers = data.headers || {};
    // Restore the id counter so freshly added nodes never collide with loaded
    // ones, even if the stored `seq` is missing (older saves).
    let maxSeq = data.seq ?? 0;
    for (const id of tree.nodes.keys()) {
      const n = Number(id.replace(/^n/, ""));
      if (Number.isFinite(n) && n + 1 > maxSeq) maxSeq = n + 1;
    }
    (tree as unknown as { seq: number }).seq = maxSeq;
    return tree;
  }

  /** Deep, independent copy — used for snapshot/restore in thinking mode. */
  clone(): GameTree {
    return GameTree.fromJSON(JSON.parse(JSON.stringify(this.toJSON())));
  }
}

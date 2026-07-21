// Pure variation-tree model for a chess game. No React, no I/O — just the tree
// and its operations, so it can be unit-tested in isolation. Modeled on
// ChessX's GameCursor (see specs/016-game-tree.md): a flat Map of nodes keyed
// by id, each holding the position FEN *after* its move, its parent, and its
// children where children[0] is the mainline and children[1..] are variations.

import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { FILE_NAMES, isNormal, SquareSet, squareFile } from "chessops";
import type { NormalMove, Setup } from "chessops";
import { makeEngineUci, parseEngineUci } from "./uci-parser";
import { castlingFieldHasFileLetters } from "./fen";
// Value import is safe: active-game.ts only imports TYPES from this module,
// so the runtime dependency is one-directional (no cycle).
import { livePositionCanMove } from "./active-game";
import type {
  ActiveGameMeta,
  LivePositionRelation,
  LivePositionState,
} from "./active-game";

export const INITIAL_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Game variant (shared variant contract): absent = standard chess. */
export type GameVariant = "chess960";

// Shredder-FEN castling field (rook file letters, e.g. "DAda") from the raw
// castling-rights squares. chessops' makeFen writes X-FEN — K/Q whenever the
// rights rook is the outermost one — which erases WHICH rook holds the right
// on a 960 board; file letters are lossless and are what shakmaty and
// UCI_Chess960 engines expect. Same emit order as chessops (white then black,
// higher file first).
function shredderCastlingFen(setup: Setup): string {
  let out = "";
  for (const color of ["white", "black"] as const) {
    const backrank = SquareSet.backrank(color);
    for (const rook of setup.castlingRights.intersect(backrank).reversed()) {
      const file = FILE_NAMES[squareFile(rook)];
      out += color === "white" ? file.toUpperCase() : file;
    }
  }
  return out || "-";
}

/**
 * FEN for a setup. Standard games use chessops' makeFen unchanged (byte-for-
 * byte what every existing tree stores); chess960 games rewrite the castling
 * field to Shredder file letters so a mid-game 960 FEN round-trips.
 */
export function makeVariantFen(setup: Setup, variant?: GameVariant): string {
  const fen = makeFen(setup);
  if (variant !== "chess960") return fen;
  const parts = fen.split(" ");
  parts[2] = shredderCastlingFen(setup);
  return parts.join(" ");
}

export interface ArrowAnnotation {
  orig: string;
  /** Absent for a square highlight / circle (PGN [%csl]); present for an arrow ([%cal]). */
  dest?: string;
  brush: string;
}

/**
 * Evaluation stored per node — from a PGN [%eval] tag or the engine. White's
 * perspective (positive = White better), `cp` in centipawns, `mate` in moves.
 * Exactly one of cp/mate is set. `depth` is absent for PGN-imported evals
 * (treated as 0 when comparing in setEval).
 */
export interface NodeEval {
  cp?: number;
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
  eval?: NodeEval; // [%eval]/engine — optional so pre-0.2 saves load unchanged
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
  // Shared variant contract: absent = standard (every pre-existing save),
  // "chess960" = Fischer Random — node FENs then carry Shredder castling.
  variant?: GameVariant;
  // Spec 219: active-game (OTB compliance) flag + metadata. Lives on the
  // serialized game so EVERY load path re-applies the engine lockout.
  // Optional so pre-219 saves load unchanged (absent = not an active game).
  activeGame?: ActiveGameMeta | null;
}

// Backwards-compatible alias: page.tsx snapshots the game as an opaque blob.
export type GameSnapshot = SerializedTree;

// ---- square / uci helpers (shared with the hook) ----

// ---- who played a move, and under what number ----
//
// `node.ply` counts half-moves from the start of the TREE, so parity only
// identifies the mover when the tree starts with White to move. Any game set
// up from an arbitrary position breaks that: a position entered with Black on
// move (spec 014's editor — a fair-play game joined mid-stream, or a position
// copied off a broadcast) files every move under the wrong colour.
//
// That was cosmetic in the move list and NOT cosmetic anywhere the mover's
// colour sets the sign of an evaluation: judgeMove's ?!/?/?? annotations and
// the per-game performance Elo both inverted, scoring blunders as brilliancies
// (found 2026-07-20 while building the fair-play move table).
//
// The node's own FEN settles both questions exactly, so derive from it.

/** Whether White played the move that produced this node. */
export function moverIsWhite(node: MoveNode): boolean {
  // node.fen is the position AFTER the move, so it is the OTHER side's turn.
  return node.fen.split(" ")[1] === "b";
}

/** The mover's colour and the move number this move belongs to. */
export function moveSlot(node: MoveNode): { isWhite: boolean; moveNo: number } {
  const parts = node.fen.split(" ");
  const isWhite = parts[1] === "b";
  const fullmove = Number(parts[5]);
  if (!Number.isFinite(fullmove)) {
    // Malformed FEN — fall back to ply arithmetic rather than throwing.
    return { isWhite, moveNo: Math.ceil(node.ply / 2) };
  }
  // White just moved → the counter has not ticked yet. Black just moved → it
  // has, so this move belongs to the number before it.
  return { isWhite, moveNo: isWhite ? fullmove : fullmove - 1 };
}

/** "12." for White, "12..." for Black — the PGN-style prefix for a move. */
export function moveNumberPrefix(node: MoveNode): string {
  const { isWhite, moveNo } = moveSlot(node);
  return `${moveNo}${isWhite ? "." : "..."}`;
}

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
  /** Absent = standard chess; "chess960" switches FEN emit to Shredder castling. */
  variant?: GameVariant;
  // Spec 219: non-null flags this as an ACTIVE chess.com daily game — the
  // engine lockout key. Serialized with the tree; cleared only by the
  // archive step (or explicit deletion behind the fair-play confirmation).
  activeGame: ActiveGameMeta | null = null;
  private seq: number;

  private constructor(
    startFen: string,
    headers: Record<string, string>,
    seq = 0,
    variant?: GameVariant,
  ) {
    // A start FEN whose castling field already uses file letters is a 960
    // position even when the caller didn't say so (e.g. a pasted Shredder
    // FEN) — auto-detect so its castling rights survive normalization.
    this.variant = variant ?? (castlingFieldHasFileLetters(startFen) ? "chess960" : undefined);
    // Normalize the start FEN through chessops so it matches positions we
    // compute after moves (castling rights, en-passant square, etc.).
    const normFen = makeVariantFen(chessFromFen(startFen).toSetup(), this.variant);
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

  static create(
    startFen: string = INITIAL_FEN,
    headers: Record<string, string> = {},
    variant?: GameVariant,
  ): GameTree {
    return new GameTree(startFen, headers, 0, variant);
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
   * Where a node sits relative to the live position (spec 219 F). Used to
   * decide whether the board accepts moves and what the live badge says.
   * `fromId` defaults to the cursor.
   */
  livePositionState(
    liveId: string | null | undefined,
    fromId: string = this.currentId,
  ): LivePositionState {
    const unknown: LivePositionState = { relation: "unknown", distance: 0, canMove: true };
    if (!liveId || !this.nodes.has(liveId) || !this.nodes.has(fromId)) return unknown;

    const settle = (relation: LivePositionRelation, distance: number): LivePositionState => ({
      relation,
      distance,
      canMove: livePositionCanMove(relation),
    });
    if (fromId === liveId) return settle("live", 0);

    const live = this.nodes.get(liveId)!;
    const from = this.nodes.get(fromId)!;

    // Ancestors of the cursor: if the live node is among them, the cursor is
    // exploring forward from reality — the permitted case.
    const cursorAncestors = new Set(this.pathToNode(fromId).map((n) => n.id));
    if (cursorAncestors.has(liveId)) return settle("ahead", from.ply - live.ply);

    // Otherwise the cursor is behind the live node (a strict ancestor of it)
    // or off on a line that left before it. Both are non-branchable; the
    // distinction only changes the wording shown to the user.
    const livePath = this.pathToNode(liveId);
    if (livePath.some((n) => n.id === fromId)) return settle("behind", live.ply - from.ply);

    let divergePly = 0;
    for (const node of livePath) {
      if (cursorAncestors.has(node.id)) divergePly = node.ply;
      else break;
    }
    return settle("off-branch", from.ply - divergePly);
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

  /** Root plus the mainline (children[0] chain) — the eval graph's x-axis. */
  mainlineNodes(): MoveNode[] {
    const out: MoveNode[] = [this.root()];
    let node = this.root();
    while (node.children.length > 0) {
      node = this.nodes.get(node.children[0])!;
      out.push(node);
    }
    return out;
  }

  /** Siblings of the branch that the current node belongs to (for up/down nav). */
  siblingBranchRoots(): string[] {
    const node = this.currentNode();
    if (!node.parent) return [];
    return this.nodes.get(node.parent)!.children;
  }

  /**
   * Up/Down variation navigation (spec 001): walk into, between, and out of
   * variations. `+1` (Down) moves to the sibling branch one slot later at the
   * current move; with none left it steps INTO the first variation branching
   * off the next move. `-1` (Up) moves one sibling earlier (the first slot is
   * the mainline move — that alone walks out of a one-move variation); from
   * deeper inside a variation it climbs OUT to the mainline move at the
   * branch point. Returns true when the cursor moved.
   */
  cycleVariation(direction: 1 | -1): boolean {
    const node = this.currentNode();
    if (node.parent) {
      const siblings = this.nodes.get(node.parent)!.children;
      const next = siblings.indexOf(node.id) + direction;
      if (next >= 0 && next < siblings.length) {
        this.currentId = siblings[next];
        return true;
      }
    }
    if (direction === 1) {
      // No later sibling — step into the next move's first variation.
      return node.children.length > 1 ? this.goTo(node.children[1]) : false;
    }
    // No earlier sibling — if inside a variation, land on the mainline move
    // it diverges from.
    let cur = node;
    while (cur.parent) {
      const parent = this.nodes.get(cur.parent)!;
      if (parent.children[0] !== cur.id) return this.goTo(parent.children[0]);
      cur = parent;
    }
    return false;
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
    // A 960 game forces king-takes-rook even on classical squares, since
    // its engine runs with UCI_Chess960 set (spec 011).
    const uci = makeEngineUci(chess, move, this.variant === "chess960");

    const existing = parent.children.find((cid) => this.nodes.get(cid)!.uci === uci);
    if (existing) {
      this.currentId = existing;
      return existing;
    }

    chess.play(move);
    const fen = makeVariantFen(chess.toSetup(), this.variant);
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
   * Make `id` its parent's mainline continuation outright (slot 0), keeping
   * the displaced siblings in order behind it. Unlike `promoteVariation`,
   * which walks a deep sideline up one level per call, this is a single
   * decisive move at one branch point — what the chess.com sync needs when
   * reality turns out to be the line the user had left as a variation
   * (spec 219 F). No-op at the root or when already mainline.
   */
  promoteToMainline(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node?.parent) return false;
    const parent = this.nodes.get(node.parent)!;
    const idx = parent.children.indexOf(id);
    if (idx <= 0) return false;
    parent.children.splice(idx, 1);
    parent.children.unshift(id);
    return true;
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

  /**
   * Play-mode take-back: from the current node, delete back to the most recent
   * position where it's `playerColor`'s turn — removing the taken-back moves
   * from the tree — and leave the cursor there. This takes back the user's last
   * move plus the engine's reply (if it has already answered), or just the
   * user's move if it hasn't. Returns false when there is nothing to take back
   * (already at such a position, e.g. the game start).
   */
  takeBack(playerColor: "white" | "black"): boolean {
    const path = this.pathToNode(this.currentId); // [root, …, current]
    for (let i = path.length - 2; i >= 0; i--) {
      const turn = path[i].fen.split(" ")[1] === "b" ? "black" : "white";
      if (turn === playerColor) {
        // Delete the child leading toward current; deleteVariation removes the
        // whole subtree and retreats the cursor onto path[i].
        return this.deleteVariation(path[i + 1].id);
      }
    }
    return false;
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

  /**
   * Store an engine eval on a node. Refuses to overwrite a deeper eval with a
   * shallower one (live analysis streams increasing depths; a re-visit at low
   * depth shouldn't degrade what's stored). Returns true when the node changed.
   */
  setEval(id: string, ev: NodeEval): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    const prev = node.eval;
    if (prev && (prev.depth ?? 0) > (ev.depth ?? 0)) return false;
    if (prev && prev.depth === ev.depth && prev.cp === ev.cp && prev.mate === ev.mate) {
      return false;
    }
    node.eval = { ...ev };
    return true;
  }

  // ---- serialization ----

  toJSON(): SerializedTree {
    const nodes: Record<string, MoveNode> = {};
    for (const [id, node] of this.nodes) nodes[id] = node;
    const out: SerializedTree = {
      v: 2,
      nodes,
      rootId: this.rootId,
      currentId: this.currentId,
      startFen: this.startFen,
      headers: this.headers,
      seq: this.seq,
    };
    // Written only when set, so standard-game saves keep their prior shape
    // byte-identically (same stance as the pre-219 activeGame field).
    if (this.variant) out.variant = this.variant;
    if (this.activeGame) out.activeGame = this.activeGame;
    return out;
  }

  static fromJSON(data: SerializedTree): GameTree {
    // create() re-detects chess960 from the startFen when `variant` is absent
    // (saves written before the field existed still carry Shredder castling).
    const tree = GameTree.create(data.startFen, data.headers, data.variant);
    tree.nodes = new Map(Object.entries(data.nodes));
    // Saves from before an annotation field existed simply lack the key —
    // normalize so the rest of the code never sees undefined arrays. `eval`
    // stays optional by design.
    for (const node of tree.nodes.values()) {
      node.comment ??= "";
      node.nags ??= [];
      node.arrows ??= [];
    }
    tree.rootId = data.rootId;
    tree.currentId = tree.nodes.has(data.currentId) ? data.currentId : data.rootId;
    tree.startFen = data.startFen;
    tree.headers = data.headers || {};
    // Spec 219: absent on pre-219 saves means "known not active" — a normal
    // game, not an ambiguity. Normalized to null so the guard predicate
    // (engineAllowedForGame) never sees undefined from a loaded tree.
    tree.activeGame = data.activeGame ?? null;
    // Chess960 (spec 011): absent on pre-960 saves = standard chess.
    if (data.variant === "chess960") tree.variant = "chess960";
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

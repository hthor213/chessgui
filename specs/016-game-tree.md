# 016: Game Tree — Variation Tree Model

**Status:** draft
**Band:** Foundation
**Depends on:** 001 (board & gameplay), 002 (UX/UI migration), 013 (PGN import)
**Blocks:** 200 (database & opening explorer), 202 (annotations & eval graph)

## Problem

Our current game model (`useChessGame.ts`) stores moves as a flat `string[]` array. This cannot represent:

- **Variations** — "what if 5...Nf6 instead of 5...e5?"
- **Nested variations** — variations within variations
- **Per-move annotations** — comments, NAGs (!!, ?!, etc.), eval scores
- **Variation promotion** — promoting a sideline to the mainline

Every serious chess app (ChessX, SCID, En-Croissant, Lichess study) uses a **tree** to represent a game. Without this, we can't build database, annotations, opening tree, or PGN export with variations.

## Reference: ChessX's GameCursor

ChessX uses a `GameCursor` class (studied in `/tmp/chessx/src/database/gamecursor.h`). Key design:

```
Node {
  previousNode: MoveId   // parent in the line
  nextNode: MoveId        // next move in the line
  parentNode: MoveId      // branch point (for variations)
  move: Move              // the actual move
  variations: MoveId[]    // list of alternative continuations
  ply: number             // half-move count
}
```

Navigation: `forward()`, `backward()`, `moveIntoVariation()`, `moveToId()`, `moveToStart()`, `moveToEnd()`.

Mutations: `addMove()`, `addVariation()`, `promoteVariation()`, `removeVariation()`, `truncateFrom()`.

## Design

### Data Structure

```typescript
interface MoveNode {
  id: string;                    // unique node ID (e.g., uuid or incrementing counter)
  move: Move | null;             // null for root node
  san: string;                   // SAN notation (e.g., "Nf3")
  fen: string;                   // position AFTER this move
  parent: string | null;         // parent node ID
  children: string[];            // mainline continuation + variations (first child = mainline)
  comment: string;               // text annotation
  nags: number[];                // NAG codes ($1 = !, $2 = ?, etc.)
  arrows: ArrowAnnotation[];     // [csl/cal] square/arrow annotations
}

interface GameTree {
  nodes: Map<string, MoveNode>;  // all nodes by ID
  rootId: string;                // root node (starting position)
  currentId: string;             // cursor position
  headers: Record<string, string>; // PGN headers
}
```

### Why This Shape

- **`children[0]` is always mainline** — simple convention, no separate field needed
- **`children[1..]` are variations** — ordered, can be reordered for promotion
- **Flat `Map` + IDs** (not nested objects) — makes cursor movement O(1), avoids deep cloning on state updates
- **FEN stored per node** — enables instant position lookup without replaying from root. Costs ~80 bytes/node but eliminates expensive recomputation.

### Navigation API

```typescript
interface GameCursor {
  // Movement
  forward(): boolean;           // move to children[0] (mainline)
  backward(): boolean;          // move to parent
  goToStart(): void;            // move to root
  goToEnd(): void;              // follow mainline to end
  goToNode(id: string): void;   // jump to any node

  // Variation navigation
  enterVariation(index: number): void;  // move to children[index]
  exitVariation(): void;                // go back to branch point

  // Queries
  isMainline(): boolean;
  variationCount(): number;
  atStart(): boolean;
  atEnd(): boolean;
  currentNode(): MoveNode;
  mainlineMoves(): MoveNode[];  // flat array of mainline for display
  pathToNode(id: string): MoveNode[]; // breadcrumb from root
}
```

### Mutation API

```typescript
interface GameTreeMutations {
  // Adding moves
  addMove(move: Move): string;          // add as next mainline move (truncates if mid-game)
  addVariation(move: Move): string;     // add as variation at current position

  // Variation management
  promoteVariation(nodeId: string): void;  // swap variation with mainline
  deleteVariation(nodeId: string): void;   // remove entire subtree
  
  // Annotations
  setComment(nodeId: string, comment: string): void;
  setNags(nodeId: string, nags: number[]): void;

  // Import
  loadFromPgn(pgn: string): void;       // parse PGN including variations
  loadFromMoves(sans: string[]): void;   // simple flat list (current behavior)
}
```

### React Integration

Replace `useChessGame` internals with `GameTree`, keeping the same external API where possible:

```typescript
function useChessGame() {
  const [tree, setTree] = useState<GameTree>(createInitialTree());
  
  // Existing API surface preserved:
  // fen, orientation, onMove, legalMoves, lastMove,
  // moves (mainline), currentMoveIndex, goToMove
  
  // New API additions:
  // addVariation, enterVariation, exitVariation,
  // promoteVariation, deleteVariation,
  // setComment, setNags, currentNode
}
```

### MoveList Component Changes

The `MoveList` must render a tree, not a flat list:

```
1. e4  e5  2. Nf3  Nc6  3. Bb5
  └─ 2... d6  3. d4  (variation)
       └─ 3... Bg4  (nested variation)
```

This is a recursive rendering problem. Each variation is indented and rendered inline (like Lichess studies) or as a collapsible block.

## Migration Path

1. **Phase 1:** Implement `GameTree` data structure and `useGameTree` hook
2. **Phase 2:** Adapt `useChessGame` to use `GameTree` internally (keep external API compatible)
3. **Phase 3:** Update `MoveList` to render variations
4. **Phase 4:** Update PGN import to parse variations (chessops supports this)
5. **Phase 5:** Wire up annotation API

## Done When

- [ ] `GameTree` data structure with nodes, cursor, and navigation
- [ ] `addMove` works: playing moves builds the tree (mainline)
- [ ] `addVariation` works: alternative moves create branches
- [ ] `promoteVariation` swaps a variation with the mainline
- [ ] `deleteVariation` removes a subtree
- [ ] Navigation: forward, backward, enter/exit variation, go to start/end
- [ ] MoveList renders variations (indented or inline)
- [ ] PGN import preserves variations from the PGN
- [ ] PGN export includes variations
- [ ] Existing flat-move workflows (play, analyze) still work unchanged
- [ ] Per-node comment and NAG storage (display can come in spec:202)

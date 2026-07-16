# 202: Annotations & Eval Graph

**Status:** draft
**Depends on:** 016 (game tree — annotations stored per-node)

## Goal
Per-move annotations (comments, NAGs, arrows, eval scores) with a visual eval graph. PGN-standard format for interoperability with Lichess studies, ChessBase, and other tools.

## Annotation Data Model (in GameTree nodes)

```typescript
interface MoveNode {
  // ... (from spec:016)
  comment: string;              // text, may contain [%eval], [%clk], [%cal], [%csl]
  nags: number[];               // NAG codes
  arrows: ArrowAnnotation[];    // parsed from [%cal]
  squares: SquareAnnotation[];  // parsed from [%csl]
  eval?: { cp?: number; mate?: number; depth: number };
}
```

### NAG Reference
| Code | Symbol | Meaning |
|------|--------|---------|
| $1 | ! | Good move |
| $2 | ? | Mistake |
| $3 | !! | Brilliant |
| $4 | ?? | Blunder |
| $5 | !? | Interesting |
| $6 | ?! | Dubious |
| $10 | = | Equal |
| $14/$15 | +=, =+ | Slight advantage |
| $16/$17 | +/-, -/+ | Clear advantage |
| $18/$19 | +-, -+ | Decisive advantage |

### PGN Format
```pgn
1. e4 {[%eval 0.25]} e5 2. Nf3 $1 {A natural developing move.} Nc6
3. Bb5 {The Ruy Lopez. [%cal Gb5c6,Gb5a4]} a6 $5 {[%csl Ra6]}
```

### Chessground Integration
Arrow/square annotations map to `drawable.autoShapes`:
```typescript
const shapes = [
  ...node.arrows.map(a => ({ orig: a.orig, dest: a.dest, brush: a.brush })),
  ...node.squares.map(s => ({ orig: s.key, brush: s.brush })),
];
```

### User Interaction
- Right-click drag → draw arrows (Chessground native)
- Right-click square → highlight square
- Click move → edit comment
- Keyboard shortcuts for NAGs (e.g., Ctrl+1 for !, Ctrl+2 for ?)
- Auto-eval saved to `[%eval]` during analysis

## Eval Graph

### Approach
Canvas-based line chart (lightweight, no charting library):
- X-axis: move number (half-moves)
- Y-axis: eval in pawns, sigmoid scaling for resolution near 0
- Fill: white region above, dark below (Lichess-style)
- Current move: vertical indicator line
- Clickable: navigate to any move

### Scaling (Lichess-like sigmoid)
```typescript
function evalToY(cp: number): number {
  return 2 / (1 + Math.exp(-0.004 * cp)) - 1; // range [-1, 1]
}
```

### Blunder Detection
Red dots where eval drops significantly:
- Inaccuracy: 0.5-1.0 pawn drop
- Mistake: 1.0-3.0 pawn drop
- Blunder: >3.0 pawn drop

## Done When

> Status 2026-07-13: annotation UI + eval graph implemented (`lib/annotations.ts`,
> `components/annotation-bar.tsx`, `components/eval-graph.tsx`). Data layer
> (per-node `eval`, serialization back-compat, NAG/comment/[%eval] helpers) is
> unit-tested; the UI type-checks and builds but has NOT yet been verified in
> the running app. Circles are stored as dest-less entries in `arrows` (one
> field for both [%cal] and [%csl] shapes) rather than a separate `squares`
> array.

### Annotations (from spec:202)
- [x] Engine eval auto-saved per move during analysis (stored in `node.eval`,
      white-perspective; writing it out as `[%eval]` belongs to PGN export, spec:013)
- [x] User can add/edit text comments on any move (annotation bar; `[%…]` tags preserved through edits) — not yet verified in-app
- [x] NAG symbols (!, ?, !!, ??, !?, ?!) via keyboard (`!`/`?` combos, `=` for equality) and toolbar buttons — not yet verified in-app
- [x] Annotations visible in move list (comment text + NAG glyphs; per-move eval badges deferred — evals live in the graph tooltip)
- [x] Arrow annotations drawn on board (right-click drag), persisted per node — not yet verified in-app
- [x] Square annotations highlighted on board (right-click), persisted as dest-less arrows — not yet verified in-app
- [x] Annotated PGN export includes comments, evals, NAGs, arrows, squares (spec:013 task) — shipped and ticked in spec:013:29 (`treeToPgn`/`makePgn`, round-trip tested in `__tests__/pgn.test.ts`); cross-verified 2026-07-15
- [x] PGN import preserves all annotation types (spec:013 task) — shipped and ticked in spec:013:19 (`parsePgnToTrees`, full-tree comments/NAGs/[%eval]/[%clk]/[%cal]/[%csl]); cross-verified 2026-07-15
- [x] Annotations persist in database (spec:200) — they do persist in the localStorage save today (code-verified 2026-07-16: `db_save_game` (`src-tauri/src/db.rs`) parses the exported PGN with the import visitor and upserts on `dup_hash`; Rust unit test round-trips annotations through save → get; Save button in `app/page.tsx` (`data-testid="save-to-db"`) exports the annotated tree via `exportPgn()`)

### Eval Graph (from spec:203)
- [x] Eval graph displayed below move list (analyze mode only)
- [x] Graph renders from stored evals in the game tree (`node.eval`, with `[%eval]` comment tags as fallback)
- [x] Graph updates in real-time as engine analyzes (evals stream into the current node, gated on the engine's `analysisFen`) — not yet verified in-app
- [x] Clicking a point navigates to that move
- [x] Current move shown with vertical indicator (variations mark their mainline branch point)
- [x] White/dark fill regions show advantage (Lichess-style sigmoid scaling)
- [x] Mate scores at full extent (clamped to ±1, unit-tested)
- [ ] Blunders/mistakes visually highlighted (stretch goal — deferred)

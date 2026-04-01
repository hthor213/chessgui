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

### Annotations (from spec:202)
- [ ] Engine eval auto-saved per move as `[%eval]` during analysis
- [ ] User can add/edit text comments on any move
- [ ] NAG symbols (!, ?, !!, ??) via keyboard
- [ ] Annotations visible in move list (eval badges, comment text, NAG glyphs)
- [ ] Arrow annotations drawn on board (right-click drag)
- [ ] Square annotations highlighted on board (right-click)
- [ ] Annotated PGN export includes comments, evals, NAGs, arrows, squares
- [ ] PGN import preserves all annotation types
- [ ] Annotations persist in database (spec:200)

### Eval Graph (from spec:203)
- [ ] Eval graph displayed below move list
- [ ] Graph renders from stored `[%eval]` in game tree
- [ ] Graph updates in real-time as engine analyzes
- [ ] Clicking a point navigates to that move
- [ ] Current move shown with vertical indicator
- [ ] White/dark fill regions show advantage (Lichess-style)
- [ ] Mate scores at full extent
- [ ] Blunders/mistakes visually highlighted (stretch goal)

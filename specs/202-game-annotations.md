# 202: Game Annotations

**Status:** draft
**Depends on:** 016 (game tree — annotations are stored per-node in the tree)

## Goal
Store engine evaluations and manual text comments per move, persisted in the game database and exportable as annotated PGN.

## Architecture (informed by ChessX)

ChessX stores annotations in three parallel maps keyed by MoveId:
- `m_annotations: Map<MoveId, string>` — text comments (before + after move)
- `m_nags: Map<MoveId, NagSet>` — numeric annotation glyphs
- `m_variationStartAnnotations: Map<MoveId, string>` — comments before a variation starts

They also support **structured annotations** embedded in comments:
- `[%eval 1.25]` — engine evaluation
- `[%clk 0:45:30]` — clock time
- `[%cal Ge2e4,Rd7d5]` — colored arrows (Green e2→e4, Red d7→d5)
- `[%csl Ge4,Rd5]` — colored squares

This is the **PGN standard for annotations** — we should follow it for interoperability with Lichess studies, ChessBase, and other tools.

### Data Model (in GameTree nodes, spec:016)

```typescript
interface MoveNode {
  // ... (from spec:016)
  comment: string;              // text comment (may contain [%eval], [%clk], etc.)
  nags: number[];               // NAG codes: $1=!, $2=?, $3=!!, $4=??, $5=!?, $6=?!, etc.
  arrows: ArrowAnnotation[];    // parsed from [%cal ...] for Chessground drawable
  squares: SquareAnnotation[];  // parsed from [%csl ...] for Chessground drawable
  eval?: { cp?: number; mate?: number; depth: number };  // parsed from [%eval ...]
}

interface ArrowAnnotation {
  orig: Key;     // e.g., "e2"
  dest: Key;     // e.g., "e4"
  brush: string; // "green", "red", "blue", "yellow"
}

interface SquareAnnotation {
  key: Key;
  brush: string;
}
```

### NAG Reference

Standard NAG codes we should support:
| Code | Symbol | Meaning |
|------|--------|---------|
| $1 | ! | Good move |
| $2 | ? | Mistake |
| $3 | !! | Brilliant |
| $4 | ?? | Blunder |
| $5 | !? | Interesting |
| $6 | ?! | Dubious |
| $10 | = | Equal position |
| $14 | += | Slight white advantage |
| $15 | =+ | Slight black advantage |
| $16 | +/- | White advantage |
| $17 | -/+ | Black advantage |
| $18 | +- | Decisive white advantage |
| $19 | -+ | Decisive black advantage |

### PGN Export Format

```pgn
1. e4 {[%eval 0.25]} e5 2. Nf3 $1 {A natural developing move.} Nc6
3. Bb5 {The Ruy Lopez. [%cal Gb5c6,Gb5a4]} a6 $5 {[%csl Ra6]}
```

### Chessground Integration

Arrow and square annotations map directly to Chessground's `drawable.autoShapes`:
```typescript
const shapes = [
  ...node.arrows.map(a => ({ orig: a.orig, dest: a.dest, brush: a.brush })),
  ...node.squares.map(s => ({ orig: s.key, brush: s.brush })),
];
// Pass to Chessground config: drawable: { autoShapes: shapes }
```

### User Interaction

- **Right-click drag** on board → draw arrows (Lichess behavior, Chessground supports this natively)
- **Right-click square** → highlight square
- **Comment editing** → click move in move list, type in comment input
- **NAG insertion** → keyboard shortcuts or toolbar buttons (e.g., Ctrl+1 for !, Ctrl+2 for ?)
- **Auto-eval** → engine eval saved to `[%eval]` when analysis is running

## Done When
- [ ] Engine eval auto-saved per move as `[%eval]` during analysis
- [ ] User can add/edit text comments on any move
- [ ] NAG symbols (!, ?, !!, ??) can be added to moves via keyboard
- [ ] Annotations visible in the move list (eval badges, comment text, NAG glyphs)
- [ ] Arrow annotations drawn on board (right-click drag)
- [ ] Square annotations highlighted on board (right-click)
- [ ] Annotated PGN export includes comments, evals, NAGs, arrows, squares
- [ ] PGN import preserves all annotation types
- [ ] Annotations persist in database (spec:200)

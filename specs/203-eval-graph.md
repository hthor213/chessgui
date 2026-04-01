# 203: Eval Graph

**Status:** draft
**Depends on:** 016 (game tree), 202 (annotations — eval stored as `[%eval]` per node)

## Goal
Display a line chart of engine evaluation over the course of a game, showing where advantages shifted. Click any point to jump to that position.

## Data Source

Evals come from two sources (in priority order):
1. **Stored annotations** — `[%eval 1.25]` in the game tree (spec:202). Pre-analyzed games or auto-saved during analysis.
2. **Live analysis** — current engine output for the active position. Can be used to fill gaps.

The graph reads the mainline of the GameTree (spec:016) and collects `node.eval` for each node.

## Approach
- Render as a **canvas-based line chart** (no heavy charting library — keep it lightweight)
- X-axis: move number (half-moves, displayed as "1. ... 2. ... 3. ...")
- Y-axis: eval in pawns, clamped to ±10, with non-linear scaling near 0 for better resolution
- Fill: white region above the line, dark region below (like Lichess)
- Current move highlighted with a vertical indicator line
- Clickable: click any point to navigate to that move in the game tree

### Scaling

Lichess uses a **sigmoid-like** scaling for the Y-axis to make small advantages visible while capping extreme evaluations:

```typescript
function evalToY(cp: number): number {
  // Winning probability mapping (like Lichess)
  return 2 / (1 + Math.exp(-0.004 * cp)) - 1; // range [-1, 1]
}
```

Mate scores are clamped to ±1.0 (full extent).

### Blunder Detection

Moves where eval drops significantly (e.g., >1.0 pawn swing) can be highlighted with red dots on the graph. This gives an immediate visual indicator of where the game went wrong.

```
Threshold suggestions:
- Inaccuracy: 0.5-1.0 pawn drop
- Mistake: 1.0-3.0 pawn drop
- Blunder: >3.0 pawn drop
```

## Done When
- [ ] Eval graph displayed below the move list
- [ ] Graph renders from stored `[%eval]` annotations in the game tree
- [ ] Graph updates in real-time as engine analyzes each position
- [ ] Clicking a point on the graph navigates to that move
- [ ] Current move position shown with a vertical indicator
- [ ] White/dark fill regions show advantage (like Lichess)
- [ ] Mate scores shown at full extent
- [ ] Blunders/mistakes visually highlighted (optional, stretch goal)

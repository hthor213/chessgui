# 203: Eval Graph

**Status:** draft

## Goal
Display a line chart of engine evaluation over the course of a game, showing where advantages shifted. Click any point to jump to that position.

## Approach
- Collect eval per move (from live analysis or stored annotations)
- Render as a line chart (lightweight charting lib or canvas)
- X-axis: move number, Y-axis: eval in pawns (clamped ±10)
- Color regions: green above 0 (white advantage), red below
- Clickable: click a point to navigate to that move

## Done When
- [ ] Eval graph displayed below or beside the move list
- [ ] Graph updates as engine analyzes each position
- [ ] Clicking a point on the graph navigates to that move
- [ ] Graph shows clear advantage shifts (color-coded)

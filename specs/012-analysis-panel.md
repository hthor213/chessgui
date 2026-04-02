# 012: Analysis Panel

**Status:** draft

## Goal
Display real-time engine analysis alongside the board.

## Inputs
- Streaming UCI output from spec:011
- Current board position from Chessground/chessops

## Outputs
- Eval bar (vertical, beside the board) showing advantage
- Top N engine lines with move sequences (clickable to preview)
- Depth, nodes/sec, time display
- Toggle analysis on/off

## Done When
- [ ] Eval bar updates in real-time as engine analyzes
- [ ] MultiPV lines displayed (configurable 1-5)
- [ ] Clicking a line previews it on the board
- [ ] Analysis auto-starts when position changes

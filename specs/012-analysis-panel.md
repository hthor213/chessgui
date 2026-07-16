# 012: Analysis Panel

**Status:** superseded (2026-07-16, requirements audit / librarian pass) — merged into 011-engine-analysis.md's "Analysis Panel (from spec:012)" section, where all four items below are also tracked and already shipped. Kept on disk for history, not further edited.

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
- [x] Eval bar updates in real-time as engine analyzes (code-verified 2026-07-15)
- [x] MultiPV lines displayed (configurable 1-5) (code-verified 2026-07-15)
- [x] Clicking a line previews it on the board (code-verified 2026-07-15)
- [x] Analysis auto-starts when position changes (code-verified 2026-07-15)

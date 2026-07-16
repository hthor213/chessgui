# 010: Undo/Redo (Takeback)

**Status:** active

## Goal
Navigate backward and forward through the move history, both by clicking the move list and via keyboard shortcuts.

## Approach
- `useChessGame` already tracks `positions[]` and `currentMoveIndex` — undo/redo just changes the index
- Arrow keys (left/right) step through moves, Cmd+Z / Cmd+Shift+Z also work
- Board updates to show the position at that index
- Playing a new move from a non-terminal position truncates the future

## Done When
- [x] Left arrow / Cmd+Z goes back one move (code-verified 2026-07-15)
- [x] Right arrow / Cmd+Shift+Z goes forward one move (code-verified 2026-07-15)
- [x] Home goes to starting position, End goes to latest (code-verified 2026-07-15)
- [x] Board and move list highlight stay in sync (code-verified 2026-07-15)
- [ ] Playing a move from a past position truncates future moves — superseded by spec 016 (new moves become variations)

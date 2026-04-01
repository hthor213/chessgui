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
- [ ] Left arrow / Cmd+Z goes back one move
- [ ] Right arrow / Cmd+Shift+Z goes forward one move
- [ ] Home goes to starting position, End goes to latest
- [ ] Board and move list highlight stay in sync
- [ ] Playing a move from a past position truncates future moves

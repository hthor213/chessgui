# 010: Undo/Redo (Takeback)

**Status:** done — closed into spec:016 (2026-07-16, requirements audit / librarian pass). All "Done When" items shipped (mirrored in 001-board-gameplay.md's "Navigation (from spec:010)" section); the one open item below was superseded by the variation-tree model, not abandoned. No further edits planned here — spec:016 (Game Tree) is now the owning spec for move-history navigation.

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

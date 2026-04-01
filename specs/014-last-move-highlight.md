# 014: Last Move Highlighting

**Status:** active

## Goal
Highlight the from/to squares of the last move played, matching Lichess's yellow-green highlight. Currently `lastMove` always returns `undefined` in `useChessGame.ts`.

## Approach
- Track `lastMove: [Key, Key]` in game state alongside each position
- Store it in the positions/moves history so navigation preserves it
- Pass to Chessground's `lastMove` config

## Done When
- [ ] Last move squares highlighted after playing a move
- [ ] Highlight updates correctly when navigating with arrow keys
- [ ] No highlight shown at the initial position

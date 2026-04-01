# 015: Promotion Dialog

**Status:** active

## Goal
Show a piece picker when a pawn reaches the last rank instead of auto-promoting to queen. Underpromotion to knight is critical in ~5% of endgame positions.

## Approach
- Detect promotion move in `onMove` before committing
- Show a small overlay near the promotion square with Q/R/B/N choices
- Commit the move only after selection
- Chessground has promotion support — may be able to hook into its API

## Done When
- [ ] Pawn reaching last rank shows a 4-piece picker overlay
- [ ] Selecting a piece commits the move with correct promotion
- [ ] Clicking away or pressing Escape cancels the move
- [ ] Works for both white and black promotions

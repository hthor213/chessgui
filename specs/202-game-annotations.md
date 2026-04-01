# 202: Game Annotations

**Status:** draft

## Goal
Store engine evaluations and manual text comments per move, persisted in the game database and exportable as annotated PGN.

## Approach
- Each move in a game can have: engine eval (cp/mate + depth), text comment, NAG symbols (!, ?, !!, etc.)
- Store in database alongside game moves
- Display inline in move list (eval badges, comment text below moves)
- Export as standard PGN with {comments} and $NAG annotations

## Done When
- [ ] Engine eval auto-saved per move during analysis
- [ ] User can add/edit text comments on any move
- [ ] NAG symbols (!, ?, !!, ??) can be added to moves
- [ ] Annotations visible in the move list
- [ ] Annotated PGN export includes comments and evals

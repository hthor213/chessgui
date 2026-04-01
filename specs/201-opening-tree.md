# 201: Opening Tree Explorer

**Status:** draft

## Goal
Show move frequency and win/draw/loss statistics from the game database for the current position. SCID's killer feature.

## Approach
- Query database for all games passing through the current position
- Display candidate moves with: count, white win %, draw %, black win %
- Horizontal bar chart per move (like SCID/Lichess opening explorer)
- Click a move to play it on the board
- Option to query Lichess opening explorer API as fallback

## Done When
- [ ] Panel shows all moves played from current position in the database
- [ ] Each move shows game count and result percentages
- [ ] Clicking a move plays it on the board
- [ ] Updates as user navigates through moves
- [ ] Lichess API fallback when local database is empty

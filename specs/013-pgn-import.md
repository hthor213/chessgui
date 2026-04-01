# 013: PGN Import

**Status:** active

## Goal
Let users paste or open a PGN file to load games for analysis. This is the foundational feature that makes the app actually useful — without it, users can't bring their own games.

## Approach
- chessops already has a PGN parser (`chessops/pgn`)
- Two entry points: paste (Ctrl+V or modal) and file open (Ctrl+O or menu)
- Parse PGN → populate `useChessGame` with moves, positions, and headers
- Support multi-game PGN files (show a game picker)
- Display game headers (players, event, date, result) in UI

## Done When
- [ ] User can paste a PGN string and it loads into the board + move list
- [ ] User can open a .pgn file via dialog and load it
- [ ] Game headers (White, Black, Event, Result) displayed
- [ ] Multi-game PGN shows a selector to pick which game
- [ ] Engine auto-analyzes the loaded position
- [ ] Ctrl+V shortcut triggers PGN paste dialog

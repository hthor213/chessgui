# 013: PGN Import/Export

**Status:** active (import mostly done, export pending)
**Depends on:** 016 (game tree — for export with variations)

## Goal
Full PGN support: import games via paste or file, export games with annotations and variations.

## What's Built
- PGN paste via modal dialog
- Multi-game PGN shows selector
- Game headers displayed (White, Black, Event, Result)
- chessops PGN parser integration

## Done When

### Import (from spec:013)
- [x] User can paste a PGN string and it loads into the board + move list
- [ ] User can open a .pgn file via dialog and load it
- [x] Game headers (White, Black, Event, Result) displayed
- [x] Multi-game PGN shows a selector to pick which game
- [ ] Engine auto-analyzes the loaded position
- [ ] Cmd+V shortcut triggers PGN paste dialog

### Export (new scope, requires spec:016)
- [ ] Export current game as PGN file
- [ ] Export includes variations (from game tree)
- [ ] Export includes annotations (comments, NAGs, eval)
- [ ] Copy PGN to clipboard

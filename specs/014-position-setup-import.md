# 014: Position Setup & First-Class Import

**Status:** active
**Band:** FOUNDATION
**Depends on:** 001 (board & gameplay), 013 (PGN import/export)
**Unblocks:** 011 (analyze arbitrary positions), 200 (database), 202

## Why

Today the only way to get a game into the app is a hidden Cmd+V paste dialog,
and there is no way at all to set up an arbitrary position. Both are table
stakes for a ChessBase replacement (vision 000: "Position setup / play from
FEN or any position in the tree"; backlog 900: "FEN input / position editor").

A latent bug makes this urgent: PGNs carrying a `[FEN]`/`[SetUp]` header
(puzzles, game fragments) silently load from the standard start position
because `loadGame` hardcodes `INITIAL_FEN`.

## What

### A. Foundation: arbitrary start positions
- [ ] `use-chess-game`: `loadGame(sanMoves, headers?, startFen?)` replays from
      `startFen` (default: standard start)
- [ ] `use-chess-game`: `loadFen(fen)` — reset game to an arbitrary position
- [ ] Persisted localStorage game shape carries `startFen` (with migration)
- [ ] PGN import respects `[FEN]`/`[SetUp]` headers (bug fix)

### B. Position editor
- [ ] `lib/fen.ts` — FEN validation with human-readable errors (kings, pawns
      on back ranks, side-not-to-move in check, castling-rights sanity)
- [ ] `Board` supports edit mode: free piece dragging (`movable.free`) and a
      square-select callback
- [ ] Setup dialog: mini board + piece palette (12 pieces + eraser), click or
      drag to place/move/remove
- [ ] Controls: side to move, castling rights (auto-disabled when king/rook
      not on home squares), Start position / Clear board
- [ ] Two-way-synced FEN text field with live validation
- [ ] Confirm loads the position into the game (analysis works on it)
- [ ] En passant square: deferred to a later pass (always `-` in v1)

### C. Visible import UI
- [ ] "Import" and "Set up position" buttons in the board control bar
- [ ] Import dialog accepts pasted PGN **or** FEN (auto-detected)
- [ ] "Open file…" loads a `.pgn` file (HTML file input; works in Tauri webview)
- [ ] Multi-game picker retained; Cmd+V shortcut retained

## Non-goals (v1)
- En passant / move-counter editing in the setup dialog
- Editing positions mid-game (edit always starts a fresh game)
- Chess960 castling encoding

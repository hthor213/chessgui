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
- [x] `use-chess-game`: `loadGame(sanMoves, headers?, startFen?)` replays from
      `startFen` (default: standard start) (verified in code 2026-07-15, `hooks/use-chess-game.ts:295-303`, `GameTree.fromMoves(sanMoves, startFen || INITIAL_FEN, headers)`)
- [x] `use-chess-game`: `loadFen(fen)` — reset game to an arbitrary position (verified in code 2026-07-15, `hooks/use-chess-game.ts:321-331`)
- [x] Persisted localStorage game shape carries `startFen` (with migration) (verified in code 2026-07-15, `SerializedTree.startFen` `lib/game-tree.ts:59`, migration for legacy saves in `loadSavedTree()` `hooks/use-chess-game.ts:36-58`)
- [x] PGN import respects `[FEN]`/`[SetUp]` headers (bug fix) (verified in code 2026-07-15, `buildTreeFromGame` uses chessops `startingPosition(game.headers)` `lib/pgn.ts:101-132`; import path loads via `onLoadTree`)

### B. Position editor
- [x] `lib/fen.ts` — FEN validation with human-readable errors (kings, pawns
      on back ranks, side-not-to-move in check, castling-rights sanity) (verified in code 2026-07-15, `lib/fen.ts:16-43`)
- [x] `Board` supports edit mode: free piece dragging (`movable.free`) and a
      square-select callback (verified in code 2026-07-15, `components/board.tsx:104-107` `movable.free=freeMove`, `:126` `events.select`)
- [x] Setup dialog: mini board + piece palette (12 pieces + eraser), click or
      drag to place/move/remove (verified in code 2026-07-15, `components/position-editor-dialog.tsx:41,220-235` palette, `:246-250` eraser, `:107-134` click/drag handlers)
- [x] Controls: side to move, castling rights (auto-disabled when king/rook
      not on home squares), Start position / Clear board (verified in code 2026-07-15, `position-editor-dialog.tsx:255-271` side, `computeCastlingOptions` `lib/fen.ts:80-91` wired `:160,291`, `:301-315` start/clear)
- [x] Two-way-synced FEN text field with live validation (verified in code 2026-07-15, `position-editor-dialog.tsx:74-89` board→text, `:136-158` text→board, `:335` live `fenError`)
- [x] Confirm loads the position into the game (analysis works on it) (verified in code 2026-07-15, Confirm → `onSetPosition(boardFen)` `position-editor-dialog.tsx:344-353`, wired `onSetPosition={game.loadFen}` `app/page.tsx:949`)
- [x] En passant square: deferred to a later pass (always `-` in v1) (verified in code 2026-07-15, `pieceMapToFen` always writes `-` for the ep field `lib/fen.ts:63-76`; no UI control sets it)

### C. Visible import UI
- [x] "Import" and "Set up position" buttons in the board control bar (verified in code 2026-07-15, `app/page.tsx:870-873` Import, `:884-885` Set up position)
- [x] Import dialog accepts pasted PGN **or** FEN (auto-detected) (verified in code 2026-07-15, `components/pgn-import-dialog.tsx:77-87` — single-line valid FEN → position, else `parsePgnToTrees`)
- [x] "Open file…" loads a `.pgn` file (HTML file input; works in Tauri webview) (verified in code 2026-07-15, `pgn-import-dialog.tsx:190-204` button + hidden `<input type="file" accept=".pgn,.txt">`)
- [x] Multi-game picker retained; Cmd+V shortcut retained (verified in code 2026-07-15, multi-game picker `pgn-import-dialog.tsx:144-175`, Cmd+V `app/page.tsx:358-369`)

## Non-goals (v1)
- En passant / move-counter editing in the setup dialog
- Editing positions mid-game (edit always starts a fresh game)
- Chess960 castling encoding

## Later / uncaptured requirements (audit 2026-07-16)

- [ ] Position editor v2: en passant/counters, edit-from-game, Chess960 encoding. (014:39)

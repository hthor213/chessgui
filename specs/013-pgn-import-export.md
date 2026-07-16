# 013: PGN Import/Export

**Status:** implemented — full round-trip (import+export with variations/annotations); native Tauri file dialog deferred
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
- [x] Import preserves variations, comments, NAGs, and [%eval]/[%clk]/[%cal]/[%csl] tags (full tree, not just mainline)
- [x] User can open a .pgn file (webview file picker "Open file…" + drag-and-drop a .pgn onto the window). Native Tauri open dialog deferred — the webview picker works in the app and browser.
- [x] Game headers (White, Black, Event, Result) displayed
- [x] Multi-game PGN shows a selector to pick which game
- [ ] Engine auto-analyzes the loaded position — not explicitly wired; the existing analysis-mode effect re-analyzes on the landed position when the engine is running. Left unchecked pending verification.
- [x] Cmd+V shortcut triggers PGN paste dialog (now pre-filled from clipboard text; image paste still routes to vision/thinking mode)

### Export (new scope, requires spec:016)
- [x] Export current game as PGN file (webview download; native Tauri save dialog deferred with graceful browser fallback)
- [x] Export includes variations (from game tree)
- [x] Export includes annotations (comments, NAGs, [%eval], [%cal]/[%csl] arrows)
- [x] Copy PGN to clipboard

## Later / uncaptured requirements (audit 2026-07-16)

- [ ] Edit players/event/date/result/ECO headers in-app. (000:55)
- [ ] Register plugin-dialog/fs; replace webview fallbacks with native Tauri open/save dialogs. (013:35 "Deferred")

## Implementation notes
- `lib/pgn.ts` (pure, unit-tested): `parsePgnToTrees` and `treeToPgn`, built on chessops/pgn (`parsePgn`/`makePgn`/`parseComment`/`makeComment`). Round-trip acceptance tests in `__tests__/pgn.test.ts` (import→export→import identity across nested variations, comments/NAGs, eval/clk/cal/csl tags, escaped headers, custom-FEN starts, multi-game).
- Node storage extended: `MoveNode.eval` ([%eval]) and `MoveNode.clock` ([%clk]); arrows carry [%cal]/[%csl] as `{orig,dest,brush}`. Arrow order is canonicalized (circles before arrows) on import to stay round-trip stable.
- Deferred: native Tauri open/save dialogs (tauri-plugin-dialog/fs not registered). Webview file input + drag-drop cover open; Blob download covers save.

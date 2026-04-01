# Current Tasks

## Sprint: Core Playability

### spec:010 — Undo/Redo
- [ ] Add keyboard listener for Left/Right/Home/End and Cmd+Z/Cmd+Shift+Z
- [ ] Wire arrow keys to `goToMove` in useChessGame
- [ ] Keep move list highlight and board position in sync
- [ ] Verify truncation works when playing from a past position

### spec:011 — Wire Up Stockfish
- [ ] Add file picker button to AnalysisPanel for selecting engine binary
- [ ] Call `start_engine` Tauri command on selection
- [ ] Listen to `engine-output` events and parse UCI `info` lines
- [ ] Build UCI info parser (eval cp/mate, depth, PV, nodes, nps, multipv)
- [ ] Send `position fen` + `go infinite` on each position change
- [ ] Stop analysis before sending new position
- [ ] Display eval score, depth, nps in AnalysisPanel
- [ ] Display top 3 PV lines in SAN notation
- [ ] Add start/stop toggle for analysis
- [ ] Persist engine path so it survives app restart
- [ ] Clean up engine process on window close

## Done
- [x] Scaffold Tauri 2 + React + Chessground project
- [x] Get a basic board rendering with legal moves
- [x] Rust UCI engine backend (start/stop/send commands)

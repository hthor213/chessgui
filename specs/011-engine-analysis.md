# 011: Engine Analysis

**Status:** active (partially done)
**Depends on:** 001 (board & gameplay)

## Goal
Full Stockfish integration: UCI engine communication, real-time analysis display, play-vs-engine mode, best-move arrows, and engine settings. Everything engine-related in one spec.

## What's Built
- Rust UCI pipe works (stdin flush fix + emit_to fix applied)
- Engine starts, handshake completes
- Analysis mode: `go infinite`, MultiPV 3, eval + PV lines displayed
- Play mode: user plays white, engine plays black via `bestmove`
- UCI info parser extracts eval, depth, PV, nodes, nps
- EvalBar component shows advantage

## Known Bug
- `playUciMove` castling crash: Stockfish sends `e1g1`, chessops expects `e1h1` — fix tracked in spec:002 (migration)

## Engine Communication (Rust)

Tauri commands: `start_engine(path)`, `send_command(cmd)`, `stop_engine()`
Events: `engine-output` emitted per UCI line to frontend
Stockfish binary: user-selected via file picker (currently hardcoded for dev)

## Analysis Mode
- `go infinite` with MultiPV 3
- On position change: `stop` → `position fen ...` → `go infinite`
- Parse `info` lines: eval (cp/mate), depth, PV (converted to SAN), nodes, nps
- Both colors movable on board

## Play Mode
- Engine plays one side (black by default)
- User plays white → board locks → `position fen ... go movetime 10000`
- Parse `bestmove` → play via `playUciMove()` → unlock board
- MultiPV 1, max strength (Threads 8, Hash 512)

## Done When

### Engine Wiring (from spec:011)
- [x] User can select Stockfish binary via file dialog
- [x] Engine starts and handshake completes (name shown in UI)
- [x] Analysis runs automatically when position changes
- [x] Eval (cp and mate scores) displayed with proper +/- formatting
- [x] Top 3 PV lines shown with SAN notation
- [x] Depth and nodes/sec displayed
- [x] Stop/start analysis toggle works
- [ ] Engine process cleaned up on app quit
- [x] Play mode: user plays white, Stockfish plays black automatically
- [x] Play mode: board locked to user's color during engine's turn
- [x] Play mode: engine thinking status shown in analysis panel

### Analysis Panel (from spec:012)
- [x] Eval bar updates in real-time as engine analyzes
- [ ] MultiPV lines configurable (1-5)
- [ ] Clicking a PV line previews it on the board
- [x] Analysis auto-starts when position changes

### Best Move Arrows (from spec:100)
- [ ] Blue arrow drawn for engine's #1 best move (via Chessground `drawable.autoShapes`)
- [ ] Arrow updates in real-time as engine analyzes
- [ ] Arrow clears when analysis is paused
- [ ] Toggle via UI control

### Engine Settings (from spec:101)
- [ ] UI to configure Threads, Hash size, and MultiPV (1-5)
- [ ] Changes sent to engine via UCI `setoption`
- [ ] Settings persist across app restarts
- [ ] Changing MultiPV immediately updates the number of PV lines shown

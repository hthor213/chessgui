# 011: Wire Up Stockfish

**Status:** active

## Goal
Connect the Rust UCI backend to the frontend so the user can load Stockfish and see live analysis.

## Approach
- File picker to select Stockfish binary (or auto-detect from PATH)
- Frontend calls `start_engine` Tauri command, listens to `engine-output` events
- Parse UCI `info` lines into structured data (eval cp/mate, depth, PV, nodes, nps)
- On each position change, send `position fen ... ` + `go infinite` to engine
- `stop` when position changes, then restart analysis on new position
- Display eval, depth, and top lines in the AnalysisPanel

## Key Decisions
- Single engine for now (multi-engine is spec:902)
- Engine settings: Threads, Hash, MultiPV (3 default) exposed in a settings panel
- Engine path persisted to localStorage or Tauri store

## Play Mode (User vs Stockfish)

Two engine modes, selectable at start:

- **Analysis mode** (default) — `go infinite`, MultiPV 3, both colors movable. Engine continuously evaluates.
- **Play mode** — Engine plays one side (black by default). User makes a move, engine responds with `go movetime 10000` (configurable). Board restricted to user's color only. MultiPV 1, max strength (Threads 8, Hash 512).

Flow in play mode:
1. User clicks "Play vs Stockfish" → engine starts in play mode
2. User plays white move → board locks, engine receives `position fen ...` + `go movetime 10000`
3. Engine emits `info` lines (shown as "Thinking... depth N") then `bestmove`
4. `bestmove` is parsed and played on the board via `playUciMove()`
5. Board unlocks for user's next move

Implementation: `useEngine` accepts an `onBestMove` callback. `startEngine(path, mode)` accepts mode parameter. Engine output listener parses `bestmove` lines in play mode. Auto-analyze effect triggers `requestMove()` when FEN changes and it's the engine's turn.

## Done When
- [ ] User can select Stockfish binary via file dialog
- [ ] Engine starts and handshake completes (name shown in UI)
- [ ] Analysis runs automatically when position changes
- [ ] Eval (cp and mate scores) displayed with proper +/- formatting
- [ ] Top 3 PV lines shown with SAN notation
- [ ] Depth and nodes/sec displayed
- [ ] Stop/start analysis toggle works
- [ ] Engine process cleaned up on app quit
- [ ] Play mode: user plays white, Stockfish plays black automatically
- [ ] Play mode: board locked to user's color during engine's turn
- [ ] Play mode: engine thinking status shown in analysis panel

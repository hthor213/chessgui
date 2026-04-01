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

## Done When
- [ ] User can select Stockfish binary via file dialog
- [ ] Engine starts and handshake completes (name shown in UI)
- [ ] Analysis runs automatically when position changes
- [ ] Eval (cp and mate scores) displayed with proper +/- formatting
- [ ] Top 3 PV lines shown with SAN notation
- [ ] Depth and nodes/sec displayed
- [ ] Stop/start analysis toggle works
- [ ] Engine process cleaned up on app quit

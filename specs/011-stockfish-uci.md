# 011: Wire Up Stockfish

**Status:** superseded (2026-07-16, requirements audit / librarian pass) — by 011-engine-analysis.md, which is the actively maintained spec:011 and covers everything below plus play mode, best-move arrows, and engine settings. Kept on disk for history, not further edited.

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
- Single engine for now (multi-engine has no owning spec yet — the earlier "spec:902" pointer here was dangling, spec:902 was never written; see 011-engine-analysis.md "Later / uncaptured requirements" for the open item, fixed 2026-07-16)
- Engine settings: Threads, Hash, MultiPV (3 default) exposed in a settings panel
- Engine path persisted to localStorage or Tauri store

## Done When
- [ ] User can select Stockfish binary via file dialog
- [x] Engine starts and handshake completes (name shown in UI) (code-verified 2026-07-15)
- [x] Analysis runs automatically when position changes (code-verified 2026-07-15)
- [x] Eval (cp and mate scores) displayed with proper +/- formatting (code-verified 2026-07-15)
- [x] Top 3 PV lines shown with SAN notation (code-verified 2026-07-15)
- [x] Depth and nodes/sec displayed (code-verified 2026-07-15)
- [x] Stop/start analysis toggle works (code-verified 2026-07-15)
- [x] Engine process cleaned up on app quit (code-verified 2026-07-15)

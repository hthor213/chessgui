# 011: Stockfish UCI Integration

**Status:** draft

## Goal
Manage and communicate with Stockfish (and any UCI engine) from the Rust backend.

## Inputs
- Stockfish binary (bundled or user-provided)
- UCI protocol specification

## Outputs
- Rust module that spawns engine process, sends UCI commands, parses responses
- Tauri commands exposed to frontend: start engine, set options, go, stop, get best move
- Engine output parsed into structured data (eval, depth, PV lines, nodes/sec)

## Key Decisions
- Engine runs as a child process managed by Rust/tokio — not WASM
- Support multiple engines simultaneously (for future multi-engine analysis)
- Engine binary path configurable; optionally auto-download Stockfish

## Done When
- [ ] `uci` handshake completes and engine name/options are parsed
- [ ] `go infinite` produces streaming eval updates to the frontend
- [ ] `stop` halts analysis and returns best move
- [ ] `setoption` works for Threads, Hash, MultiPV
- [ ] Engine crash/timeout is handled gracefully

# ChessGUI — Claude Code Project Context

## What This Is
A macOS-first chess GUI built on Tauri 2 (Rust) + React + TypeScript. Uses Lichess Chessground for the board and chessops for move logic. Designed to replace ChessBase with an open-source, subscription-free alternative powered by Stockfish.

## Architecture
- **Frontend:** React 19 + TypeScript + Mantine UI + Chessground board
- **Backend:** Rust via Tauri v2 — handles UCI engine communication over stdin/stdout
- **Build:** Vite + pnpm + Cargo
- **Target:** macOS (Apple Silicon primary), cross-platform possible via Tauri

## Development Commands
```bash
# Dev mode (hot-reload frontend + Rust backend)
source "$HOME/.cargo/env" && pnpm tauri dev

# Build debug .app + .dmg
source "$HOME/.cargo/env" && pnpm tauri build --debug

# Build release
source "$HOME/.cargo/env" && pnpm tauri build

# Frontend only (no Tauri shell)
pnpm dev

# Type check
pnpm tsc --noEmit
```

## Project Structure
```
src/                    # React frontend
  components/
    Board.tsx           # Chessground wrapper
    MoveList.tsx        # Algebraic notation move list
    AnalysisPanel.tsx   # Engine eval display (placeholder)
  hooks/
    useChessGame.ts     # Game state, legal moves via chessops
  main.tsx              # Entry point + Mantine provider
  App.tsx               # Layout shell
src-tauri/              # Rust backend
  src/
    lib.rs              # Tauri plugin setup + command registration
    main.rs             # Entry point
    uci.rs              # UCI engine process management
  tauri.conf.json       # App config, window, bundle settings
  Cargo.toml            # Rust dependencies
specs/                  # Feature specs (vision + MVP)
scripts/                # Utility scripts
```

## Key Dependencies
- `@lichess-org/chessground` — Board rendering (GPL-3.0)
- `chessops` — Move generation, FEN/PGN, validation
- `@mantine/core` — UI component library
- `tauri` + `tauri-plugin-shell` — Desktop shell + engine process management
- `tokio` — Async runtime for engine I/O in Rust

## Spec System
Uses band-numbered specs in `specs/`. See `specs/README.md` for the system.
Active specs: 000 (vision), 001 (setup), 010-012 (MVP features).

## License
GPL-3.0 (required by Chessground dependency)

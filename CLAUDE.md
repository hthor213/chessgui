# ChessGUI — Claude Code Project Context

## What This Is
A macOS-first chess GUI built on Tauri 2 (Rust) + React + TypeScript. Uses Lichess Chessground for the board and chessops for move logic. Designed to replace ChessBase with an open-source, subscription-free alternative powered by Stockfish.

## Architecture
This is a pnpm workspace monorepo (spec:220, "multiclient architecture" —
extracted the desktop app's chess logic and UI into shared packages so a
second shell, the web client, could reuse them instead of forking the code).
- **Shared logic:** `packages/core` — pure TypeScript (chess/tournament math,
  PGN, game tree, platform adapter interfaces). Zero React, zero platform SDKs.
- **Shared UI:** `packages/ui` — React components (board, panels, tabs) +
  the single-source Chessground/shadcn/Tailwind theme assets. GPL-3.0
  propagates from Chessground to every shell that imports this package.
- **Desktop shell:** `apps/desktop` — Next.js (static export) + Tauri v2
  (Rust) — the primary macOS-first target.
- **Web shell:** `apps/web` — Next.js, browser-only (no Tauri), Stockfish
  via `lila-stockfish-web` instead of a native UCI process.
- **Backend (desktop):** Rust via Tauri v2 in `apps/desktop/src-tauri` —
  handles UCI engine communication over stdin/stdout, plus the SQLite
  database, calibration, persona, and match-runner commands.
- **Servers:** `server/arena` (Python, engine-vs-engine/persona hosting) and
  `server/web` (nginx/Docker for the web client) — see spec:220, spec:221.
- **Build:** Next.js + pnpm + Cargo
- **Target:** macOS (Apple Silicon primary) via the desktop shell; browser
  cross-platform via the web shell.

## Development Commands
All commands run from the repo root (pnpm workspace root scripts fan out to
the relevant app via `-C`).
```bash
# Dev mode — desktop shell, hot-reload frontend + Rust backend
source "$HOME/.cargo/env" && pnpm tauri dev

# Dev mode — web shell (browser only, no Tauri)
pnpm dev:web

# Build debug .app AND install to /Applications (keeps the Dock icon current —
# ALWAYS use this over a bare `pnpm tauri build --debug` when finishing work)
scripts/install-app.sh --debug

# Build release + install to /Applications
scripts/install-app.sh

# Bare builds (no install — bundle stays in apps/desktop/src-tauri/target/*/bundle)
source "$HOME/.cargo/env" && pnpm tauri build --debug
source "$HOME/.cargo/env" && pnpm tauri build

# Frontend only, desktop shell (no Tauri shell)
pnpm dev

# Type check (desktop + web)
pnpm tsc

# Unit tests (vitest, workspace-wide)
pnpm test
```

Build gotcha: if `pnpm tauri build` fails with ``crate `X` required to be
available in rlib format`` after a rustc upgrade, the target dir has stale
artifacts — `cd apps/desktop/src-tauri && cargo clean` fixes it (costs a full
~5min rebuild). Not a Cargo.toml problem; don't change crate-type for this.

## Project Structure
```
packages/
  core/                  # @chessgui/core — shared pure-TS chess/tournament logic
    src/
      game-tree.ts        # Variation tree model (spec:016)
      pgn.ts               # PGN parse/serialize
      engine-session.ts    # Multi-engine session abstraction
      platform.ts          # Platform adapter interface (desktop vs web)
      tournament.ts, tournament-analysis.ts, win-prob.ts, elo-estimate.ts
      ...                  # fen.ts, eco.ts, material.ts, uci-parser.ts, etc.
    __tests__/             # Vitest unit tests for core logic
  ui/                    # @chessgui/ui — shared React components + theme
    src/
      board.tsx            # Chessground wrapper (dynamic import, SSR-safe)
      move-list.tsx         # Move list (shadcn Card + ScrollArea)
      analysis-panel.tsx    # Engine eval display
      tournament-tab.tsx, training-tab.tsx, database-tab.tsx, ...  # feature tabs
      arena/                # Arena/persona UI
      ui/                   # shadcn/ui generated primitives
      board-theme.css, square-state.css, tailwind-preset.ts  # single-source theme
apps/
  desktop/               # @chessgui/desktop — Tauri shell (primary target)
    app/                  # Next.js app directory
      layout.tsx           # Root layout (dark theme)
      page.tsx             # Main chess UI ("use client", three-column grid)
      arena/page.tsx        # Arena route
      globals.css           # Tailwind imports + Chessground overrides
    hooks/                # React hooks (use-chess-game.ts, use-engine.ts, ...)
    lib/                  # Desktop-only libs (engine-settings.ts, database.ts,
                           # persona.ts, calibration.ts, ...) + lib/platform/
                           # (tauri.ts platform adapter implementation)
    src-tauri/            # Rust backend
      src/
        lib.rs              # Tauri plugin setup + command registration
        main.rs             # Entry point
        uci.rs              # UCI engine process management
        match_runner.rs      # Engine tournament runner (spec:210)
        db.rs, cbh.rs         # SQLite game database (spec:200)
        persona.rs, calibration.rs, machine.rs, maia.rs  # training/persona subsystems
      tauri.conf.json       # App config, window, bundle settings
      Cargo.toml            # Rust dependencies
  web/                   # @chessgui/web — browser-only shell (spec:221)
    app/                  # Next.js app directory (PWA)
    lib/                  # Web-only libs (platform adapter using browser APIs)
    scripts/              # prepare-engine.mjs, generate-pwa-icons.mjs, check-no-tauri.mjs
server/
  arena/                 # Python persona/engine-hosting service (spec:217)
  web/                   # nginx/Docker deployment for apps/web
specs/                   # Feature specs (see specs/README.md for the index)
scripts/                 # Repo-wide utility scripts (mining, calibration, install-app.sh, ...)
```

## Key Dependencies
- `@lichess-org/chessground` — Board rendering (GPL-3.0)
- `chessops` — Move generation, FEN/PGN, validation
- `next` — React framework (static export for Tauri)
- `tailwindcss` — Utility-first CSS
- `shadcn/ui` — Composable UI components (Radix primitives)
- `tauri` + `tauri-plugin-shell` — Desktop shell + engine process management
- `tokio` — Async runtime for engine I/O in Rust

## Spec System
Uses band-numbered specs in `specs/`. See `specs/README.md` for the full index and dependency graph.

Active specs:
- 000 (vision), 001 (board & gameplay), 002 (UX/UI migration)
- 011 (engine analysis), 013 (PGN import/export), 016 (game tree)
- 200 (database & opening explorer), 202 (annotations & eval graph)
- 900 (backlog)

## License
GPL-3.0 (required by Chessground dependency)

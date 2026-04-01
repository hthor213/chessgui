# 000: ChessGUI — Vision

**Status:** active

## North Star

A beautiful, fast, open-source chess GUI for macOS that makes Stockfish (and any UCI engine) a first-class citizen. No subscriptions, no bloat — just a clean interface for serious chess analysis and play.

## Why

- ChessBase charges annual licenses for what is essentially a UI wrapper around free engines
- Existing open-source GUIs on macOS are either ugly (SCID), abandoned (Stockfish Mac), or Electron-heavy
- En-Croissant proves Tauri + React + Chessground is a viable stack, but it tries to do everything
- There's a gap for a focused, polished macOS app that does analysis exceptionally well

## Principles

1. **macOS-first** — Native feel, proper menu bar, keyboard shortcuts, dark mode, Retina
2. **Engine-centric** — Stockfish/UCI engine communication is the core, not an afterthought
3. **Fast** — Tauri + Rust backend, no Electron. Sub-second app launch.
4. **Focused** — Analysis and play against engine. Do fewer things, do them well.
5. **Open** — GPL-3.0 (compatible with Chessground and Stockfish licenses)

## Architecture

```
┌─────────────────────────────────────┐
│         React + TypeScript          │
│  ┌──────────┐  ┌─────────────────┐  │
│  │Chessground│  │  Analysis Panel │  │
│  │  (board)  │  │  (eval, lines)  │  │
│  └──────────┘  └─────────────────┘  │
│  ┌──────────┐  ┌─────────────────┐  │
│  │ Move List │  │  Engine Config  │  │
│  └──────────┘  └─────────────────┘  │
├─────────────────────────────────────┤
│           Tauri IPC Bridge          │
├─────────────────────────────────────┤
│            Rust Backend             │
│  ┌──────────┐  ┌─────────────────┐  │
│  │UCI Engine │  │  Game Database  │  │
│  │ Manager   │  │   (SQLite)     │  │
│  └──────────┘  └─────────────────┘  │
└─────────────────────────────────────┘
```

## Key Technologies

- **Board UI:** @lichess-org/chessground — DOM-based, 10KB gzipped, battle-tested on Lichess
- **Chess logic:** chessops — move generation, validation, FEN/PGN parsing
- **Desktop shell:** Tauri v2 — Rust backend, native webview, ~5MB binary
- **UI framework:** Mantine — polished React component library
- **Engine protocol:** UCI over stdin/stdout, managed from Rust via tokio processes

## MVP Scope

1. Render a Chessground board with legal move highlighting
2. Play against Stockfish with configurable strength
3. Paste a PGN and step through it with engine analysis
4. Show eval bar, best lines, and depth
5. Engine settings (threads, hash, depth)

## Non-Goals (for now)

- Online play (use Lichess for that)
- Chess variants
- Mobile/tablet support
- Cloud sync

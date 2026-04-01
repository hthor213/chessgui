# 000: ChessGUI — Vision

**Status:** active

## North Star

A beautiful, fast, open-source chess GUI for macOS that combines the analytical power of SCID, the modern stack of En-Croissant, and the polish of Lichess. No subscriptions, no bloat — Stockfish as a first-class citizen with a clean interface for serious chess analysis.

## Why

- ChessBase charges annual licenses for what is essentially a UI wrapper around free engines
- Existing open-source GUIs on macOS are either ugly (SCID), abandoned (Stockfish Mac), or Electron-heavy
- En-Croissant proves Tauri + React + Chessground is a viable stack, but it tries to do everything
- There's a gap for a focused, polished macOS app that does analysis exceptionally well

## Inspiration

Take the best of three existing chess tools and combine them:

- **En-Croissant** — Proves Tauri + React + Chessground is a viable stack. We adopt the architecture but stay focused instead of trying to do everything.
- **SCID** — Gold standard for game databases and opening trees. We want its analytical depth without the dated UI.
- **Lichess** — Best-in-class board UX, eval bar, and analysis panel. Our UI benchmark.

## Principles

1. **macOS-first** — Native feel, proper menu bar, keyboard shortcuts, dark mode, Retina
2. **Engine-centric** — Stockfish/UCI engine communication is the core, not an afterthought
3. **Fast** — Tauri + Rust backend, no Electron. Sub-second app launch.
4. **Focused** — Analysis and play against engine. Do fewer things, do them well.
5. **Open** — GPL-3.0 (compatible with Chessground and Stockfish licenses)

## Architecture

```
┌─────────────────────────────────────────────┐
│              React + TypeScript              │
│  ┌──────────┐  ┌────────┐  ┌─────────────┐  │
│  │Chessground│  │  Move  │  │  Analysis   │  │
│  │  (board)  │  │  List  │  │   Panel     │  │
│  └──────────┘  └────────┘  └─────────────┘  │
│  ┌──────────┐  ┌────────┐  ┌─────────────┐  │
│  │ Opening  │  │  Eval  │  │   Engine    │  │
│  │  Tree    │  │  Graph │  │   Config    │  │
│  └──────────┘  └────────┘  └─────────────┘  │
├─────────────────────────────────────────────┤
│          Game Tree (spec:016)                │
│  Tree-structured game model with cursor,    │
│  variations, per-node annotations/NAGs.     │
│  All UI components consume this model.      │
├─────────────────────────────────────────────┤
│           Tauri IPC Bridge                  │
├─────────────────────────────────────────────┤
│            Rust Backend                     │
│  ┌──────────┐  ┌─────────────────────────┐  │
│  │UCI Engine │  │  Game Database (SQLite) │  │
│  │ Manager   │  │  + PGN I/O + Opening   │  │
│  └──────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### Key Architectural Insight (from ChessX analysis)

The **Game Tree** layer is the central data model. Every UI component (move list, board, analysis panel, opening tree, annotations, eval graph) reads from or writes to this tree. ChessX's 20 years of development proved this: their `GameCursor` (tree + cursor) is the backbone everything else plugs into. Our flat `moves[]` array must be replaced with a proper tree before building database, annotations, or opening explorer (see spec:016).

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

## Competitive Landscape (studied April 2026)

| App | Stack | Strengths | Weaknesses |
|-----|-------|-----------|------------|
| **ChessX** | C++/Qt5, 85K LOC | Full DB (PGN/SCID/CTG), opening tree, annotations, UCI+WinBoard | Aging Qt5, monolithic, no web ecosystem |
| **En-Croissant** | Tauri+React | Same stack as us, broad features | Tries to do everything, unfocused |
| **SCID** | C++/Tk | Best opening tree, fast DB | Ugly UI, hard to build/maintain |
| **Lichess** | Scala/JS | Best UX, best board (Chessground) | Web only, no local DB |

We take the modern stack (En-Croissant), the analytical depth (SCID/ChessX), and the UX polish (Lichess). Stay focused — analysis and database, not everything.

## Non-Goals (for now)

- Online play (use Lichess for that)
- Chess variants
- Mobile/tablet support
- Cloud sync

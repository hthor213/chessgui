

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

## Philosophy

Think of this as a **modern ChessBase with most of the features, twice the polish, and much simpler**. ChessBase has 20 ways to do the same thing. ChessBase has become a bloat, outdated UX, and a complicated UX that accreted over decades. We aim for 80% of the total feature surface but 99% of what serious players actually use day-to-day. Every feature earns its place; nothing ships just because a competitor has it.

## Feature Map

The app is organized around **nine core modules**. Together they cover the workflows that matter: prepare, analyze, study, compete — and improve. (Modules 8–9 were added 2026-07-14 after forum/coach/GM research, `docs/research/chessbase-usage-research.md`: the improver consensus is that tactics volume and disciplined own-game review carry a player from ~1200 to ~1900, while deep database/explorer work pays off only from ~1800–1900 up. Rejected as modules for the same reason: opponent-prep dossiers (2200+ workflow), repertoire spaced-repetition, endgame-tablebase browsing.)

### 1. Interactive Board & Game Navigation
The foundation. A polished Chessground board with legal move highlighting, drag-and-drop, arrow/circle annotations, premove, coordinate display, and full keyboard navigation (←/→ through moves, Home/End, up/down through variations). Board flip, piece themes, board themes.

### 2. Analysis Engine
First-class UCI engine integration — not bolted on as an afterthought.
- Multi-PV lines with real-time display
- Eval bar (cp + mate) synced to board position
- Infinite analysis, depth-limited analysis, time-limited analysis
- Multiple simultaneous engines (e.g., Stockfish + Leela side-by-side)
- Per-move engine annotations (blunder/mistake/inaccuracy thresholds)
- Full-game blunder check ("Analyze Game" workflow)
- Engine configuration: threads, hash, Syzygy tablebases, contempt, custom UCI options
- Bundled Stockfish with support for adding any UCI engine

### 3. Game Tree & Annotation
The central data model (see spec:016). Everything flows through the tree.
- Branching variations with promotion/demotion, deletion, collapse
- NAG annotations (!, ?, !!, ??, !?, ?!, □, ⩲, ±, etc.)
- Text comments per move and per position
- Arrow and square highlights embedded in the tree
- Clock time and eval score stored per node
- PGN tag editing (players, event, date, result, ECO, etc.)

### 4. Game Database
Local-first database for organizing and searching your chess library.
- Import/export PGN (single game and multi-game files, thousands of games)
- SQLite-backed storage with full-text and structured search
- Search by player, event, date range, result, ECO code, ELO range
- Position search — find all games reaching a given position
- Material/pattern search (e.g., "all R+P vs R endgames")
- Game list with sortable columns, tagging, favorites
- Multiple databases, switchable
- Merge/deduplicate games

### 5. Opening Explorer
Deep opening preparation — the SCID killer feature, modernized.
- Tree view: for any position, show all moves played with W/D/L stats
- Sourced from your local database and/or a master games DB
- Lichess opening explorer API integration (optional, online)
- Transposition detection
- Opening repertoire builder: define your lines, track coverage
- ECO classification and opening name display

### 6. Play vs. Engine
Practice and training against the computer.
- Play as white or black against any installed UCI engine
- Configurable engine strength (ELO limiting, depth limiting, or full strength)
- Time controls: untimed, increment, classical, rapid, blitz, custom
- Takeback/undo support
- Post-game analysis integration (seamless transition to analysis mode)
- Position setup / play from FEN or any position in the tree

### 7. Engine Tournament
Pit engines against each other — fun, useful for engine testing, and a feature most GUIs skip.
- Round-robin or gauntlet tournament formats
- Configurable time controls per engine
- Opening book / starting position suite (to avoid identical games)
- Live board display of the current game
- Real-time standings table (wins, draws, losses, ELO performance)
- PGN export of all tournament games
- Support for multiple concurrent games (parallel matches)

### 8. Tactics Training
The highest-value training surface below ~1900 (research: 50% of study time at that band).
Not another puzzle site clone — decks built from OUR data:
- Avoidance puzzles ("don't step on the rake") mined from the banded corpus — spec:211
- Calibration decks stratified by training value (conversion, critical, endgame, level) — the Learn tab's sampler v3
- Failed-puzzle respawn (spaced-repetition hook), streaks, per-deck stats
- "Play it out": hand any training position to play-vs-engine and convert it to a result —
  perceiving +2 and converting +2 are different skills. Endgame decks train the distinct
  skill class (counting, king activity, passed-pawn technique), not just endgame tactics
- Opening-rake decks: "don't be -1 by move 10" — the sub-1900 form of opening training
- Difficulty from real band miss-rates once the mining data exists, not hand-tuned ratings

### 9. Game Review & Mistake Analysis
Own-game review is the other half of the improvement consensus — engine-assisted but engine-LAST:
commit your own eval and reasoning first, then see the evidence. This is the Learn tab grown up.
- Eval-calibration sessions with the AI coach (note → rebuttal → reply dialogue) — spec:213 Phase 0
- Cause-tagged mistake taxonomy (the machine-labeled per-player error signature)
- Import your own games (Lichess/chess.com) and review them under the same discipline
- Opening leak detection: which openings do YOU repeatedly bleed in (own-games data)
- Plan elicitation: state the plan before the eval; the coach grades plan direction vs the engine line
- Per-phase/per-deck skill tracking over time; Elo-conditioned "visible from ~R" mistake labels — spec:212/213

## Principles

1. **macOS-first** — Native feel, proper menu bar, keyboard shortcuts, dark mode, Retina
2. **Engine-centric** — Stockfish/UCI engine communication is the core, not an afterthought
3. **Fast** — Tauri + Rust backend, no Electron. Sub-second app launch.
4. **Focused** — Do fewer things than ChessBase, do them exceptionally well.
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
│  ┌──────────┐  ┌────────────────────────┐   │
│  │ Database │  │  Engine Tournament UI  │   │
│  │ Browser  │  │  (standings + live)    │   │
│  └──────────┘  └────────────────────────┘   │
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
│  ┌──────────────────────────────────────┐   │
│  │  Tournament Manager (scheduling,     │   │
│  │  multi-engine orchestration, results) │   │
│  └──────────────────────────────────────┘   │
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

## Roadmap Priorities (post-MVP)

1. **Game Tree** — Replace flat move array with tree model (spec:016)
2. **Annotations** — NAGs, comments, arrows/squares in tree
3. **Game Database** — SQLite storage, PGN import, search
4. **Opening Explorer** — Tree stats from local DB
5. **Full-Game Analysis** — Automated blunder check
6. **Multi-Engine** — Side-by-side engine comparison
7. **Engine Tournament** — Round-robin, gauntlet, standings
8. **Opening Repertoire** — Repertoire builder with coverage tracking

## Competitive Landscape (studied April 2026)

| App | Stack | Strengths | Weaknesses |
|-----|-------|-----------|------------|
| **ChessBase** | C++/Win | Feature-complete, industry standard | Expensive, Windows-only, bloated UX, 20 ways to do the same thing |
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
- Correspondence game management
- Integrated opening book editing (Polyglot/CTG authoring)
- Endgame tablebase browsing UI (we use tablebases for engine eval, not as a standalone feature)
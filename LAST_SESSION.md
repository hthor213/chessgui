# Last Session

**Date:** 2026-04-01
**Focus:** MVP specs 010-015 + engine integration + styling
**Status:** Core board interaction working, most features written but untested

## What happened
- Updated vision spec with "best of three" framing (En-Croissant + SCID + Lichess)
- Wrote code for specs 010-015 (keyboard nav, Stockfish wiring, analysis panel, PGN import, last move highlight, promotion dialog)
- Fixed Board: Chessground was losing event callbacks on re-render (stale closure bug)
- Removed overlay title bar, switched to standard macOS window decorations
- Styled toward Lichess dark theme (brown board, dark panels, monospace moves)
- Created full spec roadmap: V1 band (100-102), V2 band (200-203)

## Tested and confirmed working
1. Board renders correctly with pieces in starting position
2. Pieces move via click-to-move (click piece → click destination)
3. Green dots show legal moves when a piece is clicked
4. Moves are recorded and displayed in the move list panel (right side)
5. Turn-based play is enforced (can't move opponent's pieces)
6. Last move is highlighted in the move list

## NOT tested yet (code written but unverified)
- **Keyboard navigation** (spec:010) — arrow keys, Home/End, Cmd+Z
- **Stockfish / Load Engine** (spec:011) — Load Stockfish button, live eval
- **Analysis panel** (spec:012) — eval bar, PV lines, depth/nps display
- **PGN import** (spec:013) — Cmd+V paste dialog
- **Last move board highlighting** (spec:014) — from/to squares highlighted on board (move list highlight works, board highlight unknown)
- **Promotion dialog** (spec:015) — piece picker when pawn reaches last rank
- **Drag-and-drop** — only click-to-move was tested, drag not confirmed

## Known bugs
1. **Castling doesn't work** — likely chessops gives `e1h1` (king-to-rook) but Chessground expects `e1g1` (king-to-destination)
2. **Board re-creates on every state change** — works but wasteful, should optimize back to init-once + set() pattern once stable
3. **Console.log statements** — debug logging in Board.tsx needs removal

## What's next
### Immediate (do these first)
- Fix castling
- Test ALL untested features one by one (keyboard nav, engine, PGN, promotion, drag)
- Remove console.log debug statements
- Fix any bugs found during testing

### V1 Band — Lichess polish
- spec:100 — Best move arrows (Chessground drawable API)
- spec:101 — Engine settings panel (threads, hash, MultiPV)
- spec:102 — Keyboard shortcuts (Ctrl+N new game, F flip, Space toggle analysis)

### V2 Band — SCID power
- spec:200 — SQLite game database
- spec:201 — Opening tree explorer
- spec:202 — Game annotations
- spec:203 — Eval graph

## Dev commands
```bash
cd ~/Documents/GitHub/chessgui
source "$HOME/.cargo/env"
pnpm tauri dev          # Dev mode with hot-reload
pnpm tsc --noEmit       # Type check
pnpm tauri build --debug  # Build .app + .dmg
```

## Key files reference
```
src/App.tsx                      # Layout, keyboard nav, engine + PGN wiring
src/hooks/useChessGame.ts        # Game state, legal moves, promotion, PGN load
src/hooks/useEngine.ts           # Stockfish hook (start/stop/analyze, event listener)
src/lib/uciParser.ts             # UCI info parser, SAN converter, score formatting
src/components/Board.tsx          # Chessground wrapper (re-inits on state change)
src/components/AnalysisPanel.tsx  # Engine eval display (eval bar, PV lines)
src/components/MoveList.tsx       # Move list with click navigation
src/components/PgnImportModal.tsx # PGN paste dialog with multi-game picker
src/components/PromotionDialog.tsx # Piece picker for pawn promotion
src-tauri/src/uci.rs             # Rust UCI engine manager (ready to use)
src-tauri/src/lib.rs             # Tauri command registration
```

## Stockfish
Binary at `/Users/hjalti/Documents/GitHub/Stockfish/src/stockfish` (ARM64, sibling repo).
Default path hardcoded in `useEngine.ts`. Not bundled in app yet.

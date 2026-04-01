# Last Session

**Date:** 2026-04-01
**Focus:** ChessX analysis, spec updates, engine debugging, migration planning
**Status:** Engine communication FIXED, frontend migration planned

## What happened
- Analyzed ChessX (85K LOC C++/Qt5 chess DB app) — decided NOT to restart, but to learn from its architecture
- Created spec:016 (Game Tree) — foundational data model for variations, the critical missing piece
- Updated vision spec (000) with architecture layers and competitive landscape
- Updated specs 011, 200-203 with ChessX-informed architecture patterns
- Fixed Stockfish engine communication:
  - Added `stdin.flush()` in Rust UCI pipe (commands weren't reaching the engine)
  - Changed `app.emit()` to `app.emit_to("main", ...)` (events weren't reaching the frontend)
  - Both fixes confirmed working — engine output visible in terminal logs
- Play-vs-Stockfish mode works but crashes after ~6 moves due to castling bug in `playUciMove`
- Planned full frontend migration: Vite + Mantine → Next.js + Tailwind + shadcn/ui

## Confirmed working
1. Board renders, click-to-move, legal move dots, turn enforcement
2. Rust engine pipe: commands reach Stockfish, output reaches frontend via `emit_to`
3. Play-vs-Stockfish mode works for first few moves (until castling-related crash)

## Known bugs
1. **`playUciMove` castling crash** — Stockfish sends `e1g1` (standard UCI), chessops expects `e1h1` (king-captures-rook). `makeSan()` throws, no try-catch → app crash. Fix is documented in the migration plan.
2. **Debug logging still in** — `eprintln!` in uci.rs, `console.log("[engine]")` in useEngine.ts. Remove after migration.

## What's next
### IMMEDIATE: Frontend migration (Next.js + Tailwind + shadcn/ui)
Full plan at: `~/.claude/plans/sprightly-rolling-biscuit.md`

**Execution order:**
1. Scaffold Next.js + Tailwind + shadcn (remove Vite + Mantine)
2. Move logic files (hooks, lib, Board, PromotionDialog) — unchanged
3. Fix `playUciMove` castling bug
4. Rewrite Mantine components → shadcn (MoveList, AnalysisPanel, PgnImportDialog)
5. Wire up in `app/page.tsx`
6. Test: board, moves, Play vs Stockfish (10+ moves), PGN import, keyboard nav

**Key gotchas:**
- Chessground must be `dynamic(() => ..., { ssr: false })` — uses DOM
- Tauri API must be in `"use client"` components — uses `window.__TAURI_INTERNALS__`
- Next.js must use `output: 'export'` + `distDir: 'dist'` for Tauri static loading
- Dev server must use port 1420 to match Tauri's devUrl

### AFTER MIGRATION
- Test all untested features (keyboard nav, PGN import, promotion, drag-and-drop)
- spec:016 — Game Tree implementation (variations, annotations)
- V1 features (100-102): best move arrows, engine settings, keyboard shortcuts

## Dev commands
```bash
cd ~/Documents/GitHub/chessgui
source "$HOME/.cargo/env"
pnpm tauri dev          # Dev mode (after migration: uses next dev --port 1420)
pnpm tsc --noEmit       # Type check
```

## Key files reference (CURRENT — before migration)
```
src/App.tsx                      # Layout, keyboard nav, engine wiring (Mantine)
src/hooks/useChessGame.ts        # Game state, legal moves — FIX CASTLING BUG
src/hooks/useEngine.ts           # Stockfish hook (working, has debug logging)
src/lib/uciParser.ts             # UCI info parser
src/components/Board.tsx          # Chessground wrapper (no Mantine dep)
src/components/AnalysisPanel.tsx  # Engine eval display (Mantine — rewrite)
src/components/MoveList.tsx       # Move list (Mantine — rewrite)
src/components/PgnImportModal.tsx # PGN dialog (Mantine — rewrite)
src/components/PromotionDialog.tsx # Piece picker (no Mantine dep)
src-tauri/src/uci.rs             # Rust UCI engine pipe (working, has flush + emit_to fixes)
```

## Stockfish
Binary at `/Users/hjalti/Documents/GitHub/Stockfish/src/stockfish` (ARM64, sibling repo).
Default path hardcoded in `useEngine.ts`. Not bundled in app yet.

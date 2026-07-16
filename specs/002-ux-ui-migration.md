# 002: UX/UI Migration — Next.js + Tailwind + shadcn/ui

**Status:** done
**Depends on:** 001 (board & gameplay stable)
**Blocks:** 016 (game tree — both touch MoveList, migrate UI first to avoid double-rewrite)

## Goal
Migrate the frontend from Vite + Mantine to Next.js (static export) + Tailwind CSS + shadcn/ui. Keep all game logic and Rust backend unchanged. Fix the castling bug during migration.

## Why
User is more proficient in Next.js + Tailwind. Mantine was chosen arbitrarily and adds friction. shadcn/ui provides composable, customizable components.

## Key Constraints
- Next.js must use `output: 'export'` + `distDir: 'dist'` for Tauri static loading
- Chessground must be `dynamic(() => ..., { ssr: false })` — uses DOM APIs
- Tauri API must be in `"use client"` components — uses `window.__TAURI_INTERNALS__`
- Dev server must use port 1420 to match Tauri's `devUrl`

## Phase 1: Scaffold (ai-dev-dashboard compatible)

Remove Vite + Mantine, add Next.js + Tailwind + shadcn.

1. Remove deps: `@mantine/core`, `@mantine/hooks`, `@vitejs/plugin-react`, `vite`
2. Add deps: `next`, `tailwindcss`, `postcss`, `autoprefixer`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`
3. Create `next.config.js` (static export, `distDir: 'dist'`)
4. Create `tailwind.config.ts`, `postcss.config.js`
5. Create `app/layout.tsx` + `app/globals.css` + `app/page.tsx` (hello world)
6. Init shadcn: `npx shadcn@latest init`
7. Add shadcn components: `npx shadcn@latest add button card badge dialog scroll-area textarea tooltip`
8. Update `tauri.conf.json` build paths (`beforeDevCommand: "pnpm next dev --port 1420"`)
9. Delete `vite.config.ts`, `index.html`, `tsconfig.node.json`, `src/main.tsx`

**Verify:** `pnpm tauri dev` shows hello world in Tauri window

## Phase 2: Move Logic Layer

Copy hooks/lib to new locations (rename to kebab-case). Fix castling bug.

1. `hooks/useChessGame.ts` → `hooks/use-chess-game.ts` — fix castling bug (see below)
2. `hooks/useEngine.ts` → `hooks/use-engine.ts` — as-is
3. `lib/uciParser.ts` → `lib/uci-parser.ts` — as-is
4. `components/Board.tsx` → `components/board.tsx` — as-is
5. `components/PromotionDialog.tsx` → `components/promotion-dialog.tsx` — as-is

### Castling Bug Fix

In `playUciMove()`, Stockfish sends `e1g1` (standard UCI) but chessops expects `e1h1` (king-captures-rook). Fix:
```typescript
const castlingUci: Record<string, string> = {
  "e1g1": "e1h1", "e1c1": "e1a1",  // white
  "e8g8": "e8h8", "e8c8": "e8a8",  // black
};
const normalizedUci = castlingUci[uci] || uci;
```
Also wrap in try-catch so engine errors don't crash the app.

**Verify:** `pnpm tsc --noEmit` passes

## Phase 3: Rewrite UI Components

Replace Mantine components with shadcn/ui + Tailwind.

1. `MoveList.tsx` → `components/move-list.tsx` — shadcn Card + ScrollArea
2. `AnalysisPanel.tsx` → `components/analysis-panel.tsx` — shadcn Card + Badge + Button + Tooltip
3. `PgnImportModal.tsx` → `components/pgn-import-dialog.tsx` — shadcn Dialog + Textarea
4. Wire everything up in `app/page.tsx` (`"use client"`, dynamic import for Board)
5. Merge `styles.css` into `app/globals.css` (keep Chessground overrides)

**Verify:** `pnpm tsc --noEmit` passes

## Phase 4: Integration Test

1. `pnpm tauri dev` — full app runs
2. Board renders, click-to-move works, legal move dots shown
3. "Play vs Stockfish" — play 10+ moves without crash
4. Cmd+V PGN import loads a game
5. Arrow key navigation works
6. Castling works (both white and black, both sides)

## Files Changed
```
DELETE: vite.config.ts, index.html, tsconfig.node.json, src/main.tsx
DELETE: src/App.tsx, src/styles.css (replaced by app/ structure)
DELETE: src/components/MoveList.tsx, AnalysisPanel.tsx, PgnImportModal.tsx (rewritten)
MOVE:   src/hooks/ → hooks/, src/lib/ → lib/, src/components/Board.tsx → components/
NEW:    next.config.js, tailwind.config.ts, postcss.config.js, components.json
NEW:    app/layout.tsx, app/page.tsx, app/globals.css
NEW:    components/ui/ (shadcn generated)
KEEP:   src-tauri/ (unchanged)
```

## Done When
- [x] Vite and Mantine fully removed from project
- [x] Next.js static export builds successfully
- [x] All UI components use shadcn/ui + Tailwind (no Mantine imports)
- [x] Castling bug fixed in `playUciMove`
- [x] Board renders with Chessground (dynamic import, SSR-safe)
- [x] Engine analysis works (start, stop, display eval)
- [x] Play vs Stockfish works for 10+ moves
- [x] PGN import works (paste and file open) — delivered, tracked in 001/013 (code-verified 2026-07-15)
- [x] Keyboard navigation works (arrow keys, Home/End) — delivered, tracked in 001/013 (code-verified 2026-07-15)
- [x] Dark theme consistent throughout

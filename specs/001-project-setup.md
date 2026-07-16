# 001: Project Setup

**Status:** archived (2026-07-16, requirements audit / librarian pass) — bootstrap scope is done; its "Done When" items are mirrored and superseded by 001-board-gameplay.md's "Board & Setup (from spec:001)" section, which is the actively maintained spec:001. Kept on disk for history, not further edited.

## Goal
Bootstrap the Tauri 2 + React + TypeScript project with Chessground, chessops, and Mantine.

## Approach
Scaffold with `pnpm create tauri-app`, add chess dependencies, configure for macOS.

## Done When
- [x] `pnpm tauri dev` launches a window with a Chessground board rendered (code-verified 2026-07-15)
- [x] Pieces are draggable and legal moves are highlighted (code-verified 2026-07-15)
- [ ] Mantine theme provider is configured (dark mode default) — superseded by spec 002 (Tailwind + shadcn/ui)
- [x] Rust backend compiles and the Tauri IPC bridge works (test with a ping command) (code-verified 2026-07-15)

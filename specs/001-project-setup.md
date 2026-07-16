# 001: Project Setup

**Status:** active

## Goal
Bootstrap the Tauri 2 + React + TypeScript project with Chessground, chessops, and Mantine.

## Approach
Scaffold with `pnpm create tauri-app`, add chess dependencies, configure for macOS.

## Done When
- [x] `pnpm tauri dev` launches a window with a Chessground board rendered (code-verified 2026-07-15)
- [x] Pieces are draggable and legal moves are highlighted (code-verified 2026-07-15)
- [ ] Mantine theme provider is configured (dark mode default) — superseded by spec 002 (Tailwind + shadcn/ui)
- [x] Rust backend compiles and the Tauri IPC bridge works (test with a ping command) (code-verified 2026-07-15)

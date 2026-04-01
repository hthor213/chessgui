# 001: Project Setup

**Status:** active

## Goal
Bootstrap the Tauri 2 + React + TypeScript project with Chessground, chessops, and Mantine.

## Approach
Scaffold with `pnpm create tauri-app`, add chess dependencies, configure for macOS.

## Done When
- [ ] `pnpm tauri dev` launches a window with a Chessground board rendered
- [ ] Pieces are draggable and legal moves are highlighted
- [ ] Mantine theme provider is configured (dark mode default)
- [ ] Rust backend compiles and the Tauri IPC bridge works (test with a ping command)

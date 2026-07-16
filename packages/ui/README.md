# @chessgui/ui

Shared React components + the single-source board/piece/theme assets for
every ChessGUI shell (spec 220). Chessground wrapper, move-list,
analysis-panel, eval-graph, shadcn kit, dialogs, `board-theme.css`,
`square-state.css`, `tailwind-preset.ts`.

## Hard rules

### Static export (load-bearing — spec 220 step 8 / "Risks")

Every shell consumes this package through a Next.js **static export**
(`output: 'export'`). That constraint is architectural, not incidental:
anything added here must keep working with

- **no API routes** — server state lives behind the arena API (spec 217) or
  the desktop shell's Rust commands, never in a Next route;
- **no server components doing IO** — components are client-side (or purely
  presentational server-renderable); all IO goes through the spec 220
  platform providers (`getProviders()` from `@chessgui/core/platform`);
- **`images.unoptimized`** — no `next/image` optimization pipeline.

A feature that wants API routes or server components breaks the desktop AND
web shells at once. Don't.

### Platform seam

Components never import a platform SDK (`@tauri-apps/*`, WASM workers,
fetch-to-arena directly). Capabilities arrive via the provider interfaces in
`@chessgui/core/platform-types`; shells register implementations at boot.

### Single-source theming

Pieces, board texture, square-state colors, and theme tokens live HERE
(`board-theme.css`, `square-state.css`, `tailwind-preset.ts`). A shell may
not declare a color, piece asset, or board style locally — a visual
difference becomes a preset variable.

## License

GPL-3.0. Chessground (GPL) lives in this package, so every shell that uses
the shared board is GPL — all workspace packages stay GPL-3.0; no "MIT the
core later" without replacing the board layer.

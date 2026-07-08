---
name: verify
description: Drive the ChessGUI frontend end-to-end in a headless browser to verify UI changes. Use before committing frontend features.
---

# Verifying ChessGUI frontend changes

Frontend flows (board, dialogs, import, editor, move list) run fine without
the Tauri shell — only engine features need `pnpm tauri dev`.

## Launch

```bash
pnpm dev          # serves on http://localhost:1420 (NOT 3000), ready in <1s
```

## Drive

Python Playwright is installed globally (miniforge) with Chromium:

```python
from playwright.sync_api import sync_playwright  # sync API works well
```

- Board is Chessground: squares are not DOM nodes. Click squares by
  coordinates computed from `.cg-wrap`'s bounding box (square = width/8;
  white orientation: x = (file+0.5)/8, y = (8-rank+0.5)/8).
- Verify positions via the editor's FEN input value or
  `localStorage.getItem('chessgui-game')` (JSON with `startFen`, `positions`).
- Dialogs: `page.get_by_role("dialog")`; editor confirm button is
  "Set up position", import confirm is "Load".
- Editor palette buttons have `title="white king"` etc.; tools are
  "Move" / "Eraser" buttons.

## Gotchas

- **Pace clicks**: wait ~150ms after palette selection and ~250ms after each
  board click — each placement rebuilds the Chessground board and
  full-speed scripted clicks get swallowed.
- Editor board takes ~200-400ms to first-paint after dialog open (dynamic
  import) — wait before screenshotting.
- In plain-browser mode one console error is expected and pre-existing:
  `Cannot read properties of undefined (reading 'transformCallback')`
  (Tauri IPC absent). It lights up the Next.js dev-overlay "1 Issue" badge.
  Ignore it; don't count it as a regression.
- Keyboard shortcuts use `Meta+` on mac (`page.keyboard.press("Meta+e")`).

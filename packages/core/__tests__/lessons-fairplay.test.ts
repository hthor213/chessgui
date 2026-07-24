// Concept Lessons — the fair-play boundary is structural (specs/227, D5 seed).
//
// The Lessons surface teaches chess-in-general on public study positions; it
// must NOT read the live fair-play game's tree / FEN / notebook, or the engine
// lockout it lives under. This test asserts the boundary the cheap way it can
// be asserted in a pure test: no source file on the Lessons surface imports a
// live-game / notebook / live-engine module. If a future edit reaches for
// `useChessGame` (or the notebook, active-game, or engine hook) to "just grab
// the current position", this fails — the boundary is enforced, not documented.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The whole Lessons surface: the tab, the module player, and the pure reducer.
const SURFACE_FILES = [
  "packages/ui/src/lessons-tab.tsx",
  "packages/ui/src/lesson-module-player.tsx",
  "packages/core/src/lesson-player.ts",
];

// Modules that would couple the surface to the live game or its guards.
const FORBIDDEN = [
  "use-chess-game",
  "useChessGame",
  "@chessgui/core/notebook",
  "@chessgui/core/active-game",
  "use-engine",
];

function readSurface(rel: string): string {
  // Vitest runs from the repo root.
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("fair-play boundary — the Lessons surface reads no live-game state", () => {
  for (const rel of SURFACE_FILES) {
    it(`${rel} imports no live-game/notebook/engine module`, () => {
      const src = readSurface(rel);
      const importLines = src
        .split("\n")
        .filter((l) => /^\s*import\b/.test(l) || /\brequire\(/.test(l));
      const joined = importLines.join("\n");
      for (const bad of FORBIDDEN) {
        expect(joined, `${rel} must not import "${bad}"`).not.toContain(bad);
      }
    });
  }
});

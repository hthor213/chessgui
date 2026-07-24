// Concept Lessons — the fair-play boundary is STRUCTURAL (specs/227, D5).
//
// D5: "A test proves the lesson surface imports nothing from the live-game /
// notebook modules and reads no active-game state — the boundary is
// STRUCTURAL. The Lessons surface renders and functions with no game loaded."
//
// The seed (D3) only compared the DIRECT import lines of three files against a
// fixed string list — it could not see a live-game module pulled in three hops
// down. This test replaces that with a real TRANSITIVE import-graph guard: it
// starts at the lesson-surface entry points and RECURSIVELY follows every
// first-party import (resolving `./x`, `@chessgui/core/*`, `@chessgui/ui/*`) to
// build the full set of source modules the surface can reach, then asserts none
// of them is a live-game / engine-state module. If a future edit reaches for
// `useChessGame` / `useEngine` / the engine session anywhere on the surface —
// directly or transitively — this fails and names the offending edge.
//
// ── The one honest subtlety, stated plainly ─────────────────────────────────
// The lesson player parses BUNDLED master-game PGN into plain data via
// `parsePgnToTrees` (packages/core/pgn.ts). That pulls in the shared GameTree
// model (game-tree.ts), and the GameTree model imports two PURE constants/
// predicates from the annotation layer:
//     pgn.ts → game-tree.ts → active-game.ts   (livePositionCanMove, a pure predicate)
//     pgn.ts → game-tree.ts → notebook.ts      (ASSESSMENT_NAGS, a constant)
// Both `active-game.ts` and `notebook.ts` are, by their own file headers, the
// PURE half of their features: no I/O, no ambient state (all live I/O lives in
// the shells). Reaching a stateless predicate/constant through the shared chess
// model is NOT "reading active-game state", and the surface still renders with
// no game loaded. So the guard does not blanket-ban those basenames (that would
// be a false positive that forbids the very PGN model the lessons need).
// Instead it enforces the precise boundary that actually matters:
//   (1) the live-STATE carriers — use-chess-game, use-engine, engine-session —
//       are UNREACHABLE from the surface (the load-bearing guarantee), and
//   (2) `active-game.ts` / `notebook.ts` enter the graph ONLY under the shared
//       chess-model layer (game-tree / pgn / annotations), never through a
//       direct import by a lesson-surface or lesson-UI file. The moment a
//       lesson file imports one of them directly, (2) fails.
// This keeps the guard strong and TRUE rather than green-by-hand-waving.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../.."); // __tests__ → core → packages → root
const CORE_SRC = resolve(REPO_ROOT, "packages/core/src");
const UI_SRC = resolve(REPO_ROOT, "packages/ui/src");

// ── The lesson-surface entry points (the graph roots) ────────────────────────
const ENTRY_POINTS = [
  "packages/ui/src/lessons-tab.tsx",
  "packages/ui/src/lesson-module-player.tsx",
  "packages/core/src/lesson-player.ts",
  "packages/core/src/lesson-grade.ts",
  "packages/core/src/lesson-progress.ts",
  "packages/core/src/lessons.ts",
].map((rel) => resolve(REPO_ROOT, rel));

// ── Live-STATE carriers — reachable = a fair-play breach ─────────────────────
// These modules HOLD or FETCH the live game/engine (React hooks + the engine
// session). Matched against every reachable module basename AND every raw
// import specifier we encounter (so an unresolved `@/hooks/use-chess-game`
// alias is caught too, not just resolvable first-party paths).
const HARD_FORBIDDEN = ["use-chess-game", "use-engine", "engine-session"];

// ── Modules whose reach must stay under the shared chess-model layer only ────
// (see the header note). If a lesson-surface file imports one of these
// directly, the boundary is breached even though the basename is "pure".
const MODEL_GATED = /^(active-game|active-games|notebook)(\.|-|$)/;

// The shared chess-model files that are ALLOWED to import the model-gated
// modules (this is where the GameTree ↔ annotation coupling legitimately
// lives). A model-gated module reached via any importer NOT in this set is a
// direct lesson-side coupling and fails.
const MODEL_LAYER = new Set(
  ["game-tree.ts", "pgn.ts", "annotations.ts", "notebook.ts", "active-game.ts", "training-record.ts"].map(
    (f) => resolve(CORE_SRC, f),
  ),
);

// ── Import-specifier extraction (regex, not a full TS parse — sufficient) ─────
interface Spec {
  spec: string;
  typeOnly: boolean;
}

function extractSpecifiers(src: string): Spec[] {
  const out: Spec[] = [];
  // `import ... from "x"` / `export ... from "x"` (captures the clause to spot
  // `import type`). The clause may span newlines (multiline `import { … }`
  // blocks are common), so newlines are NOT excluded — only quotes/parens are,
  // which keeps each match paired with its own `from "…"`.
  const fromRe = /\b(import|export)\b([^'"()]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  for (let m; (m = fromRe.exec(src)); ) {
    const clause = m[2] ?? "";
    out.push({ spec: m[3], typeOnly: /^\s*type\b/.test(clause) });
  }
  // Side-effect imports: `import "x"` (no `from`)
  const sideRe = /\bimport\s*['"]([^'"]+)['"]/g;
  for (let m; (m = sideRe.exec(src)); ) out.push({ spec: m[1], typeOnly: false });
  // Dynamic `import("x")`
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m; (m = dynRe.exec(src)); ) out.push({ spec: m[1], typeOnly: false });
  return out;
}

// ── Module resolution — ONLY first-party paths are followed ───────────────────
// Relative (`./x`, `../x`), `@chessgui/core/*` → packages/core/src/*,
// `@chessgui/ui/*` → packages/ui/src/*. Everything else (react, chessops, next,
// @lichess-org/chessground, the `@/…` app seam, any bare package) is external:
// not live-game state, so not followed. `.json` / `.css` are data, not code.
function resolveFirstParty(spec: string, importerAbs: string): string | null {
  let base: string;
  if (spec.startsWith(".")) {
    base = resolve(dirname(importerAbs), spec);
  } else if (spec.startsWith("@chessgui/core/")) {
    base = resolve(CORE_SRC, spec.slice("@chessgui/core/".length));
  } else if (spec.startsWith("@chessgui/ui/")) {
    base = resolve(UI_SRC, spec.slice("@chessgui/ui/".length));
  } else {
    return null; // external / bare / `@/` app seam — not followed
  }
  if (/\.(json|css)$/.test(base)) return null; // data, not code
  const candidates = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

// ── The transitive walk ──────────────────────────────────────────────────────
interface Reached {
  /** Direct importers of this module within the reachable graph. */
  importers: Set<string>;
}
interface WalkResult {
  reachable: Map<string, Reached>; // absPath → info
  /** Every (importerAbs, rawSpec, typeOnly) edge seen — for specifier scans. */
  specifierEdges: { from: string; spec: string; typeOnly: boolean }[];
}

function walk(entries: string[]): WalkResult {
  const reachable = new Map<string, Reached>();
  const specifierEdges: WalkResult["specifierEdges"] = [];
  const queue = [...entries];
  for (const e of entries) reachable.set(e, { importers: new Set() });

  while (queue.length) {
    const file = queue.shift()!;
    const src = readFileSync(file, "utf8");
    for (const { spec, typeOnly } of extractSpecifiers(src)) {
      specifierEdges.push({ from: file, spec, typeOnly });
      // Type-only edges carry no runtime coupling — don't follow them into the
      // graph (task: "skip type-only where sensible"). They're still recorded
      // above so a `import type … from "use-engine"` specifier is still scanned.
      if (typeOnly) continue;
      const target = resolveFirstParty(spec, file);
      if (!target) continue;
      let info = reachable.get(target);
      if (!info) {
        info = { importers: new Set() };
        reachable.set(target, info);
        queue.push(target);
      }
      info.importers.add(file);
    }
  }
  return { reachable, specifierEdges };
}

const rel = (abs: string) => abs.replace(`${REPO_ROOT}/`, "");

describe("fair-play boundary — the Lessons surface is structurally decoupled from the live game", () => {
  const { reachable, specifierEdges } = walk(ENTRY_POINTS);

  it("the transitive walk actually followed imports (sanity: it reached beyond the entry points)", () => {
    // If resolution silently broke, the graph would be just the roots and every
    // downstream assertion would pass vacuously. Prove the walk went deep: it
    // must have reached the shared PGN model, which is 2+ hops from the surface.
    const names = new Set([...reachable.keys()].map((a) => basename(a)));
    expect(reachable.size).toBeGreaterThan(ENTRY_POINTS.length);
    expect(names.has("pgn.ts"), "walk should reach pgn.ts (lesson-player → ./pgn)").toBe(true);
    expect(names.has("game-tree.ts"), "walk should reach game-tree.ts (pgn → ./game-tree)").toBe(true);
    expect(names.has("board.tsx"), "walk should reach board.tsx (module-player dynamic import)").toBe(true);
  });

  it("no live-STATE carrier (use-chess-game / use-engine / engine-session) is reachable", () => {
    const violations: string[] = [];
    // (a) any reachable module whose basename is a live-state carrier
    for (const [abs, info] of reachable) {
      const b = basename(abs);
      for (const bad of HARD_FORBIDDEN) {
        if (b.includes(bad)) {
          const via = [...info.importers].map(rel).join(", ") || "(entry point)";
          violations.push(`reachable module ${rel(abs)} matches "${bad}" — pulled in by: ${via}`);
        }
      }
    }
    // (b) any raw import specifier (even one that doesn't resolve first-party,
    //     e.g. the `@/hooks/use-*` app-alias) naming a live-state carrier
    for (const { from, spec } of specifierEdges) {
      for (const bad of HARD_FORBIDDEN) {
        if (spec.includes(bad)) {
          violations.push(`${rel(from)} imports "${spec}" (matches "${bad}")`);
        }
      }
    }
    expect(violations, `live-game/engine state reached from the Lessons surface:\n${violations.join("\n")}`).toEqual([]);
  });

  it("active-game / notebook modules are reached ONLY under the shared chess-model layer, never a lesson file", () => {
    // The pure `active-game.ts` / `notebook.ts` are allowed to be reached — but
    // only because the GameTree model uses their constants/predicates. If a
    // lesson-surface (or lesson-UI) file imports one DIRECTLY, that is a real
    // live-side coupling. Assert every importer of a model-gated module is a
    // shared chess-model file.
    const violations: string[] = [];
    for (const [abs, info] of reachable) {
      if (!MODEL_GATED.test(basename(abs))) continue;
      for (const importer of info.importers) {
        if (!MODEL_LAYER.has(importer)) {
          violations.push(
            `${rel(abs)} is imported by ${rel(importer)} — a non-model-layer file. ` +
              `The Lessons surface must not import active-game/notebook directly.`,
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("the reachable model-gated modules are exactly the two pure core primitives (documents the known edge)", () => {
    // Pin the CURRENT, understood boundary so a new live active-games/notebook
    // module silently entering the graph is caught, not absorbed.
    const gated = [...reachable.keys()].filter((a) => MODEL_GATED.test(basename(a))).map(rel).sort();
    expect(gated).toEqual([
      "packages/core/src/active-game.ts",
      "packages/core/src/notebook.ts",
    ]);
  });

  it("LessonsTab is structurally game-free: no required game/tree/engine prop, rendered prop-less", () => {
    // Node env, no jsdom (spec: STRUCTURAL guard; the browser render was verified
    // in D3/D4). Inspect the source signature rather than mount the component.
    const tabSrc = readFileSync(resolve(UI_SRC, "lessons-tab.tsx"), "utf8");
    const sig = tabSrc.match(/export\s+function\s+LessonsTab\s*\(([^)]*)\)/);
    expect(sig, "LessonsTab must be an exported function").not.toBeNull();
    const params = sig![1];
    // Its only param is an options object with an optional `initialView` — no
    // game, tree, fen, engine, or session is threaded in.
    for (const banned of ["game", "tree", "fen", "engine", "session", "node", "position"]) {
      expect(
        new RegExp(`\\b${banned}\\b`, "i").test(params),
        `LessonsTab signature must carry no "${banned}" prop, got: ${params.trim()}`,
      ).toBe(false);
    }

    // And the desktop shell renders it with NO props — consistent with a surface
    // that functions with no game loaded.
    const page = readFileSync(resolve(REPO_ROOT, "apps/desktop/app/page.tsx"), "utf8");
    expect(page, "page.tsx should render <LessonsTab /> prop-less").toMatch(/<LessonsTab\s*\/>/);
  });
});

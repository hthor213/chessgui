// Platform capability flags (spec 220 step 1). A shell that lacks a
// capability hides the corresponding UI outright — no stubs, no dead tabs.

import { getProviders, isTauri } from "@/lib/platform"

/**
 * Headless engine-vs-engine tournaments ride the native match runner
 * (src-tauri match_runner via ~15 invoke + Channel sites in tournament-tab).
 * Desktop-only until a TournamentRunner interface absorbs those call sites
 * (spec 220, post-split).
 */
export function hasTournamentRunner(): boolean {
  return isTauri()
}

/**
 * Side-by-side engine comparison (spec 900 backlog item): a second engine
 * process needs the native UCI host — the web shell's single WASM worker
 * can't run two, so its provider only backs the default session.
 */
export function hasEngineCompare(): boolean {
  return getProviders().engine.hasNativeEngine
}

/**
 * A persistent, writable game database (spec 200): the desktop shell's SQLite
 * store. The web shell's database provider is read-only (lichess explorer /
 * mock), so game-saving paths — including the analysis auto-save — gate on this.
 */
export function hasGameDatabase(): boolean {
  return isTauri()
}

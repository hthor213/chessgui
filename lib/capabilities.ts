// Platform capability flags (spec 220 step 1). A shell that lacks a
// capability hides the corresponding UI outright — no stubs, no dead tabs.

import { isTauri } from "@/lib/database"

/**
 * Headless engine-vs-engine tournaments ride the native match runner
 * (src-tauri match_runner via ~15 invoke + Channel sites in tournament-tab).
 * Desktop-only until a TournamentRunner interface absorbs those call sites
 * (spec 220, post-split).
 */
export function hasTournamentRunner(): boolean {
  return isTauri()
}

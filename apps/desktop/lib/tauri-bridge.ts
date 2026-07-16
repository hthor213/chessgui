// Thin re-export of the Tauri IPC primitives for components that are fenced
// desktop-only behind a capability flag (today: tournament-tab, gated on
// lib/capabilities.ts hasTournamentRunner, spec 220 step 1). Keeps every
// @tauri-apps import inside lib/ until the TournamentRunner interface
// (spec 220, post-split) absorbs the call sites.
//
// Do NOT import this from shared/portable code — anything using it must be
// hidden on non-desktop shells.

export { invoke, Channel } from "@tauri-apps/api/core"

// Platform provider registry (spec 220 step 2). Domain wrappers (lib/*,
// hooks/*) call getProviders() for every platform capability; nothing outside
// lib/platform (plus the fenced lib/tauri-bridge.ts) imports @tauri-apps/*.
//
// Until the shells are separate apps (spec 220 steps 7–8) both provider sets
// ship in the one bundle and the default registration picks by environment —
// the single remaining isTauri() branch in shared code. A future shell calls
// registerProviders() at boot instead.

import { browserProviders } from "./browser"
import { tauriProviders } from "./tauri"
import type { PlatformProviders } from "./types"

export * from "./types"

/** True inside the Tauri webview (its IPC globals are injected before load). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

let active: PlatformProviders | null = null

/** Boot-time injection point for a shell's own implementations. */
export function registerProviders(providers: PlatformProviders): void {
  active = providers
}

export function getProviders(): PlatformProviders {
  if (!active) active = isTauri() ? tauriProviders : browserProviders
  return active
}

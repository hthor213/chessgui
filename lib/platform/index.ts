// Platform provider seam, app side (spec 220 steps 2+5). The interfaces and
// the registry itself live in @chessgui/core (packages/core/src/platform.ts);
// this module re-exports them and registers the environment-picked default —
// the single remaining isTauri() branch in shared code. Nothing outside
// lib/platform (plus the fenced lib/tauri-bridge.ts) imports @tauri-apps/*.
//
// Until the shells are separate apps (spec 220 steps 7–8) both provider sets
// ship in the one bundle and the lazy default picks by environment. A future
// shell calls registerProviders() at boot instead.

import { registerDefaultProviders } from "@chessgui/core/platform"
import { browserProviders } from "./browser"
import { tauriProviders } from "./tauri"

export * from "@chessgui/core/platform"

/** True inside the Tauri webview (its IPC globals are injected before load). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

registerDefaultProviders(() => (isTauri() ? tauriProviders : browserProviders))

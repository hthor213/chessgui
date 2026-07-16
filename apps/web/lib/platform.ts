// Web shell platform seam (spec 220 step 8).
//
// This module SHADOWS the desktop shell's lib/platform/index.ts: this app's
// tsconfig maps the exact specifier "@/lib/platform" here while the "@/*"
// catch-all points at ../desktop, because the platform-neutral lib/hooks
// surface still physically lives in apps/desktop until spec 221 hoists it
// into packages. Every "@/lib/platform" import inside that shared surface
// resolves here when bundled by THIS app, so the Tauri provider set
// (lib/platform/tauri.ts, lib/tauri-bridge.ts, @tauri-apps/*) never enters
// this module graph — that is the "no Tauri deps" gate of step 8.
//
// Registration is eager and unconditional: a shell picks its providers at
// boot (spec 220 "no isTauri() branching left in shared code"). Today that
// is the browser stub set; spec 221 replaces it with HTTP/WASM providers
// (arena API for play, stockfish WASM worker for analysis).

import { registerProviders } from "@chessgui/core/platform"
import { browserProviders } from "../../desktop/lib/platform/browser"

export * from "@chessgui/core/platform"

/** Always false in this shell — it never runs inside a Tauri webview. The
 *  capability gates (lib/capabilities.ts) use this to hide native-only UI
 *  (tournament runner, CBH import, machine bench). */
export function isTauri(): boolean {
  return false
}

registerProviders(browserProviders)

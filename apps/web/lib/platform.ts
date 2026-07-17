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
// boot (spec 220 "no isTauri() branching left in shared code"). This is the
// spec 221 provider set: the browser stubs (mocks for the v1-OUT features,
// localStorage storage, <input type=file> dialog fallback, lichess-explorer/
// mock database) with the engine's UCI lifecycle re-backed by the stockfish
// WASM worker (lib/wasm-engine.ts). Play vs personas needs no provider at
// all — lib/arena-api.ts is plain fetch against the same-origin /chess/api
// mount (NEXT_PUBLIC_ARENA_API_BASE, next.config.mjs).

import { registerProviders } from "@chessgui/core/platform"
import type { EngineStartResult, PlatformProviders } from "@chessgui/core/platform"
import { DEFAULT_ENGINE_SESSION } from "@chessgui/core/engine-session"
import { browserProviders } from "../../desktop/lib/platform/browser"
import {
  WASM_ENGINE_PATH,
  onWasmEngineLine,
  sendWasmCommand,
  startWasmEngine,
  stopWasmEngine,
} from "./wasm-engine"

export * from "@chessgui/core/platform"

/** Always false in this shell — it never runs inside a Tauri webview. The
 *  capability gates (lib/capabilities.ts) use this to hide native-only UI
 *  (tournament runner, CBH import, machine bench). */
export function isTauri(): boolean {
  return false
}

// The WASM worker is ONE engine — only the default session is backed. A
// non-default session (spec 900's second-engine compare slot, desktop-only —
// hasNativeEngine gates its UI off here) is refused/no-oped rather than
// silently sharing the single worker, so a stray sessioned caller can never
// hijack or kill the main analysis engine.
function isDefaultSession(sessionId?: string): boolean {
  return !sessionId || sessionId === DEFAULT_ENGINE_SESSION
}

const webProviders: PlatformProviders = {
  ...browserProviders,
  engine: {
    ...browserProviders.engine,
    // hasNativeEngine stays false: it gates the NATIVE-host features
    // (machine bench/profile, spec 221 v1-OUT), not analysis itself.
    defaultEnginePath: WASM_ENGINE_PATH,
    // the WASM build is the only engine — path ignored
    startEngine(_path: string, _context?: string, sessionId?: string, chess960?: boolean): Promise<EngineStartResult> {
      if (!isDefaultSession(sessionId)) {
        return Promise.reject(
          new Error("Only one engine runs in the browser — side-by-side comparison needs the desktop app"),
        )
      }
      return startWasmEngine(chess960)
    },
    sendCommand(command: string, _context?: string, sessionId?: string): Promise<void> {
      if (!isDefaultSession(sessionId)) return Promise.resolve()
      return sendWasmCommand(command)
    },
    stopEngine(sessionId?: string): Promise<void> {
      if (!isDefaultSession(sessionId)) return Promise.resolve()
      return stopWasmEngine()
    },
    onEngineLine(onLine: (line: string) => void, sessionId?: string): Promise<() => void> {
      if (!isDefaultSession(sessionId)) return Promise.resolve(() => {})
      return onWasmEngineLine(onLine)
    },
  },
}

registerProviders(webProviders)

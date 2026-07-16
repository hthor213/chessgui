// Inert stand-in for the desktop shell's lib/tauri-bridge.ts, shadowed via
// this app's tsconfig exact path override ("@/lib/tauri-bridge" -> here).
//
// tournament-tab.tsx imports the bridge statically, but the tab itself is
// fenced desktop-only behind hasTournamentRunner() (false here — see
// ./platform.ts), so these stubs are unreachable at runtime. Shadowing them
// keeps @tauri-apps/api out of the web bundle — the "no Tauri deps" gate of
// spec 220 step 8. The TournamentRunner interface (spec 220, post-split)
// retires this file together with the desktop original.

export function invoke<T>(
  cmd: string,
  _args?: Record<string, unknown>,
): Promise<T> {
  return Promise.reject(
    new Error(`Tauri command "${cmd}" requires the desktop app`),
  )
}

/** Shape-compatible with @tauri-apps/api/core's Channel. Never receives
 *  messages here — nothing native exists to send them. */
export class Channel<T = unknown> {
  onmessage: (message: T) => void = () => {}
}

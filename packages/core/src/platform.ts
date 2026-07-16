// Platform provider registry (spec 220 steps 2+5). Core code (e.g.
// arena-api's token store) and the app's domain wrappers call getProviders()
// for every platform capability; the interfaces live in ./platform-types.
//
// Registration is the shell's job: a shell calls registerProviders() at boot,
// or — while the shells still share one bundle (pre step 7/8) —
// registerDefaultProviders() with a lazy factory that picks by environment
// (today: lib/platform/index.ts, the single remaining isTauri() branch).

import type { PlatformProviders } from "./platform-types"

export * from "./platform-types"

let active: PlatformProviders | null = null
let lazyDefault: (() => PlatformProviders) | null = null

/** Boot-time injection point for a shell's own implementations. */
export function registerProviders(providers: PlatformProviders): void {
  active = providers
}

/** Lazy fallback used when no shell has registered explicitly. The factory
 *  runs at most once, on the first getProviders() call. */
export function registerDefaultProviders(factory: () => PlatformProviders): void {
  lazyDefault = factory
}

export function getProviders(): PlatformProviders {
  if (!active) {
    if (!lazyDefault) {
      throw new Error(
        "No platform providers registered — the shell must call registerProviders() " +
          "or registerDefaultProviders() before any platform capability is used",
      )
    }
    active = lazyDefault()
  }
  return active
}

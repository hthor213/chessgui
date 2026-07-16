// Engine settings persisted via the platform StorageProvider (spec 220
// step 3), plus the "engine-path" key holding the user-selected engine
// binary (spec 011).

import { getProviders } from "@/lib/platform";

export interface EngineSettings {
  /** UCI Hash table size in MB. */
  hash: number;
  /** UCI Threads. */
  threads: number;
  /** Number of PV lines shown in analysis mode (play mode always uses 1). */
  multiPv: number;
  /** Draw the engine's best-move arrows on the board in analysis mode. */
  showArrows: boolean;
}

const STORAGE_KEY = "engine-settings";
const ENGINE_PATH_KEY = "engine-path";
// Bumped when a default changes in a way existing users should adopt once.
// v2: best-move arrows now default OFF. A stored blob without this version
// (or an older one) gets showArrows reset to the new default on load; the
// value only becomes authoritative again once the user explicitly saves.
const SETTINGS_VERSION = 2;

/** Fallback engine binary when the user hasn't picked one (spec 011). The
 *  path itself is the shell's knowledge — TauriProviders carries the macOS
 *  default; engine-less shells report "" (spec 220 step 2 killed the
 *  /opt/homebrew constant out of shared code). */
export function defaultEnginePath(): string {
  return getProviders().engine.defaultEnginePath;
}

// The default engine session keeps the historical bare key; a non-default
// session (spec 900's second-engine "compare" slot) persists its own pick
// under "engine-path:<session>" so the two never clobber each other.
function enginePathKey(sessionId?: string): string {
  return sessionId ? `${ENGINE_PATH_KEY}:${sessionId}` : ENGINE_PATH_KEY;
}

export function loadEnginePath(sessionId?: string): string {
  // StorageProvider absorbs the SSR/unavailable cases (returns null).
  return getProviders().storage.get(enginePathKey(sessionId)) || defaultEnginePath();
}

export function saveEnginePath(path: string, sessionId?: string): void {
  getProviders().storage.set(enginePathKey(sessionId), path);
}

export function clearEnginePath(sessionId?: string): void {
  getProviders().storage.remove(enginePathKey(sessionId));
}

export const HASH_MIN = 16;
export const HASH_MAX = 8192;
export const MULTI_PV_MIN = 1;
export const MULTI_PV_MAX = 5;

export function maxThreads(): number {
  return typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
}

export function defaultEngineSettings(): EngineSettings {
  return {
    hash: 256,
    threads: Math.min(4, maxThreads()),
    multiPv: 3,
    showArrows: false,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? Math.round(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function loadEngineSettings(): EngineSettings {
  const defaults = defaultEngineSettings();
  try {
    const raw = getProviders().storage.get(STORAGE_KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<EngineSettings> & { version?: number };
    // One-time migration: a blob from before SETTINGS_VERSION never explicitly
    // chose the new showArrows default, so ignore its stored value and reset to
    // default. Hash/Threads/Lines are preserved. Once the user saves anything,
    // the version is stamped and their showArrows choice sticks.
    const migrated = saved.version !== SETTINGS_VERSION;
    return {
      hash: clampInt(saved.hash, HASH_MIN, HASH_MAX, defaults.hash),
      threads: clampInt(saved.threads, 1, maxThreads(), defaults.threads),
      multiPv: clampInt(saved.multiPv, MULTI_PV_MIN, MULTI_PV_MAX, defaults.multiPv),
      showArrows: migrated
        ? defaults.showArrows
        : typeof saved.showArrows === "boolean"
          ? saved.showArrows
          : defaults.showArrows,
    };
  } catch {
    return defaults;
  }
}

export function saveEngineSettings(settings: EngineSettings): void {
  getProviders().storage.set(
    STORAGE_KEY,
    JSON.stringify({ ...settings, version: SETTINGS_VERSION }),
  );
}

// Engine settings persisted to localStorage, plus the "engine-path" key
// holding the user-selected engine binary (spec 011).

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

/** Fallback engine binary when the user hasn't picked one (spec 011). */
export const DEFAULT_ENGINE_PATH = "/opt/homebrew/bin/stockfish";

export function loadEnginePath(): string {
  if (typeof window === "undefined") return DEFAULT_ENGINE_PATH;
  try {
    return localStorage.getItem(ENGINE_PATH_KEY) || DEFAULT_ENGINE_PATH;
  } catch {
    return DEFAULT_ENGINE_PATH;
  }
}

export function saveEnginePath(path: string): void {
  try {
    localStorage.setItem(ENGINE_PATH_KEY, path);
  } catch {
    // localStorage unavailable — path just won't persist
  }
}

export function clearEnginePath(): void {
  try {
    localStorage.removeItem(ENGINE_PATH_KEY);
  } catch {
    // ignore
  }
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
  if (typeof window === "undefined") return defaults;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, version: SETTINGS_VERSION }));
  } catch {
    // localStorage unavailable — settings just won't persist
  }
}

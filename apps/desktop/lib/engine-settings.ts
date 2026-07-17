// Engine settings persisted via the platform StorageProvider (spec 220
// step 3), plus the "engine-path" key holding the user-selected engine
// binary (spec 011).

import { getProviders } from "@/lib/platform";

/** How analysis-mode searches are limited (spec 011): run until stopped
 *  (`go infinite`), stop at a fixed depth, or spend fixed time per position. */
export type AnalysisLimitMode = "infinite" | "depth" | "movetime";

/** A free-form UCI option (spec 011), sent verbatim as
 *  `setoption name <name> value <value>` (bare `setoption name <name>` for
 *  button options with an empty value). */
export interface CustomUciOption {
  name: string;
  value: string;
}

export interface EngineSettings {
  /** UCI Hash table size in MB. */
  hash: number;
  /** UCI Threads. */
  threads: number;
  /** Number of PV lines shown in analysis mode (play mode always uses 1). */
  multiPv: number;
  /** Draw the engine's best-move arrows on the board in analysis mode. */
  showArrows: boolean;
  /** Rank/file labels around the board (spec 001). Not an engine option, but
   *  this blob is the app's one persisted-settings surface (showArrows set
   *  the precedent). Default ON. */
  showCoordinates: boolean;
  /** Analysis search limit (spec 011). Play mode always uses clock-based go. */
  analysisMode: AnalysisLimitMode;
  /** Target depth when analysisMode is "depth". */
  analysisDepth: number;
  /** Per-position search time in ms when analysisMode is "movetime". */
  analysisMoveTimeMs: number;
  /** UCI Contempt (classic Stockfish range −100…100). 0 means "engine
   *  default" and is never sent to a fresh engine, so engines without the
   *  option (Stockfish 12+) see no unknown-option noise. */
  contempt: number;
  /** Free-form UCI options (spec 011), sent in list order on engine start. */
  customOptions: CustomUciOption[];
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
export const ANALYSIS_DEPTH_MIN = 1;
export const ANALYSIS_DEPTH_MAX = 99;
export const ANALYSIS_MOVETIME_MIN_MS = 100;
export const ANALYSIS_MOVETIME_MAX_MS = 600_000;
export const CONTEMPT_MIN = -100;
export const CONTEMPT_MAX = 100;

export function maxThreads(): number {
  return typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
}

export function defaultEngineSettings(): EngineSettings {
  return {
    hash: 256,
    threads: Math.min(4, maxThreads()),
    multiPv: 3,
    showArrows: false,
    showCoordinates: true,
    analysisMode: "infinite",
    analysisDepth: 30,
    analysisMoveTimeMs: 5000,
    contempt: 0,
    customOptions: [],
  };
}

/** Validate a stored/edited custom-option list. UCI is a line protocol, so
 *  line breaks are stripped — a crafted name/value must never smuggle a
 *  second command (e.g. "Threads value 1\ngo infinite") past setoption.
 *  Entries without a name are dropped; an empty value is kept (button
 *  options like "Clear Hash" take none). */
export function sanitizeCustomOptions(raw: unknown): CustomUciOption[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomUciOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const name = String((entry as { name?: unknown }).name ?? "")
      .replace(/[\r\n]+/g, " ")
      .trim();
    const value = String((entry as { value?: unknown }).value ?? "")
      .replace(/[\r\n]+/g, " ")
      .trim();
    if (!name) continue;
    out.push({ name, value });
  }
  return out;
}

/** setoption line for one custom option (empty value = button option). */
export function customOptionCommand(opt: CustomUciOption): string {
  return opt.value
    ? `setoption name ${opt.name} value ${opt.value}`
    : `setoption name ${opt.name}`;
}

/**
 * Whether an engine request for this tree must run in Chess960 mode
 * (spec 011). Accepts the live GameTree or its serialized form — both carry
 * the optional `variant` field; absent = standard chess.
 */
export function treeChess960(tree: { variant?: string } | null | undefined): boolean {
  return tree?.variant === "chess960";
}

/**
 * The UCI_Chess960 assertion preceding a search (spec 011): a 960 game's
 * castling moves ride as king-takes-rook UCI, which Stockfish and lc0 only
 * parse with the option set. `false` is sent only to undo an earlier `true`
 * on the same engine process — a fresh engine already defaults to false.
 */
export function chess960OptionCommand(chess960: boolean): string {
  return `setoption name UCI_Chess960 value ${chess960}`;
}

/** The `go` command analysis mode issues (spec 011). */
export function analysisGoCommand(s: EngineSettings): string {
  switch (s.analysisMode) {
    case "depth":
      return `go depth ${s.analysisDepth}`;
    case "movetime":
      return `go movetime ${s.analysisMoveTimeMs}`;
    default:
      return "go infinite";
  }
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
      // Spec 001 addition: absent in pre-existing blobs → default (ON),
      // independent of the showArrows migration above.
      showCoordinates:
        typeof saved.showCoordinates === "boolean"
          ? saved.showCoordinates
          : defaults.showCoordinates,
      // Spec 011 additions: absent in pre-existing blobs, so each falls back
      // to its default independently of the showArrows migration above.
      analysisMode:
        saved.analysisMode === "depth" || saved.analysisMode === "movetime"
          ? saved.analysisMode
          : defaults.analysisMode,
      analysisDepth: clampInt(
        saved.analysisDepth, ANALYSIS_DEPTH_MIN, ANALYSIS_DEPTH_MAX, defaults.analysisDepth),
      analysisMoveTimeMs: clampInt(
        saved.analysisMoveTimeMs, ANALYSIS_MOVETIME_MIN_MS, ANALYSIS_MOVETIME_MAX_MS, defaults.analysisMoveTimeMs),
      contempt: clampInt(saved.contempt, CONTEMPT_MIN, CONTEMPT_MAX, defaults.contempt),
      customOptions: sanitizeCustomOptions(saved.customOptions),
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

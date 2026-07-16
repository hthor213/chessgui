// The platform adapter interfaces (spec 220 step 2 — "the seam, named").
//
// Types only: nothing here may import a platform SDK or executable code.
// Each shell registers implementations at boot (lib/platform/index.ts);
// the desktop shell's is TauriProviders (lib/platform/tauri.ts), the browser
// stub is BrowserProviders (lib/platform/browser.ts, backed by the *-mock
// modules). Domain wrappers in lib/ and hooks/ call getProviders() and never
// touch @tauri-apps/* directly. When packages/core is extracted (spec 220
// step 5) this file moves there verbatim.

import type {
  CbhImportProgress,
  CbhImportReport,
  DbStats,
  GameFilter,
  GameHeader,
  ImportReport,
  PgnImportProgress,
  PositionHit,
  SaveReport,
  Sort,
} from "./database-types"
import type {
  DeckRequest,
  MoveCheck,
  PuzzleImportReport,
  PuzzleRow,
  PuzzleStats,
} from "./puzzle-types"
import type { MaiaPolicy, MaiaStatus, PersonaMove } from "./maia-types"
import type { PersonaDecision, PersonaParams } from "./persona-types"
import type { HumanSweepResult, HumanTreeOptions, HumanTreeResult } from "./human-eval-tree-types"
import type { RivalBook } from "./rival-book-types"
import type { LocalRivalPersona } from "./roster-types"
import type {
  LocalPlayerProfile,
  ProfileRunReport,
  ProfileRunRequest,
} from "./player-profile-types"
import type { BenchResult, MachineProfile } from "./machine-profile-types"
import type {
  CalibrationProgress,
  CalibrationResults,
  CalibrationSession,
  CoachFeedback,
  CoachInput,
  LineVerification,
  PlayedMoveEval,
} from "./calibration-types"
import type { ClipboardImage } from "./clipboard-types"
import type { TbProbe } from "./tablebase"

/** `start_engine`'s handshake result. */
export interface EngineStartResult {
  name: string
  ready: boolean
}

/** One output line streamed from the monthly measurement pipeline (spec 215
 *  Tier 2). The script narrates stages on stderr as `$ <cmd>` lines. */
export interface MeasureLine {
  stream: "stdout" | "stderr"
  line: string
}

/** Final report of a monthly measurement run (spec 215 Tier 2). */
export interface MeasureReport {
  /** Pipeline exit code; null means killed by a signal (i.e. cancelled). */
  exit_code: number | null
  cancelled: boolean
  /** training_metrics.json text after a successful run — merged by the
   *  frontend through the same path as a manual file import. Null on
   *  failure, cancellation, or an unreadable file. */
  metrics_json: string | null
}

/**
 * Everything that ultimately runs an engine or an engine-backed native
 * command (spec 220 "EngineProvider"): the UCI lifecycle + line stream, the
 * machine speed profile (spec 216), the persona/AI move sources (spec 213/214),
 * the Stockfish-backed puzzle check, and — until they move to a shared server
 * endpoint — the AI-proxy shell services (recognize_fen, coach_*).
 */
export interface EngineProvider {
  /** False on shells with no native engine host — UI gates on this instead
   *  of sniffing the platform. */
  readonly hasNativeEngine: boolean
  /** Shell-default engine binary (spec 220: the /opt/homebrew macOS-ism lives
   *  HERE, not in shared code; spec 222 puts Windows/Linux defaults in the
   *  same slot). Empty when the shell has no filesystem engine. */
  readonly defaultEnginePath: string

  // --- UCI lifecycle (hooks/use-engine.ts) ---
  // `context` is the spec 219 game-context tag (core/active-game.ts
  // engineContextTag): the desktop shell forwards it to the Rust UCI manager,
  // which refuses active-game-tagged commands defensively. Optional so
  // non-game callers (engine lab, tests) stay unchanged — an untagged
  // command is treated as unrestricted; the per-game scoping gate lives in
  // the use-engine hook, not here.
  //
  // `sessionId` (spec 900 multi-engine comparison, core/engine-session.ts)
  // selects which engine slot a call addresses so two engines can run side
  // by side. Optional: absent means the default session, i.e. the pre-900
  // single-engine behavior. Shells with only one engine slot (the WASM
  // worker) refuse/no-op non-default sessions rather than sharing the slot.
  startEngine(path: string, context?: string, sessionId?: string): Promise<EngineStartResult>
  sendCommand(command: string, context?: string, sessionId?: string): Promise<void>
  stopEngine(sessionId?: string): Promise<void>
  /** Subscribe to one session's stdout line stream — the app's only event
   *  stream. Resolves an unsubscribe function. Designed so a WASM worker
   *  (postMessage) or a server engine (WebSocket) can back it (spec 220). */
  onEngineLine(onLine: (line: string) => void, sessionId?: string): Promise<() => void>

  // --- Machine speed profile (spec 216, hooks/use-machine-profile.ts) ---
  machineProfileGet(): Promise<MachineProfile | null>
  machineBench(enginePath?: string | null): Promise<BenchResult>
  machineFingerprint(): Promise<string>
  /** Import another machine's profile JSON (216 Tier 2); returns the parsed profile. */
  machineProfileImport(json: string): Promise<MachineProfile>
  /** Imported remote profiles, sorted by hostname (empty where unsupported). */
  machineProfilesList(): Promise<MachineProfile[]>
  /** Remove an imported profile by hostname; no-op when absent. */
  machineProfileRemove(hostname: string): Promise<void>

  // --- Tablebase surfacing (spec 900 backlog; hooks/use-tablebase.ts) ---
  /**
   * Rich Lichess tablebase probe for the analysis panel (WDL/DTZ/DTM +
   * ranked moves). Resolves null when the position is out of tablebase
   * range (>7 men) or the lookup fails — never a rejection for those.
   * `context` is the spec 219 game-context tag: a tablebase verdict is
   * engine-class assistance, so the desktop shell's Rust side refuses
   * locked contexts defensively, mirroring the UCI commands above.
   */
  tablebaseProbe(fen: string, context?: string): Promise<TbProbe | null>

  // --- Persona / AI move sources (spec 213/214) ---
  maiaMove(fen: string, level: number): Promise<PersonaMove>
  maiaStatus(): Promise<MaiaStatus>
  maiaPolicy(fen: string, band: number): Promise<MaiaPolicy>
  personaMove(fen: string, params: PersonaParams): Promise<PersonaDecision>
  humanEvalTree(fen: string, band: number, opts?: HumanTreeOptions): Promise<HumanTreeResult>
  /**
   * Background sweep across slider stops → perception-curve points (spec 213
   * Phase 3). `onPoint` streams each band's result as it lands; starting a
   * new sweep cancels the previous one backend-side.
   */
  humanEvalSweep(
    fen: string,
    bands: number[],
    opts?: HumanTreeOptions,
    onPoint?: (p: HumanTreeResult) => void,
  ): Promise<HumanSweepResult>
  /** Cancel any in-flight perception-curve sweep (position left, panel gone). */
  humanEvalSweepCancel(): Promise<void>
  rivalBook(): Promise<RivalBook>
  rivalPersonas(): Promise<LocalRivalPersona[]>

  // --- Any-player profiles (spec 225) ---
  /** Every pipeline-built player profile present locally (gitignored
   *  data/rivals/*.profile.json + stats) — [] where absent/unsupported;
   *  absence is a normal state, never an error (spec 214 hard rule). */
  rivalProfiles(): Promise<LocalPlayerProfile[]>
  /**
   * Spawn scripts/persona/build_player_profile.py for `req` and stream its
   * output lines until it exits (the measureMonthlyRun pattern — a
   * dev-checkout desktop capability; shells without a native process host
   * reject and the UI gates on `hasNativeEngine`). Resolves with the final
   * report; a successful run carries <slug>.profile.json's text — the
   * verdict record the UI renders.
   */
  playerProfileRun(
    req: ProfileRunRequest,
    onLine?: (l: MeasureLine) => void,
  ): Promise<ProfileRunReport>
  /** Cancel the in-flight profile run; false when nothing is running. */
  playerProfileCancel(): Promise<boolean>
  /**
   * Write a generated Beat-X training plan to data/rivals/<slug>.BEAT.md
   * (gitignored — the plan names a private individual, spec 214 hard rule).
   * Resolves the absolute path written. Desktop-only; other shells reject.
   */
  saveBeatPlan(slug: string, markdown: string): Promise<string>

  // --- Stockfish-backed puzzle check (spec 211; rides the engine, not the DB) ---
  puzzleCheckMove(fen: string, uci: string, depth: number): Promise<MoveCheck | null>

  // --- Calibration sampling arm + AI-proxy shell services (spec 213) ---
  calibrationSample(
    n: number,
    opts: { dbPath?: string; stockfishPath?: string; movetimeMs?: number },
    onProgress?: (p: CalibrationProgress) => void,
  ): Promise<CalibrationSession>
  calibrationSaveResults(results: CalibrationResults): Promise<string>
  calibrationLoadResults(): Promise<CalibrationResults[]>
  coachFeedback(input: CoachInput): Promise<CoachFeedback>
  /** `opts` (line verification, 2026-07-16): the session's engine, so a line
   *  described in the rebuttal can be engine-checked before the coach replies. */
  coachFollowup(
    input: CoachInput,
    note: string,
    rebuttal: string,
    opts?: { stockfishPath?: string; movetimeMs?: number },
  ): Promise<string>
  /** Line verification, 1-PLY (2026-07-16): searchmoves-restricted engine
   *  read of the user's chosen move, same budget as the stored best-move
   *  eval. `best*` are the stored White-POV best-move scores (for the gap). */
  evalPlayedMove(
    fen: string,
    moveUci: string,
    opts?: { bestCp?: number | null; bestMate?: number | null; stockfishPath?: string; movetimeMs?: number },
  ): Promise<PlayedMoveEval>
  /** Line verification, N-PLY (2026-07-16): legality-validate + engine-walk a
   *  SAN/UCI move sequence from `fen`; per-ply White-POV evals + a verdict.
   *  An illegal move is a verdict, not a rejection. */
  verifyLine(
    fen: string,
    moves: string[],
    opts?: { stockfishPath?: string; movetimeMs?: number },
  ): Promise<LineVerification>
  recognizeFen(imageBase64: string, mediaType: string, prompt?: string): Promise<string>

  // --- Monthly measurement pipeline (spec 215 Tier 2) ---
  /**
   * Spawn scripts/measure_monthly.py (fetch → profile → Maia estimate) and
   * stream its output lines until it exits. A dev-checkout desktop
   * capability — shells without a native process host reject, and the UI
   * gates the run button on `hasNativeEngine` (the import-file path stays
   * available everywhere). Resolves with the final report; a successful run
   * carries the metrics file's text for the standard import/merge path.
   */
  measureMonthlyRun(
    opts: { user: string; skipFetch: boolean; skipMaia: boolean },
    onLine?: (l: MeasureLine) => void,
  ): Promise<MeasureReport>
  /** Cancel the in-flight run (kills the pipeline's whole process group);
   *  resolves false when nothing is running. */
  measureMonthlyCancel(): Promise<boolean>
}

/**
 * The game/puzzle database (spec 200/211): the `db_*` commands plus the
 * puzzle deck persistence. CBH import is a desktop-only capability — other
 * shells reject it, they don't stub it.
 */
export interface DatabaseProvider {
  importPgn(args: {
    source: string
    text?: string
    filePath?: string
    dbPath?: string
    onProgress?: (p: PgnImportProgress) => void
  }): Promise<ImportReport>
  importCbh(args: {
    cbhPath: string
    dbPath?: string
    onProgress?: (p: CbhImportProgress) => void
  }): Promise<CbhImportReport>
  listGames(
    filter: GameFilter,
    limit: number,
    offset: number,
    sort?: Sort,
    dbPath?: string,
  ): Promise<GameHeader[]>
  searchPosition(fen: string, limit?: number, dbPath?: string): Promise<PositionHit[]>
  getGame(id: number, dbPath?: string): Promise<string | null>
  /** Upsert one game's PGN (spec 202): annotations update the existing row
   *  when the mainline + result already exist, insert otherwise. */
  saveGame(args: { pgn: string; source?: string; dbPath?: string }): Promise<SaveReport>
  deleteGames(ids: number[], dbPath?: string): Promise<number>
  stats(dbPath?: string): Promise<DbStats>

  // --- Tags / favorites (spec 200; "favorite" is the star) ---
  addTag(id: number, tag: string, dbPath?: string): Promise<void>
  removeTag(id: number, tag: string, dbPath?: string): Promise<void>
  /** All distinct tags in use, sorted — feeds the tag filter dropdown. */
  listTags(dbPath?: string): Promise<string[]>

  // --- Avoidance puzzles (spec 211; everything but puzzle_check_move) ---
  importPuzzles(args: {
    text?: string
    filePath?: string
    dbPath?: string
  }): Promise<PuzzleImportReport>
  puzzleDeck(req: DeckRequest, dbPath?: string): Promise<PuzzleRow[]>
  getPuzzle(id: number, dbPath?: string): Promise<PuzzleRow | null>
  puzzleStats(dbPath?: string): Promise<PuzzleStats>
}

/** Native file-open dialog options (formerly lib/dialog.ts's own type). */
export interface PickFileOptions {
  /** Window title for the picker. */
  title?: string
  /** Extension filters, e.g. [{ name: "PGN", extensions: ["pgn"] }]. */
  filters?: { name: string; extensions: string[] }[]
}

/** A text file the user opened via `DialogProvider.openTextFile`. */
export interface OpenedTextFile {
  /** Basename shown to the user (browsers never expose the full path). */
  name: string
  text: string
}

/** Native file-save dialog options (spec 013 PGN export). */
export interface SaveTextFileOptions {
  /** Window title for the save dialog. */
  title?: string
  /** Suggested filename, e.g. "white_vs_black.pgn". */
  defaultName?: string
  /** Extension filters, e.g. [{ name: "PGN", extensions: ["pgn"] }]. */
  filters?: { name: string; extensions: string[] }[]
  /** MIME type for shells that save via download (browser Blob fallback). */
  mimeType?: string
  /** The file contents to write. */
  text: string
}

/** Outcome of `DialogProvider.saveTextFile`: saved=false means cancelled. */
export interface SaveTextFileResult {
  saved: boolean
  /** Absolute path written, when the shell has one (native save only). */
  path?: string
}

/**
 * File pickers and clipboard access (spec 220 "DialogProvider"): pickFile
 * resolves null when cancelled or when the shell has no native picker; the
 * clipboard readers resolve null when the clipboard has no matching content.
 *
 * openTextFile/saveTextFile (spec 013) carry the file CONTENTS across the
 * seam, so every shell can honor them: the desktop shell uses native dialogs
 * plus Rust fs commands, the browser fallback uses a programmatic
 * `<input type=file>` / Blob download. Both resolve "cancelled" (null /
 * saved:false) rather than rejecting, so callers never need an isTauri()
 * branch to decide on a fallback.
 */
export interface DialogProvider {
  pickFile(options?: PickFileOptions): Promise<string | null>
  openTextFile(options?: PickFileOptions): Promise<OpenedTextFile | null>
  saveTextFile(options: SaveTextFileOptions): Promise<SaveTextFileResult>
  readClipboardImage(): Promise<ClipboardImage | null>
  readClipboardText(): Promise<string | null>
}

/**
 * Persistent key-value settings storage (spec 220 "StorageProvider").
 * localStorage backs desktop and web; mobile WebViews get an explicit
 * adapter. All persistence routes through this (step 3): no bare
 * `localStorage` call sites exist outside the provider implementations.
 */
export interface StorageProvider {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

/**
 * The persisted active-games store (spec 219 C/D): one small JSON document
 * (core/active-game.ts `ActiveGamesStore`) holding serialized trees +
 * metadata for chess.com daily games in progress. Deliberately NOT the
 * spec 200 database — that is for finished/imported games. The desktop
 * shell keeps it in the app data dir (`active_games.json`); the browser
 * fallback uses localStorage. The provider moves raw JSON; parsing and the
 * store's invariants live in core/active-game.ts.
 */
export interface ActiveGamesProvider {
  /** The stored JSON document, or null when nothing has been saved yet. */
  load(): Promise<string | null>
  save(json: string): Promise<void>
}

/** The full set a shell registers at boot. */
export interface PlatformProviders {
  engine: EngineProvider
  database: DatabaseProvider
  dialog: DialogProvider
  storage: StorageProvider
  activeGames: ActiveGamesProvider
}

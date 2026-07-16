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
  Sort,
} from "@/lib/database"
import type {
  DeckRequest,
  MoveCheck,
  PuzzleImportReport,
  PuzzleRow,
  PuzzleStats,
} from "@/lib/puzzles"
import type { MaiaPolicy, MaiaStatus, PersonaMove } from "@/lib/maia"
import type { PersonaDecision, PersonaParams } from "@/lib/persona"
import type { HumanTreeOptions, HumanTreeResult } from "@/lib/human-eval-tree"
import type { RivalBook } from "@/lib/rival-book"
import type { LocalRivalPersona } from "@/lib/roster"
import type { BenchResult, MachineProfile } from "@/hooks/use-machine-profile"
import type {
  CalibrationProgress,
  CalibrationResults,
  CalibrationSession,
  CoachFeedback,
  CoachInput,
} from "@/lib/calibration"
import type { ClipboardImage } from "@/lib/recognize-position"

/** `start_engine`'s handshake result. */
export interface EngineStartResult {
  name: string
  ready: boolean
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
  startEngine(path: string): Promise<EngineStartResult>
  sendCommand(command: string): Promise<void>
  stopEngine(): Promise<void>
  /** Subscribe to the engine's stdout line stream — the app's only event
   *  stream. Resolves an unsubscribe function. Designed so a WASM worker
   *  (postMessage) or a server engine (WebSocket) can back it (spec 220). */
  onEngineLine(onLine: (line: string) => void): Promise<() => void>

  // --- Machine speed profile (spec 216, hooks/use-machine-profile.ts) ---
  machineProfileGet(): Promise<MachineProfile | null>
  machineBench(enginePath?: string | null): Promise<BenchResult>
  machineFingerprint(): Promise<string>

  // --- Persona / AI move sources (spec 213/214) ---
  maiaMove(fen: string, level: number): Promise<PersonaMove>
  maiaStatus(): Promise<MaiaStatus>
  maiaPolicy(fen: string, band: number): Promise<MaiaPolicy>
  personaMove(fen: string, params: PersonaParams): Promise<PersonaDecision>
  humanEvalTree(fen: string, band: number, opts?: HumanTreeOptions): Promise<HumanTreeResult>
  rivalBook(): Promise<RivalBook>
  rivalPersonas(): Promise<LocalRivalPersona[]>

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
  coachFollowup(input: CoachInput, note: string, rebuttal: string): Promise<string>
  recognizeFen(imageBase64: string, mediaType: string, prompt?: string): Promise<string>
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
  deleteGames(ids: number[], dbPath?: string): Promise<number>
  stats(dbPath?: string): Promise<DbStats>

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

/**
 * File pickers and clipboard access (spec 220 "DialogProvider"): pickFile
 * resolves null when cancelled or when the shell has no native picker; the
 * clipboard readers resolve null when the clipboard has no matching content.
 */
export interface DialogProvider {
  pickFile(options?: PickFileOptions): Promise<string | null>
  readClipboardImage(): Promise<ClipboardImage | null>
  readClipboardText(): Promise<string | null>
}

/**
 * Persistent key-value settings storage (spec 220 "StorageProvider").
 * localStorage backs desktop and web; mobile WebViews get an explicit
 * adapter. The 21 bare localStorage call sites route through this in
 * spec 220 step 3 — the interface lands here first.
 */
export interface StorageProvider {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

/** The full set a shell registers at boot. */
export interface PlatformProviders {
  engine: EngineProvider
  database: DatabaseProvider
  dialog: DialogProvider
  storage: StorageProvider
}

// BrowserProviders (spec 220 step 2): the plain-browser stub implementations,
// backed by the pre-existing *-mock.ts modules — the same fallbacks the
// domain wrappers used to reach via their own isTauri() branches. Mocks stay
// dynamically imported so they never load inside the desktop shell. Native
// capabilities with no honest mock (CBH import, human-eval tree, FEN
// recognition, machine bench) reject; they are hidden or degraded by the UI's
// capability gates, exactly as before. The real web shell (spec 221) replaces
// this with HTTP/WASM providers.

import type {
  CalibrationProgress,
  CalibrationResults,
  CalibrationSession,
  CoachFeedback,
  CoachInput,
  LineVerification,
  PlayedMoveEval,
} from "@/lib/calibration"
import type {
  CbhImportReport,
  DbStats,
  GameFilter,
  GameHeader,
  ImportReport,
  PositionHit,
  SaveReport,
  Sort,
} from "@/lib/database"
import type { HumanSweepResult, HumanTreeResult } from "@/lib/human-eval-tree"
import type { MaiaPolicy, MaiaStatus, PersonaMove } from "@/lib/maia"
import type { PersonaDecision, PersonaParams } from "@/lib/persona"
import type {
  DeckRequest,
  MoveCheck,
  PuzzleImportReport,
  PuzzleRow,
  PuzzleStats,
} from "@/lib/puzzles"
import type { ClipboardImage } from "@/lib/recognize-position"
import type { RivalBook } from "@/lib/rival-book"
import type { LocalRivalPersona } from "@/lib/roster"
import type { BenchResult, MachineProfile } from "@/hooks/use-machine-profile"
import type { TbProbe } from "@chessgui/core/tablebase"
import { readBrowserClipboardImage, readBrowserClipboardText } from "./clipboard"
import { localStorageKV } from "./storage"
import type {
  MeasureReport,
  OpenedTextFile,
  PickFileOptions,
  PlatformProviders,
  SaveTextFileOptions,
  SaveTextFileResult,
} from "@chessgui/core/platform-types"
import type {
  LocalPlayerProfile,
  ProfileRunReport,
} from "@chessgui/core/player-profile-types"

function noEngine(what: string): Promise<never> {
  return Promise.reject(new Error(`${what} requires the desktop app`))
}

/** localStorage key backing the browser-fallback active-games store. */
const ACTIVE_GAMES_BROWSER_KEY = "chessgui-active-games"

export const browserProviders: PlatformProviders = {
  engine: {
    hasNativeEngine: false,
    defaultEnginePath: "",

    startEngine: () => noEngine("The UCI engine"),
    sendCommand: () => noEngine("The UCI engine"),
    async stopEngine(): Promise<void> {
      // nothing running — a no-op keeps unmount cleanup silent
    },
    async onEngineLine(): Promise<() => void> {
      return () => {} // no engine, no lines
    },

    machineProfileGet: (): Promise<MachineProfile | null> => noEngine("The machine profile"),
    machineBench: (): Promise<BenchResult> => noEngine("The machine bench"),
    machineFingerprint: (): Promise<string> => noEngine("The machine fingerprint"),
    machineProfileImport: (): Promise<MachineProfile> => noEngine("Machine profile import"),
    // Empty, not a rejection — the browser shell renders the equivalence
    // section quietly with nothing in it.
    async machineProfilesList(): Promise<MachineProfile[]> {
      return []
    },
    machineProfileRemove: (): Promise<void> => noEngine("Machine profile removal"),

    // Null, not a rejection: "no tablebase verdict" is the quiet no-op the
    // panel already handles. A real web shell (spec 221) can back this with
    // a direct fetch to tablebase.lichess.ovh instead.
    async tablebaseProbe(): Promise<TbProbe | null> {
      return null
    },

    maiaMove(fen: string, level: number): Promise<PersonaMove> {
      return import("@/lib/maia-mock").then((m) => m.mockMaiaMove(fen, level))
    },
    async maiaStatus(): Promise<MaiaStatus> {
      return { lc0_available: false, lc0_path: null, bands: [], cached_bands: [] }
    },
    maiaPolicy: (): Promise<MaiaPolicy> => noEngine("The Maia policy"),
    personaMove(fen: string, params: PersonaParams): Promise<PersonaDecision> {
      return import("@/lib/persona-mock").then((m) => m.mockPersonaMove(fen, params))
    },
    humanEvalTree: (): Promise<HumanTreeResult> => noEngine("The human-eval tree"),
    humanEvalSweep: (): Promise<HumanSweepResult> => noEngine("The perception-curve sweep"),
    async humanEvalSweepCancel(): Promise<void> {
      // nothing to cancel — a no-op keeps unmount cleanup silent
    },
    rivalBook(): Promise<RivalBook> {
      return import("@/lib/rival-book-mock").then((m) => m.mockRivalBook())
    },
    async rivalPersonas(): Promise<LocalRivalPersona[]> {
      return [] // private rivals live in local desktop data only (spec 214)
    },

    // Any-player profiles (spec 225): same locality rule as the personas —
    // profiles exist only in local desktop data, so the honest browser answer
    // is "none", and the pipeline/plan-file writes need the desktop shell.
    async rivalProfiles(): Promise<LocalPlayerProfile[]> {
      return []
    },
    playerProfileRun: (): Promise<ProfileRunReport> => noEngine("The player profile pipeline"),
    async playerProfileCancel(): Promise<boolean> {
      return false // nothing ever runs here
    },
    saveBeatPlan: (): Promise<string> => noEngine("Writing a Beat plan file"),

    puzzleCheckMove(fen: string, uci: string, depth: number): Promise<MoveCheck | null> {
      // The mock resolves null — the HONEST "no engine here" answer.
      return import("@/lib/puzzles-mock").then((m) => m.mockPuzzles.checkMove(fen, uci, depth))
    },

    calibrationSample(
      n: number,
      _opts: { dbPath?: string; stockfishPath?: string; movetimeMs?: number },
      onProgress?: (p: CalibrationProgress) => void,
    ): Promise<CalibrationSession> {
      return import("@/lib/calibration-mock").then((m) => m.buildMockSession(n, onProgress))
    },
    async calibrationSaveResults(): Promise<string> {
      return "" // no filesystem — results only live in localStorage state
    },
    calibrationLoadResults(): Promise<CalibrationResults[]> {
      return import("@/lib/calibration-mock").then((m) => m.mockPriorResults())
    },
    coachFeedback(input: CoachInput): Promise<CoachFeedback> {
      return import("@/lib/calibration-mock").then((m) => m.mockCoachFeedback(input))
    },
    coachFollowup(_input: CoachInput, _note: string, rebuttal: string): Promise<string> {
      return import("@/lib/calibration-mock").then((m) => m.mockCoachFollowup(rebuttal))
    },
    evalPlayedMove(fen: string, moveUci: string): Promise<PlayedMoveEval> {
      return import("@/lib/calibration-mock").then((m) => m.mockPlayedMoveEval(fen, moveUci))
    },
    verifyLine(fen: string, moves: string[]): Promise<LineVerification> {
      return import("@/lib/calibration-mock").then((m) => m.mockVerifyLine(fen, moves))
    },
    recognizeFen: (): Promise<string> => noEngine("Position recognition"),

    // The run button is gated off (hasNativeEngine) — the reject is the
    // honest backstop; the import-file path stays available everywhere.
    measureMonthlyRun: (): Promise<MeasureReport> => noEngine("The monthly measurement pipeline"),
    async measureMonthlyCancel(): Promise<boolean> {
      return false // nothing ever runs here
    },
  },

  database: {
    importPgn(args): Promise<ImportReport> {
      return import("@/lib/database-mock")
        .then((m) => m.mockDatabase.importPgn(args))
        .then((report) => {
          // The mock imports in one shot; emit the single final snapshot the
          // progress UI expects (same shape lib/database.ts synthesized).
          args.onProgress?.({
            processed: report.imported + report.dups_skipped + report.errors,
            ...report,
          })
          return report
        })
    },
    importCbh(): Promise<CbhImportReport> {
      return Promise.reject(new Error("CBH import requires the desktop app"))
    },
    listGames(
      filter: GameFilter,
      limit: number,
      offset: number,
      sort?: Sort,
      dbPath?: string,
    ): Promise<GameHeader[]> {
      return import("@/lib/database-mock").then((m) =>
        m.mockDatabase.listGames(filter, limit, offset, sort, dbPath),
      )
    },
    searchPosition(fen: string, limit?: number, dbPath?: string): Promise<PositionHit[]> {
      return import("@/lib/database-mock").then((m) =>
        m.mockDatabase.searchPosition(fen, limit, dbPath),
      )
    },
    getGame(id: number, dbPath?: string): Promise<string | null> {
      return import("@/lib/database-mock").then((m) => m.mockDatabase.getGame(id, dbPath))
    },
    saveGame(args): Promise<SaveReport> {
      return import("@/lib/database-mock").then((m) => m.mockDatabase.saveGame(args))
    },
    deleteGames(ids: number[], dbPath?: string): Promise<number> {
      return import("@/lib/database-mock").then((m) => m.mockDatabase.deleteGames(ids, dbPath))
    },
    stats(dbPath?: string): Promise<DbStats> {
      return import("@/lib/database-mock").then((m) => m.mockDatabase.stats(dbPath))
    },
    addTag(id: number, tag: string, dbPath?: string): Promise<void> {
      return import("@/lib/database-mock").then((m) => m.mockDatabase.addTag(id, tag, dbPath))
    },
    removeTag(id: number, tag: string, dbPath?: string): Promise<void> {
      return import("@/lib/database-mock").then((m) =>
        m.mockDatabase.removeTag(id, tag, dbPath),
      )
    },
    listTags(dbPath?: string): Promise<string[]> {
      return import("@/lib/database-mock").then((m) => m.mockDatabase.listTags(dbPath))
    },

    importPuzzles(args): Promise<PuzzleImportReport> {
      return import("@/lib/puzzles-mock").then((m) => m.mockPuzzles.importPuzzles(args))
    },
    puzzleDeck(req: DeckRequest, dbPath?: string): Promise<PuzzleRow[]> {
      return import("@/lib/puzzles-mock").then((m) => m.mockPuzzles.deck(req, dbPath))
    },
    getPuzzle(id: number, dbPath?: string): Promise<PuzzleRow | null> {
      return import("@/lib/puzzles-mock").then((m) => m.mockPuzzles.getPuzzle(id, dbPath))
    },
    puzzleStats(dbPath?: string): Promise<PuzzleStats> {
      return import("@/lib/puzzles-mock").then((m) => m.mockPuzzles.stats(dbPath))
    },
  },

  dialog: {
    async pickFile(): Promise<string | null> {
      // No native picker; components fall back to their <input type=file>
      // paths (the real web shell wires the File System Access API, spec 221).
      return null
    },
    // Programmatic <input type=file> (spec 013): unlike pickFile, the
    // contents-based contract CAN be honored without a native dialog, so
    // callers get one code path on every shell. Synchronous up to click()
    // to stay inside the user-gesture window.
    openTextFile(options: PickFileOptions = {}): Promise<OpenedTextFile | null> {
      return new Promise((resolve) => {
        const input = document.createElement("input")
        input.type = "file"
        const exts = (options.filters ?? []).flatMap((f) => f.extensions)
        if (exts.length) input.accept = exts.map((e) => `.${e}`).join(",")
        input.onchange = () => {
          const file = input.files?.[0]
          if (!file) return resolve(null)
          file.text().then((text) => resolve({ name: file.name, text }))
        }
        // Modern engines (incl. WKWebView 16.4+) fire "cancel" on dismissal;
        // where unsupported the promise stays pending, which is harmless —
        // the caller only acts on resolution.
        input.oncancel = () => resolve(null)
        input.click()
      })
    },
    // Blob + object-URL download — the same fallback app/page.tsx's PGN
    // export used inline before the seam. Never "cancelled": the download
    // starts as soon as the anchor is clicked.
    async saveTextFile(options: SaveTextFileOptions): Promise<SaveTextFileResult> {
      const blob = new Blob([options.text], { type: options.mimeType ?? "text/plain" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = options.defaultName ?? "download.txt"
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      return { saved: true }
    },
    readClipboardImage(): Promise<ClipboardImage | null> {
      return readBrowserClipboardImage()
    },
    readClipboardText(): Promise<string | null> {
      return readBrowserClipboardText()
    },
  },

  storage: localStorageKV,

  // Active-games store (spec 219 C/D): the browser fallback keeps the one
  // JSON document in localStorage — same contract as the desktop file store.
  activeGames: {
    async load(): Promise<string | null> {
      return localStorageKV.get(ACTIVE_GAMES_BROWSER_KEY)
    },
    async save(json: string): Promise<void> {
      localStorageKV.set(ACTIVE_GAMES_BROWSER_KEY, json)
    },
  },
}

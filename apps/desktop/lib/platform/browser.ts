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
} from "@/lib/calibration"
import type {
  CbhImportReport,
  DbStats,
  GameFilter,
  GameHeader,
  ImportReport,
  PositionHit,
  Sort,
} from "@/lib/database"
import type { HumanTreeResult } from "@/lib/human-eval-tree"
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
import { readBrowserClipboardImage, readBrowserClipboardText } from "./clipboard"
import { localStorageKV } from "./storage"
import type { PlatformProviders } from "@chessgui/core/platform-types"

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
    rivalBook(): Promise<RivalBook> {
      return import("@/lib/rival-book-mock").then((m) => m.mockRivalBook())
    },
    async rivalPersonas(): Promise<LocalRivalPersona[]> {
      return [] // private rivals live in local desktop data only (spec 214)
    },

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
    recognizeFen: (): Promise<string> => noEngine("Position recognition"),
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
    deleteGames(ids: number[], dbPath?: string): Promise<number> {
      return import("@/lib/database-mock").then((m) => m.mockDatabase.deleteGames(ids, dbPath))
    },
    stats(dbPath?: string): Promise<DbStats> {
      return import("@/lib/database-mock").then((m) => m.mockDatabase.stats(dbPath))
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

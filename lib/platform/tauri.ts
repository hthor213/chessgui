// TauriProviders (spec 220 step 2): the desktop shell's implementation of the
// platform interfaces, wrapping today's invoke/listen/Channel calls verbatim.
// Together with lib/tauri-bridge.ts (the fenced tournament-tab escape hatch,
// absorbed by TournamentRunner post-split) this is the ONLY module that may
// import @tauri-apps/*. When apps/desktop exists (spec 220 step 7) this file
// moves there and registers itself at boot.

import { Channel, invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
// Runtime import into a module that imports lib/platform back — a deliberate,
// safe cycle: only a hoisted function declaration crosses it, called long
// after both modules evaluate. Kept so the test-pinned camelCase arg contract
// (treeInvokeArgs) has exactly one definition.
import { treeInvokeArgs } from "@/lib/human-eval-tree"
import type {
  CalibrationProgress,
  CalibrationResults,
  CalibrationSession,
  CoachFeedback,
  CoachInput,
} from "@/lib/calibration"
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
import type { HumanTreeOptions, HumanTreeResult } from "@/lib/human-eval-tree"
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
import type { EngineStartResult, PickFileOptions, PlatformProviders } from "./types"

/** The desktop default engine binary (spec 011). macOS-only knowledge by
 *  design — spec 222's Windows/Linux builds change THIS constant's slot, not
 *  shared code (spec 220 "Kill the /opt/homebrew constant"). */
const DESKTOP_DEFAULT_ENGINE_PATH = "/opt/homebrew/bin/stockfish"

export const tauriProviders: PlatformProviders = {
  engine: {
    hasNativeEngine: true,
    defaultEnginePath: DESKTOP_DEFAULT_ENGINE_PATH,

    startEngine(path: string): Promise<EngineStartResult> {
      return invoke<EngineStartResult>("start_engine", { path })
    },
    async sendCommand(command: string): Promise<void> {
      await invoke("send_command", { command })
    },
    async stopEngine(): Promise<void> {
      await invoke("stop_engine")
    },
    onEngineLine(onLine: (line: string) => void): Promise<() => void> {
      return listen<string>("engine-output", (event) => onLine(event.payload))
    },

    machineProfileGet(): Promise<MachineProfile | null> {
      return invoke<MachineProfile | null>("machine_profile_get")
    },
    machineBench(enginePath?: string | null): Promise<BenchResult> {
      return invoke<BenchResult>("machine_bench", { enginePath: enginePath ?? null })
    },
    machineFingerprint(): Promise<string> {
      return invoke<string>("machine_fingerprint")
    },

    maiaMove(fen: string, level: number): Promise<PersonaMove> {
      return invoke<PersonaMove>("maia_move", { fen, level })
    },
    maiaStatus(): Promise<MaiaStatus> {
      return invoke<MaiaStatus>("maia_status")
    },
    maiaPolicy(fen: string, band: number): Promise<MaiaPolicy> {
      return invoke<MaiaPolicy>("maia_policy", { fen, band })
    },
    personaMove(fen: string, params: PersonaParams): Promise<PersonaDecision> {
      return invoke<PersonaDecision>("persona_move", { fen, params })
    },
    humanEvalTree(
      fen: string,
      band: number,
      opts: HumanTreeOptions = {},
    ): Promise<HumanTreeResult> {
      return invoke<HumanTreeResult>("human_eval_tree", treeInvokeArgs(fen, band, opts))
    },
    rivalBook(): Promise<RivalBook> {
      return invoke<RivalBook>("rival_book")
    },
    rivalPersonas(): Promise<LocalRivalPersona[]> {
      return invoke<LocalRivalPersona[]>("rival_personas")
    },

    puzzleCheckMove(fen: string, uci: string, depth: number): Promise<MoveCheck | null> {
      return invoke<MoveCheck>("puzzle_check_move", { fen, uci, depth })
    },

    calibrationSample(
      n: number,
      opts: { dbPath?: string; stockfishPath?: string; movetimeMs?: number },
      onProgress?: (p: CalibrationProgress) => void,
    ): Promise<CalibrationSession> {
      const channel = new Channel<CalibrationProgress>()
      if (onProgress) channel.onmessage = onProgress
      return invoke<CalibrationSession>("calibration_sample", {
        n,
        dbPath: opts.dbPath ?? null,
        stockfishPath: opts.stockfishPath ?? null,
        movetimeMs: opts.movetimeMs ?? null,
        onProgress: channel,
      })
    },
    calibrationSaveResults(results: CalibrationResults): Promise<string> {
      return invoke<string>("calibration_save_results", { results })
    },
    calibrationLoadResults(): Promise<CalibrationResults[]> {
      return invoke<CalibrationResults[]>("calibration_load_results")
    },
    coachFeedback(input: CoachInput): Promise<CoachFeedback> {
      return invoke<CoachFeedback>("coach_feedback", { input })
    },
    coachFollowup(input: CoachInput, note: string, rebuttal: string): Promise<string> {
      return invoke<string>("coach_followup", { input, note, rebuttal })
    },
    recognizeFen(imageBase64: string, mediaType: string, prompt?: string): Promise<string> {
      return invoke<string>("recognize_fen", { imageBase64, mediaType, prompt })
    },
  },

  database: {
    importPgn(args): Promise<ImportReport> {
      const channel = new Channel<PgnImportProgress>()
      if (args.onProgress) channel.onmessage = args.onProgress
      return invoke<ImportReport>("db_import_pgn", {
        source: args.source,
        text: args.text ?? null,
        filePath: args.filePath ?? null,
        dbPath: args.dbPath ?? null,
        onProgress: channel,
      })
    },
    importCbh(args): Promise<CbhImportReport> {
      const channel = new Channel<CbhImportProgress>()
      if (args.onProgress) channel.onmessage = args.onProgress
      return invoke<CbhImportReport>("db_import_cbh", {
        cbhPath: args.cbhPath,
        dbPath: args.dbPath ?? null,
        onProgress: channel,
      })
    },
    listGames(
      filter: GameFilter,
      limit: number,
      offset: number,
      sort?: Sort,
      dbPath?: string,
    ): Promise<GameHeader[]> {
      return invoke<GameHeader[]>("db_list_games", {
        filter,
        limit,
        offset,
        sortBy: sort?.by ?? null,
        sortDir: sort?.dir ?? null,
        dbPath: dbPath ?? null,
      })
    },
    searchPosition(fen: string, limit?: number, dbPath?: string): Promise<PositionHit[]> {
      return invoke<PositionHit[]>("db_search_position", {
        fen,
        limit: limit ?? null,
        dbPath: dbPath ?? null,
      })
    },
    getGame(id: number, dbPath?: string): Promise<string | null> {
      return invoke<string | null>("db_get_game", { id, dbPath: dbPath ?? null })
    },
    deleteGames(ids: number[], dbPath?: string): Promise<number> {
      return invoke<number>("db_delete_games", { ids, dbPath: dbPath ?? null })
    },
    stats(dbPath?: string): Promise<DbStats> {
      return invoke<DbStats>("db_stats", { dbPath: dbPath ?? null })
    },

    importPuzzles(args): Promise<PuzzleImportReport> {
      return invoke<PuzzleImportReport>("puzzles_import", {
        text: args.text ?? null,
        filePath: args.filePath ?? null,
        dbPath: args.dbPath ?? null,
      })
    },
    puzzleDeck(req: DeckRequest, dbPath?: string): Promise<PuzzleRow[]> {
      return invoke<PuzzleRow[]>("puzzles_deck", {
        band: req.band,
        theme: null,
        limit: req.count,
        dbPath: dbPath ?? null,
      })
    },
    getPuzzle(id: number, dbPath?: string): Promise<PuzzleRow | null> {
      return invoke<PuzzleRow | null>("puzzles_get", { id, dbPath: dbPath ?? null })
    },
    puzzleStats(dbPath?: string): Promise<PuzzleStats> {
      return invoke<PuzzleStats>("puzzles_stats", { dbPath: dbPath ?? null })
    },
  },

  dialog: {
    async pickFile(options: PickFileOptions = {}): Promise<string | null> {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const picked = await open({ multiple: false, directory: false, ...options })
      return typeof picked === "string" && picked ? picked : null
    },
    async readClipboardImage(): Promise<ClipboardImage | null> {
      try {
        const { readImage } = await import("@tauri-apps/plugin-clipboard-manager")
        const img = await readImage()
        const { width, height } = await img.size()
        const rgba = new Uint8ClampedArray(await img.rgba())
        const canvas = document.createElement("canvas")
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext("2d")
        if (ctx) {
          ctx.putImageData(new ImageData(rgba, width, height), 0, 0)
          const dataUrl = canvas.toDataURL("image/png")
          return { base64: dataUrl.split(",")[1], mediaType: "image/png" }
        }
      } catch {
        // Plugin failed or the clipboard holds no image — try the browser API.
      }
      return readBrowserClipboardImage()
    },
    async readClipboardText(): Promise<string | null> {
      try {
        const { readText } = await import("@tauri-apps/plugin-clipboard-manager")
        const text = await readText()
        if (text && text.trim()) return text
      } catch {
        // Plugin failed or the read-text permission isn't granted.
      }
      return readBrowserClipboardText()
    },
  },

  storage: localStorageKV,
}

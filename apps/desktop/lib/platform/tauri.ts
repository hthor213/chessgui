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
import { sweepInvokeArgs, treeInvokeArgs } from "@/lib/human-eval-tree"
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
} from "@/lib/database"
import type { HumanSweepResult, HumanTreeOptions, HumanTreeResult } from "@/lib/human-eval-tree"
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
import { engineOutputEvent } from "@chessgui/core/engine-session"
import type { TbProbe } from "@chessgui/core/tablebase"
import type {
  EngineStartResult,
  MeasureLine,
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
  ProfileRunRequest,
} from "@chessgui/core/player-profile-types"

// --- Default engine path (spec 222 Tier 0) --------------------------------
// The real resolution — bundled sidecar → PATH lookup → macOS Homebrew
// constant — lives in Rust (src-tauri/src/engine_path.rs), because only the
// shell knows where the bundler dropped the sidecar. `defaultEnginePath`
// must stay a sync readonly string (spec 220 EngineProvider), so the getter
// serves a per-OS static guess until the one-shot invoke resolves the real
// answer; callers read it at interaction time (start button, settings
// dialog), long after boot, so the guess is visible for the first paint at
// most. The user-set path (spec 011 file picker) still overrides this in
// lib/engine-settings.ts — that ordering is the non-AVX2 escape hatch.
function staticDefaultEnginePath(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : ""
  if (ua.includes("Windows")) return "stockfish.exe"
  if (ua.includes("Linux")) return "stockfish"
  // macOS keeps its pre-spec-222 Homebrew default until spec 220 unifies
  // the sidecar story across all three OSes.
  return "/opt/homebrew/bin/stockfish"
}

let resolvedDefaultEnginePath: string | null = null
let defaultEnginePathRequested = false
function requestDefaultEnginePath(): void {
  if (defaultEnginePathRequested) return
  defaultEnginePathRequested = true
  try {
    invoke<string>("default_engine_path")
      .then((path) => {
        if (path) resolvedDefaultEnginePath = path
      })
      .catch(() => {
        // Pre-222 shell without the command — the static guess stands.
      })
  } catch {
    // Not inside a Tauri webview (tests import this module too).
  }
}

export const tauriProviders: PlatformProviders = {
  engine: {
    hasNativeEngine: true,
    get defaultEnginePath(): string {
      requestDefaultEnginePath()
      return resolvedDefaultEnginePath ?? staticDefaultEnginePath()
    },

    // The spec 219 game-context tag rides along so the Rust UCI manager can
    // refuse active-game contexts defensively (uci.rs context_is_locked).
    // The spec 900 session id selects which engine slot the call addresses
    // (uci.rs session_key); absent means the default (main analysis) engine.
    startEngine(path: string, context?: string, sessionId?: string): Promise<EngineStartResult> {
      return invoke<EngineStartResult>("start_engine", {
        path,
        context: context ?? null,
        session: sessionId ?? null,
      })
    },
    async sendCommand(command: string, context?: string, sessionId?: string): Promise<void> {
      await invoke("send_command", { command, context: context ?? null, session: sessionId ?? null })
    },
    async stopEngine(sessionId?: string): Promise<void> {
      await invoke("stop_engine", { session: sessionId ?? null })
    },
    onEngineLine(onLine: (line: string) => void, sessionId?: string): Promise<() => void> {
      // Per-session event name (core/engine-session.ts mirrors uci.rs).
      return listen<string>(engineOutputEvent(sessionId), (event) => onLine(event.payload))
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
    machineProfileImport(json: string): Promise<MachineProfile> {
      return invoke<MachineProfile>("machine_profile_import", { json })
    },
    machineProfilesList(): Promise<MachineProfile[]> {
      return invoke<MachineProfile[]>("machine_profiles_list")
    },
    async machineProfileRemove(hostname: string): Promise<void> {
      await invoke("machine_profile_remove", { hostname })
    },

    tablebaseProbe(fen: string, context?: string): Promise<TbProbe | null> {
      // Rides the match runner's shared probe cache/rate-limit (spec 900).
      return invoke<TbProbe | null>("tablebase_probe", { fen, context: context ?? null })
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
    humanEvalSweep(
      fen: string,
      bands: number[],
      opts: HumanTreeOptions = {},
      onPoint?: (p: HumanTreeResult) => void,
    ): Promise<HumanSweepResult> {
      const channel = new Channel<HumanTreeResult>()
      if (onPoint) channel.onmessage = onPoint
      return invoke<HumanSweepResult>("human_eval_sweep", {
        ...sweepInvokeArgs(fen, bands, opts),
        onPoint: channel,
      })
    },
    async humanEvalSweepCancel(): Promise<void> {
      await invoke("human_eval_sweep_cancel")
    },
    rivalBook(): Promise<RivalBook> {
      return invoke<RivalBook>("rival_book")
    },
    rivalPersonas(): Promise<LocalRivalPersona[]> {
      return invoke<LocalRivalPersona[]>("rival_personas")
    },

    // Any-player profiles (spec 225, src-tauri/src/player_profile.rs).
    rivalProfiles(): Promise<LocalPlayerProfile[]> {
      return invoke<LocalPlayerProfile[]>("rival_profiles")
    },
    playerProfileRun(
      req: ProfileRunRequest,
      onLine?: (l: MeasureLine) => void,
    ): Promise<ProfileRunReport> {
      const channel = new Channel<MeasureLine>()
      if (onLine) channel.onmessage = onLine
      return invoke<ProfileRunReport>("player_profile_run", { req, onLine: channel })
    },
    playerProfileCancel(): Promise<boolean> {
      return invoke<boolean>("player_profile_cancel")
    },
    saveBeatPlan(slug: string, markdown: string): Promise<string> {
      return invoke<string>("save_beat_plan", { slug, markdown })
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
    coachFollowup(
      input: CoachInput,
      note: string,
      rebuttal: string,
      opts: { stockfishPath?: string; movetimeMs?: number } = {},
    ): Promise<string> {
      return invoke<string>("coach_followup", {
        input,
        note,
        rebuttal,
        stockfishPath: opts.stockfishPath ?? null,
        movetimeMs: opts.movetimeMs ?? null,
      })
    },
    evalPlayedMove(
      fen: string,
      moveUci: string,
      opts: { bestCp?: number | null; bestMate?: number | null; stockfishPath?: string; movetimeMs?: number } = {},
    ): Promise<PlayedMoveEval> {
      return invoke<PlayedMoveEval>("eval_played_move", {
        fen,
        moveUci,
        bestCp: opts.bestCp ?? null,
        bestMate: opts.bestMate ?? null,
        stockfishPath: opts.stockfishPath ?? null,
        movetimeMs: opts.movetimeMs ?? null,
      })
    },
    verifyLine(
      fen: string,
      moves: string[],
      opts: { stockfishPath?: string; movetimeMs?: number } = {},
    ): Promise<LineVerification> {
      return invoke<LineVerification>("verify_line", {
        fen,
        moves,
        stockfishPath: opts.stockfishPath ?? null,
        movetimeMs: opts.movetimeMs ?? null,
      })
    },
    recognizeFen(imageBase64: string, mediaType: string, prompt?: string): Promise<string> {
      return invoke<string>("recognize_fen", { imageBase64, mediaType, prompt })
    },

    // Monthly measurement pipeline (spec 215 Tier 2, src-tauri/src/measure.rs).
    measureMonthlyRun(
      opts: { user: string; skipFetch: boolean; skipMaia: boolean },
      onLine?: (l: MeasureLine) => void,
    ): Promise<MeasureReport> {
      const channel = new Channel<MeasureLine>()
      if (onLine) channel.onmessage = onLine
      return invoke<MeasureReport>("measure_monthly_run", {
        user: opts.user,
        skipFetch: opts.skipFetch,
        skipMaia: opts.skipMaia,
        onLine: channel,
      })
    },
    measureMonthlyCancel(): Promise<boolean> {
      return invoke<boolean>("measure_monthly_cancel")
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
    cancelCbhImport(): Promise<void> {
      return invoke("db_cancel_cbh_import")
    },
    mergeDatabase(args): Promise<ImportReport> {
      const channel = new Channel<PgnImportProgress>()
      if (args.onProgress) channel.onmessage = args.onProgress
      return invoke<ImportReport>("db_merge_from", {
        sourcePath: args.sourcePath,
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
    saveGame(args): Promise<SaveReport> {
      return invoke<SaveReport>("db_save_game", {
        pgn: args.pgn,
        source: args.source ?? null,
        dbPath: args.dbPath ?? null,
      })
    },
    deleteGames(ids: number[], dbPath?: string): Promise<number> {
      return invoke<number>("db_delete_games", { ids, dbPath: dbPath ?? null })
    },
    stats(dbPath?: string): Promise<DbStats> {
      return invoke<DbStats>("db_stats", { dbPath: dbPath ?? null })
    },
    addTag(id: number, tag: string, dbPath?: string): Promise<void> {
      return invoke<void>("db_add_tag", { id, tag, dbPath: dbPath ?? null })
    },
    removeTag(id: number, tag: string, dbPath?: string): Promise<void> {
      return invoke<void>("db_remove_tag", { id, tag, dbPath: dbPath ?? null })
    },
    listTags(dbPath?: string): Promise<string[]> {
      return invoke<string[]>("db_list_tags", { dbPath: dbPath ?? null })
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
        maxPly: req.maxPly ?? null,
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
    // Native open picker + Rust read (spec 013 PGN import): the webview
    // can't read a picked path itself, so the contents cross via IPC
    // (src-tauri/src/files.rs read_text_file, 32MB cap).
    async openTextFile(options: PickFileOptions = {}): Promise<OpenedTextFile | null> {
      const path = await tauriProviders.dialog.pickFile(options)
      if (!path) return null // cancelled
      const text = await invoke<string>("read_text_file", { path })
      return { name: path.split("/").pop() || path, text }
    },
    // Native save dialog + Rust write (spec 013 PGN export). saved:false
    // means the user cancelled — callers show no status and do nothing.
    async saveTextFile(options: SaveTextFileOptions): Promise<SaveTextFileResult> {
      const { save } = await import("@tauri-apps/plugin-dialog")
      const path = await save({
        title: options.title,
        defaultPath: options.defaultName,
        filters: options.filters,
      })
      if (!path) return { saved: false }
      await invoke("write_text_file", { path, text: options.text })
      return { saved: true, path }
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

  // Active-games store (spec 219 C/D): raw JSON persisted by the Rust side
  // at <app_data_dir>/active_games.json (src-tauri/src/active_games.rs).
  activeGames: {
    load(): Promise<string | null> {
      return invoke<string | null>("active_games_load")
    },
    async save(json: string): Promise<void> {
      await invoke("active_games_save", { json })
    },
  },
}

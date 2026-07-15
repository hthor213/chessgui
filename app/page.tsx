"use client"

import { useEffect, useState, useCallback, useMemo, useRef } from "react"
import dynamic from "next/dynamic"
import { TooltipProvider } from "@/components/ui/tooltip"
import { MoveList } from "@/components/move-list"
import { AnnotationBar } from "@/components/annotation-bar"
import { EvalGraph } from "@/components/eval-graph"
import { AnalysisPanel } from "@/components/analysis-panel"
import { EvalBar } from "@/components/eval-bar"
import { PromotionDialog } from "@/components/promotion-dialog"
import { PgnImportDialog } from "@/components/pgn-import-dialog"
import { PositionEditorDialog } from "@/components/position-editor-dialog"
import { ErrorBoundary } from "@/components/error-boundary"
import { CapturedPieces } from "@/components/captured-pieces"
import { computeMaterial } from "@/lib/material"
import { TournamentTab } from "@/components/tournament-tab"
import { DatabaseTab } from "@/components/database-tab"
import { CalibrationTab } from "@/components/calibration-tab"
import { SparTab } from "@/components/spar-tab"
import { TrainingTab } from "@/components/training-tab"
import { parsePgnToTrees } from "@/lib/pgn"
import { useChessGame, type GameState } from "@/hooks/use-chess-game"
import { useEngine } from "@/hooks/use-engine"
import { readClipboardImage, readClipboardText, imageToFen, type ClipboardImage } from "@/lib/recognize-position"
import { uciToArrow } from "@/lib/uci-parser"
import type { LiveGame, ViewerControls } from "@/lib/tournament"
import { MOVE_DELAY_OPTIONS } from "@/lib/tournament"
import type { Key } from "@lichess-org/chessground/types"
import type { DrawShape } from "@lichess-org/chessground/draw"

// Best-move arrow brushes by MultiPV rank: #1 solid blue, #2/#3 fainter.
const PV_ARROW_BRUSHES = ["blue", "paleBlue", "paleGrey"]
// Slim arrows (Chessground's default lineWidth is ~10, which reads as fat on
// our board). #1 a touch bolder than the alternatives.
const PV_ARROW_WIDTHS = [6, 5, 4]

const Board = dynamic(
  () => import("@/components/board").then((m) => ({ default: m.Board })),
  { ssr: false }
)

export default function Home() {
  const game = useChessGame()

  const handleBestMove = useCallback(
    (uciMove: string) => {
      game.playUciMove(uciMove)
    },
    [game.playUciMove],
  )

  const atLatestMove = game.currentMoveIndex === game.moves.length - 1
  const engine = useEngine(game.fen, handleBestMove, atLatestMove, game.uciMoves, game.startFen, game.currentMoveIndex)

  // Load a game from the database onto the board and switch to analysis.
  const handleLoadFromDatabase = useCallback(
    (pgn: string) => {
      const trees = parsePgnToTrees(pgn)
      if (trees.length === 0) return
      game.loadTree(trees[0])
      setView("board")
      engine.setPlayMode(false)
    },
    [game.loadTree, engine.setPlayMode],
  )

  // Load a bare position from the calibration results onto the analyze board.
  const handleLoadCalibrationPosition = useCallback(
    (fen: string) => {
      game.loadFen(fen)
      engine.setPlayMode(false)
      setView("board")
    },
    [game.loadFen, engine.setPlayMode],
  )
  const turn = game.fen.includes(" w ") ? ("white" as const) : ("black" as const)

  // Captured pieces + point balance, derived from the current node's FEN so it
  // tracks tree navigation, and diffed against startFen so custom start
  // positions (position editor) count correctly. Rows follow the board
  // orientation: the bottom tray belongs to the player at the bottom.
  const material = useMemo(() => computeMaterial(game.fen), [game.fen])
  const bottomColor = game.orientation
  const topColor = bottomColor === "white" ? ("black" as const) : ("white" as const)
  const isPlayMode = engine.state.mode === "play"
  const playerColor = engine.state.playerColor
  const [boardSize, setBoardSize] = useState(560)
  const [view, setView] = useState<"board" | "tournament" | "thinking" | "database" | "learn">("board")
  // Sub-view within the Learn tab: eval calibration, persona sparring (spec 214),
  // or the training program (spec 215). The program launches into the first two.
  const [learnSub, setLearnSub] = useState<"calibrate" | "spar" | "training">("calibrate")
  // Thinking mode has its own board instance; keep its size separate so the
  // hidden main board (kept mounted) can't clobber it.
  const [thinkingBoardSize, setThinkingBoardSize] = useState(560)
  const [tournamentRunning, setTournamentRunning] = useState(false)
  const [liveGame, setLiveGame] = useState<LiveGame | null>(null)
  // Whether to show the eval bar beside the live tournament board (driven by the
  // Tournament tab's "show evaluation bar" option).
  const [liveEvalBar, setLiveEvalBar] = useState(false)
  // Live-viewer control surface (Stop / Pause / auto-start / delay), published by
  // the Tournament tab while a run is live.
  const [viewerControls, setViewerControls] = useState<ViewerControls | null>(null)
  // Bumped by "Play this out": tells the Tournament tab to preset itself to
  // Current-position mode (engines fight over the board's position).
  const [tournamentPresetNonce, setTournamentPresetNonce] = useState(0)
  // Watch a live engine-vs-engine game on the board while a tournament runs.
  const liveViewing = view === "board" && tournamentRunning
  // Starting a run auto-switches to the board so the live game is on screen.
  const prevRunning = useRef(false)
  useEffect(() => {
    if (tournamentRunning && !prevRunning.current) setView("board")
    prevRunning.current = tournamentRunning
  }, [tournamentRunning])
  const [pgnDialogOpen, setPgnDialogOpen] = useState(false)
  const [pgnInitialText, setPgnInitialText] = useState("")
  const [editorOpen, setEditorOpen] = useState(false)
  const [pasteStatus, setPasteStatus] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  // Force re-render during play mode so the active clock visually ticks
  useEffect(() => {
    if (!isPlayMode) return;
    const interval = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(interval);
  }, [isPlayMode]);

  // Calculate live clock display
  const isEngineTurn = isPlayMode && turn !== playerColor;
  const engineBaseTime = playerColor === "white" ? engine.clockRef.current.btime : engine.clockRef.current.wtime;
  
  const timeSpentThisTurn = isPlayMode ? Math.max(0, now - engine.turnStartTimeRef.current) : 0;
  
  const engineLiveTime = isEngineTurn ? Math.max(0, engineBaseTime - timeSpentThisTurn) : engineBaseTime;
  const humanLiveTime = !isEngineTurn ? timeSpentThisTurn : 0;

  // Engine best-move arrows (analysis mode only — no hints while playing or
  // in thinking mode). uciToArrow legality-checks each move, so PV lines that
  // briefly belong to a previous position simply draw nothing.
  const engineArrows = useMemo<DrawShape[]>(() => {
    if (!engine.settings.showArrows || !engine.state.isAnalyzing || isPlayMode) return []
    const shapes: DrawShape[] = []
    for (const line of engine.state.lines) {
      if (line.multipv > PV_ARROW_BRUSHES.length || line.uciMoves.length === 0) continue
      const arrow = uciToArrow(game.fen, line.uciMoves[0])
      if (arrow) {
        shapes.push({
          orig: arrow.orig as Key,
          dest: arrow.dest as Key,
          brush: PV_ARROW_BRUSHES[line.multipv - 1],
          modifiers: { lineWidth: PV_ARROW_WIDTHS[line.multipv - 1] },
        })
      }
    }
    return shapes
  }, [engine.settings.showArrows, engine.state.isAnalyzing, engine.state.lines, isPlayMode, game.fen])

  // User-drawn arrows/circles saved on the current node (spec 202). Chessground
  // keeps these (drawable.shapes) separate from the engine's autoShapes.
  const userShapes = useMemo<DrawShape[]>(
    () =>
      game.currentNode.arrows.map((a) => ({
        orig: a.orig as Key,
        dest: a.dest as Key | undefined,
        brush: a.brush,
      })),
    [game.currentNode, game.treeVersion],
  )

  const handleShapesChange = useCallback(
    (shapes: DrawShape[]) => {
      game.setArrows(
        game.currentNodeId,
        shapes.map((s) => ({ orig: s.orig, dest: s.dest, brush: s.brush ?? "green" })),
      )
    },
    [game.setArrows, game.currentNodeId],
  )

  // Auto-save the engine's best-line eval onto the node it analyzed (spec 202)
  // so the eval graph fills in as you step through. analysisFen gates out
  // stale lines from the previous position; scoreTurn normalizes the UCI
  // side-to-move score to White's perspective. Accept depth >= 6 so a fresh
  // eval lands quickly while stepping; deeper reads overwrite it as the search
  // grows (setEval refuses to downgrade a deeper stored eval).
  useEffect(() => {
    if (isPlayMode || !engine.state.isAnalyzing) return
    if (engine.state.analysisFen !== game.fen) return
    const best = engine.state.lines.find((l) => l.multipv === 1)
    if (!best || best.depth < 6) return
    const flip = engine.state.scoreTurn === "white" ? 1 : -1
    game.setEval(
      game.currentNodeId,
      best.score.type === "mate"
        ? { mate: best.score.value * flip, depth: best.depth }
        : { cp: best.score.value * flip, depth: best.depth },
    )
  }, [engine.state.lines, engine.state.analysisFen, engine.state.isAnalyzing, engine.state.scoreTurn, isPlayMode, game.fen, game.currentNodeId, game.setEval])

  const formatClock = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
    const s = (totalSeconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  // Enter "thinking mode": load a position and show only the board + eval bar,
  // with the engine evaluating silently (no lines, no move list). Used after
  // pasting a screenshot of a position — think through it yourself, the bar
  // only tells you how it's going. The game that was on the board is
  // snapshotted so Exit can bring it back.
  const preThinkingGame = useRef<GameState | null>(null)
  const enterThinkingMode = useCallback(
    async (fen: string) => {
      preThinkingGame.current = game.getSnapshot()
      game.loadFen(fen)
      setView("thinking")
      if (!engine.state.isRunning) {
        await engine.startEngine()
      } else {
        await engine.setPlayMode(false)
      }
    },
    [game.getSnapshot, game.loadFen, engine.startEngine, engine.setPlayMode, engine.state.isRunning],
  )

  // Leave thinking mode and restore the pre-paste game.
  const exitThinkingMode = useCallback(() => {
    if (preThinkingGame.current) {
      game.restoreSnapshot(preThinkingGame.current)
      preThinkingGame.current = null
    }
    setView("board")
  }, [game.restoreSnapshot])

  // A pasted screenshot means "read this position and let me think about it" —
  // recognize it (Claude vision) and enter thinking mode. Used by global ⌘V
  // and by image pastes inside the Import and Set-up dialogs.
  const recognizeImage = useCallback(
    async (image: ClipboardImage) => {
      setPasteStatus("Reading position from image…")
      try {
        const fen = await imageToFen(image)
        setPasteStatus(null)
        await enterThinkingMode(fen)
      } catch (err) {
        setPasteStatus(err instanceof Error ? err.message : "Couldn't read a position from the image")
        setTimeout(() => setPasteStatus(null), 5000)
      }
    },
    [enterThinkingMode],
  )

  // ⌘V outside inputs: image on the clipboard → recognition (thinking mode);
  // otherwise open the PGN/FEN import dialog, pre-filled with clipboard text
  // when there is any. Image always wins over text so screenshot-paste keeps
  // going to vision.
  const handlePaste = useCallback(async () => {
    const image = await readClipboardImage()
    if (image) {
      await recognizeImage(image)
      return
    }
    const text = await readClipboardText()
    setPgnInitialText(text ?? "")
    setPgnDialogOpen(true)
  }, [recognizeImage])

  // Export the current game as a PGN: copy to clipboard (best-effort) and
  // download a .pgn file. Native Tauri save dialog is a later enhancement; the
  // webview download works in both the app and a plain browser.
  const handleExport = useCallback(async () => {
    const pgn = game.exportPgn()
    let copied = false
    try {
      await navigator.clipboard.writeText(pgn)
      copied = true
    } catch {
      // clipboard write blocked — the file download still happens
    }
    const white = game.headers.White
    const black = game.headers.Black
    const base = white || black ? `${white || "white"}_vs_${black || "black"}` : "game"
    const name = `${base.replace(/[^\w.-]+/g, "_")}.pgn`
    const blob = new Blob([pgn], { type: "application/x-chess-pgn" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setPasteStatus(copied ? "PGN exported (copied to clipboard)" : "PGN exported")
    setTimeout(() => setPasteStatus(null), 3000)
  }, [game.exportPgn, game.headers])

  // Test hook for headless UI verification (see .claude/skills/verify) —
  // paste can't be driven through Tauri from Playwright.
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__enterThinkingMode = enterThinkingMode
  }, [enterThinkingMode])

  // Drag-and-drop a .pgn file onto the window → open the import dialog
  // pre-filled with its contents (reuses the multi-game selector).
  useEffect(() => {
    const onDragOver = (e: DragEvent) => e.preventDefault()
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer?.files?.[0]
      if (!file) return
      if (!/\.pgn$/i.test(file.name) && file.type !== "application/x-chess-pgn") return
      file.text().then((text) => {
        setPgnInitialText(text)
        setPgnDialogOpen(true)
      })
    }
    window.addEventListener("dragover", onDragOver)
    window.addEventListener("drop", onDrop)
    return () => {
      window.removeEventListener("dragover", onDragOver)
      window.removeEventListener("drop", onDrop)
    }
  }, [])

  // Auto-flip board when starting a game as black
  useEffect(() => {
    if (isPlayMode) {
      game.setOrientation(playerColor)
    }
  }, [isPlayMode, playerColor])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey

      // Never intercept typing: if focus is in any editable element, every
      // key (including Space, f, arrows, Cmd+Z) belongs to that element.
      const el = e.target as HTMLElement | null
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      ) {
        return
      }

      // The Learn view (calibration) owns its own keys; the analyze-board
      // shortcuts must not act on the hidden board behind it.
      if (view === "learn") return

      // While watching a live tournament game, the live viewer owns the arrow
      // keys (ply nav); don't also drive the hidden analyze board.
      if (liveViewing && !meta) return

      if (meta && e.key === "v") {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag !== "INPUT" && tag !== "TEXTAREA") {
          // With a dialog open, let the native paste event reach the
          // dialog's own onPaste handler (image paste in Import/Set up).
          if (!pgnDialogOpen && !editorOpen) {
            e.preventDefault()
            handlePaste()
          }
          return
        }
      }

      if (meta && e.key === "e") {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag !== "INPUT" && tag !== "TEXTAREA") {
          e.preventDefault()
          setEditorOpen(true)
          return
        }
      }

      if (e.key === "ArrowLeft" || (meta && e.key === "z" && !e.shiftKey)) {
        e.preventDefault()
        const isUndo = meta && e.key === "z" // Cmd+Z = take-back; ArrowLeft = review
        if (isPlayMode && isUndo) {
          // Take-back: revert to the user's turn, deleting the taken-back moves.
          engine.cancelThinking()
          engine.turnStartTimeRef.current = Date.now()
          game.takeBack(playerColor)
        } else {
          // Arrow-left review (both modes) steps back one ply, non-destructive.
          if (isPlayMode) engine.cancelThinking()
          game.goToMove(game.currentMoveIndex - 1)
        }
      } else if (
        e.key === "ArrowRight" ||
        (meta && e.key === "z" && e.shiftKey)
      ) {
        e.preventDefault()
        game.goToMove(game.currentMoveIndex + 1)
      } else if (e.key === "ArrowUp") {
        // Move to the previous sibling variation at this branch point.
        e.preventDefault()
        game.cycleVariation(-1)
      } else if (e.key === "ArrowDown") {
        // Move to the next sibling variation at this branch point.
        e.preventDefault()
        game.cycleVariation(1)
      } else if (e.key === "Home") {
        e.preventDefault()
        game.goToMove(-1)
      } else if (e.key === "End") {
        e.preventDefault()
        game.goToMove(game.moves.length - 1)
      } else if (meta && e.key === "n") {
        e.preventDefault()
        game.newGame()
        engine.stopEngine()
      } else if (e.key === " ") {
        e.preventDefault()
        if (engine.state.isRunning) {
          engine.toggleAnalysis()
        }
      } else if (e.key === "f" || e.key === "F") {
        if (!meta) {
          game.flipBoard()
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [game.currentMoveIndex, game.moves.length, game.goToMove, game.cycleVariation, game.flipBoard, isPlayMode, playerColor, handlePaste, pgnDialogOpen, editorOpen, liveViewing, view])

  return (
    <ErrorBoundary>
    <TooltipProvider>
      <div className="h-screen flex flex-col bg-[#0a0a0a]">
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-3 border-b border-white/10">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold tracking-tight text-foreground">
              ChessGUI
            </span>
            <span className="text-[11px] text-muted-foreground font-mono" title="version · commit · build date">
              v{process.env.NEXT_PUBLIC_APP_VERSION} · {process.env.NEXT_PUBLIC_BUILD_INFO}
            </span>
          </div>
          <nav className="flex items-center gap-1">
            <button
              className={`px-3 py-1.5 text-base transition-colors rounded-md hover:bg-white/5 ${
                view === "board" && (tournamentRunning || isPlayMode) ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => {
                setView("board")
                // Don't start a human game while a tournament is in progress —
                // just switch to the board to watch the live engine game.
                if (!tournamentRunning) engine.setPlayMode(true, playerColor)
              }}
              title={tournamentRunning ? "Watch the live tournament game" : "Play against Stockfish"}
            >
              {tournamentRunning ? "View" : "Play"}
            </button>
            <button
              className={`px-3 py-1.5 text-base transition-colors rounded-md hover:bg-white/5 ${
                view === "board" && engine.state.isRunning && !isPlayMode ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => {
                setView("board")
                engine.setPlayMode(false)
              }}
              title="Analyze the current position with Stockfish"
            >
              Analyze
            </button>
            <button
              className={`px-3 py-1.5 text-base transition-colors rounded-md hover:bg-white/5 ${
                view === "tournament" ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setView("tournament")}
              title="Run headless engine-vs-engine tournaments"
            >
              Tournament
            </button>
            <button
              className={`px-3 py-1.5 text-base transition-colors rounded-md hover:bg-white/5 ${
                view === "database" ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setView("database")}
              title="Browse the game database and search positions"
            >
              Database
            </button>
            {view === "thinking" && (
              <button className="px-3 py-1.5 text-base rounded-md text-foreground font-medium bg-white/5" title="Thinking mode — board and eval bar only">
                Thinking
              </button>
            )}
            <button
              className={`px-3 py-1.5 text-base transition-colors rounded-md hover:bg-white/5 ${
                view === "learn" ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setView("learn")}
              title="Eval calibration — judge positions by eye and compare to Stockfish"
            >
              Learn
            </button>
          </nav>
          <div className="flex items-center gap-2">
            <div className="relative w-8 h-8 rounded-full bg-secondary flex items-center justify-center">
              <span className="text-xs font-medium text-foreground">H</span>
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-[#0a0a0a] animate-pulse" />
            </div>
          </div>
        </header>

        {/* Transient status for image-paste recognition */}
        {pasteStatus && (
          <div className="px-6 py-1.5 text-sm text-amber-200 bg-amber-900/30 border-b border-amber-700/30">
            {pasteStatus}
          </div>
        )}

        {/* Tournament view — kept mounted so a running batch survives switching
            to the board to watch a live game. */}
        <main
          className="flex-1 min-h-0"
          style={view === "tournament" ? undefined : { display: "none" }}
        >
          <TournamentTab
            onRunningChange={setTournamentRunning}
            onLiveUpdate={setLiveGame}
            onEvalBarChange={setLiveEvalBar}
            onViewerControls={setViewerControls}
            onOpenGame={handleLoadFromDatabase}
            currentFen={game.fen}
            bottomColor={game.orientation}
            presetNonce={tournamentPresetNonce}
          />
        </main>

        {/* Database view — game list, filters, position search. Mounted only
            when active; it re-fetches on mount, which is cheap. The explorer
            panel plays moves straight onto the board's current game. */}
        {view === "database" && (
          <main className="flex-1 min-h-0">
            <DatabaseTab
              currentFen={game.fen}
              onLoadGame={handleLoadFromDatabase}
              onPlayMove={game.playUciMove}
            />
          </main>
        )}

        {/* Learn view — eval calibration + persona sparring. Mounted only when
            active; a small sub-nav switches between the two. */}
        {view === "learn" && (
          <main className="flex-1 min-h-0 flex flex-col">
            <div className="px-6 pt-3 flex items-center gap-1 border-b border-white/10">
              <button
                data-testid="learn-sub-calibrate"
                onClick={() => setLearnSub("calibrate")}
                className={`px-3 py-1.5 text-sm rounded-t-md transition-colors ${
                  learnSub === "calibrate"
                    ? "text-foreground font-medium border-b-2 border-emerald-500"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Eval calibration
              </button>
              <button
                data-testid="learn-sub-spar"
                onClick={() => setLearnSub("spar")}
                className={`px-3 py-1.5 text-sm rounded-t-md transition-colors ${
                  learnSub === "spar"
                    ? "text-foreground font-medium border-b-2 border-emerald-500"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Spar vs Dad (beta)
              </button>
              <button
                data-testid="learn-sub-training"
                onClick={() => setLearnSub("training")}
                className={`px-3 py-1.5 text-sm rounded-t-md transition-colors ${
                  learnSub === "training"
                    ? "text-foreground font-medium border-b-2 border-emerald-500"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Training
              </button>
            </div>
            <div className="flex-1 min-h-0">
              {learnSub === "calibrate" ? (
                <CalibrationTab onLoadPosition={handleLoadCalibrationPosition} />
              ) : learnSub === "spar" ? (
                <SparTab />
              ) : (
                <TrainingTab onLaunch={setLearnSub} />
              )}
            </div>
          </main>
        )}

        {/* Live tournament game viewer */}
        {liveViewing && (
          <main className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 p-4">
            <LiveGameView live={liveGame} showEvalBar={liveEvalBar} controls={viewerControls} />
          </main>
        )}

        {/* Thinking mode — just the position and an eval bar, nothing else.
            Engine lines stay hidden: you do the thinking, the bar keeps score. */}
        {view === "thinking" && (
          <main className="flex-1 min-h-0 p-4">
            <div className="relative h-full w-full flex items-center justify-center gap-3 overflow-hidden">
              <div
                className="shrink-0"
                style={{ height: thinkingBoardSize + 26, paddingBottom: 26 }}
              >
                <EvalBar
                  score={
                    engine.state.lines.find((l) => l.multipv === 1)?.score ?? {
                      type: "cp",
                      value: 0,
                    }
                  }
                  turn={engine.state.scoreTurn ?? turn}
                  width={32}
                />
              </div>
              <Board
                fen={game.fen}
                orientation={game.orientation}
                movableColor="both"
                onMove={game.onMove}
                legalMoves={game.legalMoves}
                lastMove={game.lastMove}
                onBoardSize={setThinkingBoardSize}
              >
                {game.pendingPromotion && (
                  <PromotionDialog
                    promotion={game.pendingPromotion}
                    orientation={game.orientation}
                    boardSize={thinkingBoardSize}
                    onConfirm={game.confirmPromotion}
                    onCancel={game.cancelPromotion}
                  />
                )}
              </Board>
              {/* Minimal controls: explore lines with both sides, back up, retry */}
              <div className="absolute bottom-0 left-1/2 -translate-x-1/2 flex items-center gap-1">
                <button
                  className="px-3 py-1 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5"
                  onClick={() => game.goToMove(game.currentMoveIndex - 1)}
                  title="Take back a move (←)"
                >
                  ◀ Undo
                </button>
                <button
                  className="px-3 py-1 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5"
                  onClick={() => game.goToMove(game.currentMoveIndex + 1)}
                  title="Replay a move (→)"
                >
                  Redo ▶
                </button>
                <button
                  className="px-3 py-1 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5"
                  onClick={() => game.goToMove(-1)}
                  title="Back to the pasted position (Home)"
                >
                  Start over
                </button>
                <button
                  className="px-3 py-1 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5"
                  onClick={() => game.flipBoard()}
                  title="Flip board (F)"
                >
                  Flip
                </button>
                <button
                  className="px-3 py-1 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5"
                  onClick={exitThinkingMode}
                  title="Leave thinking mode and restore the game you had before pasting"
                >
                  Exit
                </button>
              </div>
            </div>
          </main>
        )}

        {/* Main content - three-column grid */}
        <main
          className="flex-1 grid grid-cols-[220px_1fr_220px] gap-4 p-4 min-h-0"
          style={view !== "board" || liveViewing ? { display: "none" } : undefined}
        >
          {/* Left column: Player Panel */}
          <div className="flex flex-col gap-4">
            {/* Opponent card (top of board) */}
            <div className="bg-secondary/40 backdrop-blur-md border border-white/10 rounded-lg p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
                  <span className="text-sm font-medium">
                    {isPlayMode ? "SF" : "B"}
                  </span>
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {isPlayMode
                      ? engine.state.engineName || "Stockfish"
                      : game.headers["Black"] || "Black"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {isPlayMode
                      ? `Engine (${playerColor === "white" ? "Black" : "White"})`
                      : game.headers["BlackElo"] || "---"}
                  </p>
                </div>
              </div>
              <div className="mt-3 text-2xl font-mono text-foreground text-center tracking-wider">
                {isPlayMode ? formatClock(engineLiveTime) : "--:--"}
              </div>
            </div>

            {/* Pieces the top player has captured (+x when ahead on points) */}
            <CapturedPieces
              testId="captured-top"
              captured={topColor === "white" ? material.capturedByWhite : material.capturedByBlack}
              points={material.advantage === topColor ? material.points : 0}
            />

            {/* Game info */}
            {game.headers["White"] && (
              <div className="bg-secondary/40 backdrop-blur-md border border-white/10 rounded-lg p-3">
                <p className="text-sm font-semibold text-[#bababa]">
                  {game.headers["White"]} vs {game.headers["Black"] || "?"}
                </p>
                {(game.headers["Event"] ||
                  game.headers["Date"] ||
                  game.headers["Result"]) && (
                  <p className="text-xs text-muted-foreground">
                    {[
                      game.headers["Event"],
                      game.headers["Date"],
                      game.headers["Result"],
                    ]
                      .filter(Boolean)
                      .join(" \u2022 ")}
                  </p>
                )}
              </div>
            )}

            {/* Game status (check / checkmate / draw). Lives in the left
                column between the two clocks so it never resizes the board
                when it appears/disappears. mt-auto pins it above the bottom
                clock, in the flexible space below the top clock. */}
            {game.status.label && (
              <div
                className={`mt-auto shrink-0 px-3 py-2 rounded-lg text-sm font-semibold text-center ${
                  game.status.over
                    ? "bg-red-900/60 text-red-100 border border-red-700/50"
                    : "bg-amber-900/40 text-amber-200 border border-amber-700/40"
                }`}
              >
                {game.status.label}
              </div>
            )}

            {/* Pieces the bottom player has captured. mt-auto keeps this row
                pinned directly above the bottom clock (the status banner's own
                mt-auto still floats it in the space above). */}
            <div className="mt-auto">
              <CapturedPieces
                testId="captured-bottom"
                captured={bottomColor === "white" ? material.capturedByWhite : material.capturedByBlack}
                points={material.advantage === bottomColor ? material.points : 0}
              />
            </div>

            {/* Player card (bottom of board) */}
            <div className="bg-secondary/40 backdrop-blur-md border border-white/10 rounded-lg p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
                  <span className="text-sm font-medium">
                    {isPlayMode ? "You" : game.headers["White"]?.[0] || "W"}
                  </span>
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {isPlayMode
                      ? `You (${playerColor === "white" ? "White" : "Black"})`
                      : game.headers["White"] || "White"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {isPlayMode ? "" : game.headers["WhiteElo"] || "---"}
                  </p>
                </div>
              </div>
              <div className="mt-3 text-2xl font-mono text-foreground text-center tracking-wider opacity-80">
                {isPlayMode ? formatClock(humanLiveTime) : "--:--"}
              </div>
            </div>
          </div>

          {/* Center column: Board */}
          <div className="flex flex-col items-center gap-4 min-h-0 overflow-hidden">
            <div className="flex-1 flex items-center justify-center w-full overflow-hidden">
              <Board
                fen={game.fen}
                orientation={game.orientation}
                movableColor={isPlayMode ? playerColor : "both"}
                onMove={game.onMove}
                legalMoves={
                  isPlayMode && turn !== playerColor ? new Map() : game.legalMoves
                }
                lastMove={game.lastMove}
                onBoardSize={setBoardSize}
                autoShapes={engineArrows}
                userShapes={userShapes}
                onShapesChange={handleShapesChange}
              >
                {game.pendingPromotion && (
                  <PromotionDialog
                    promotion={game.pendingPromotion}
                    orientation={game.orientation}
                    boardSize={boardSize}
                    onConfirm={game.confirmPromotion}
                    onCancel={game.cancelPromotion}
                  />
                )}
              </Board>
            </div>

            {/* Control bar */}
            <div className="flex items-center gap-2">
              <button
                className="px-3 py-1.5 text-base text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5"
                onClick={() => {
                  if (isPlayMode) {
                    // Take-back: cancel any in-flight engine search, reset the
                    // player's clock, and truncate back to the user's turn.
                    engine.cancelThinking()
                    engine.turnStartTimeRef.current = Date.now()
                    game.takeBack(playerColor)
                  } else {
                    game.goToMove(game.currentMoveIndex - 1)
                  }
                }}
                title="Undo"
              >
                Undo
              </button>
              <button
                className="px-3 py-1.5 text-base text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5"
                onClick={() => game.flipBoard()}
                title="Flip board (F)"
              >
                Flip
              </button>
              <button
                className="px-3 py-1.5 text-base text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5"
                onClick={() => game.newGame()}
                title="New game"
              >
                New
              </button>
              <button
                className="px-3 py-1.5 text-base text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5"
                onClick={() => { setPgnInitialText(""); setPgnDialogOpen(true) }}
                title="Import PGN or FEN (⌘V)"
              >
                Import
              </button>
              <button
                className="px-3 py-1.5 text-base text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5"
                onClick={handleExport}
                title="Export game as PGN"
              >
                Export
              </button>
              <button
                className="px-3 py-1.5 text-base text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5"
                onClick={() => setEditorOpen(true)}
                title="Set up position (⌘E)"
              >
                Set up
              </button>
              {!isPlayMode && (
                <button
                  data-testid="play-this-out"
                  className="px-3 py-1.5 text-base text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5"
                  onClick={() => {
                    setTournamentPresetNonce((n) => n + 1)
                    setView("tournament")
                  }}
                  title="Let the tournament engines play this position out (Stockfish takes your side)"
                >
                  Play this out
                </button>
              )}
            </div>
          </div>

          {/* Right column: Game Analytics */}
          <div className="flex flex-col gap-4 min-h-0 overflow-hidden">
            <div className="shrink-0">
              <AnalysisPanel engine={engine} turn={turn} />
            </div>
            <MoveList
              tree={game.tree}
              currentId={game.currentNodeId}
              onGoToNode={game.goToNode}
              version={game.treeVersion}
            />
            {/* Annotation editing + eval graph (spec 202) — analyze mode only */}
            {!isPlayMode && (
              <>
                <AnnotationBar
                  node={game.currentNode}
                  onSetNags={game.setNags}
                  onSetComment={game.setComment}
                  active={view === "board" && !liveViewing && !pgnDialogOpen && !editorOpen}
                />
                <EvalGraph
                  tree={game.tree}
                  currentId={game.currentNodeId}
                  onGoToNode={game.goToNode}
                  version={game.treeVersion}
                />
              </>
            )}
          </div>
        </main>
      </div>

      <PgnImportDialog
        open={pgnDialogOpen}
        onOpenChange={setPgnDialogOpen}
        onLoadTree={game.loadTree}
        initialText={pgnInitialText}
        onImagePaste={recognizeImage}
      />

      <PositionEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        currentFen={game.fen}
        onSetPosition={game.loadFen}
        onImagePaste={recognizeImage}
      />
    </TooltipProvider>
    </ErrorBoundary>
  )
}

const EMPTY_DESTS = new Map<Key, Key[]>()
const noop = () => {}

// Format a remaining clock (ms) as m:ss, with tenths under 10s.
function fmtClock(ms: number): string {
  const t = Math.max(0, ms)
  if (t < 10_000) return (t / 1000).toFixed(1)
  const s = Math.floor(t / 1000)
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`
}

/** One player's name + remaining clock, shown above/below the live board. */
function LivePlayer({ label, side, ms }: { label: string; side: string; ms: number }) {
  return (
    <div className="flex items-center justify-between gap-3 w-full max-w-[min(70vh,560px)] px-1">
      <span className="text-sm font-medium text-foreground">
        {label} <span className="text-muted-foreground">({side})</span>
      </span>
      <span className="px-2 py-0.5 rounded bg-secondary/60 border border-white/10 text-base font-mono text-foreground tabular-nums">
        {fmtClock(ms)}
      </span>
    </div>
  )
}

/** A control-bar button. */
function ViewerBtn({
  label,
  title,
  onClick,
  disabled,
  active,
}: {
  label: string
  title: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`px-2.5 py-1 text-sm rounded-md border transition-colors disabled:opacity-40 ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-background text-muted-foreground border-input hover:text-foreground hover:bg-white/5"
      }`}
    >
      {label}
    </button>
  )
}

/**
 * Read-only board that watches the currently-featured live tournament game,
 * with a control bar (Stop / Pause / auto-start / delay) and back-forward ply
 * navigation. Stepping back off the live tip stops following; the eval bar and
 * board track the viewed ply. Resuming or a new game snaps back to the tip.
 */
function LiveGameView({
  live,
  showEvalBar,
  controls,
}: {
  live: LiveGame | null
  showEvalBar?: boolean
  controls?: ViewerControls | null
}) {
  // null = follow the live tip; a number = reviewing that frame index.
  const [viewIdx, setViewIdx] = useState<number | null>(null)
  const gameId = live?.gameId
  useEffect(() => {
    setViewIdx(null) // snap to the tip whenever the featured game changes
  }, [gameId])

  const frames = live?.frames ?? []
  const tipIdx = frames.length - 1
  const following = viewIdx === null
  const idx = following ? tipIdx : Math.min(viewIdx, tipIdx)

  const back = useCallback(() => {
    setViewIdx((v) => {
      const cur = v === null ? tipIdx : Math.min(v, tipIdx)
      return Math.max(0, cur - 1)
    })
  }, [tipIdx])
  const forward = useCallback(() => {
    setViewIdx((v) => {
      const cur = v === null ? tipIdx : Math.min(v, tipIdx)
      const next = cur + 1
      return next >= tipIdx ? null : next // reaching the tip resumes following
    })
  }, [tipIdx])

  // Arrow keys step through the current game while the viewer is on screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      if (e.key === "ArrowLeft") { e.preventDefault(); back() }
      else if (e.key === "ArrowRight") { e.preventDefault(); forward() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [back, forward])

  if (!live) {
    return (
      <div className="text-sm text-muted-foreground">
        Waiting for the first move&hellip;
      </div>
    )
  }

  // The displayed frame: the reviewed one, or the live tip's fields as fallback.
  const frame = frames.length ? frames[idx] : null
  const fen = frame?.fen ?? live.fen
  const lastMove = frame?.lastMove ?? live.lastMove
  const wMs = frame?.whiteTimeMs ?? live.whiteTimeMs
  const bMs = frame?.blackTimeMs ?? live.blackTimeMs
  const ev = frame ? frame.eval : live.eval
  const ply = frame?.ply ?? live.ply
  const atTip = following || idx >= tipIdx
  const moveNo = Math.floor((ply + 1) / 2)

  // The neutral evaluator's score is already White-POV (turn="white").
  const evalScore = ev
    ? ev.mate != null
      ? ({ type: "mate", value: ev.mate } as const)
      : ({ type: "cp", value: ev.cp ?? 0 } as const)
    : null

  return (
    <div className="flex flex-col items-center gap-2 w-full h-full min-h-0 py-2">
      <LivePlayer label={live.blackLabel} side="black" ms={bMs} />
      <div className="flex-1 flex items-center justify-center w-full overflow-hidden gap-2">
        {showEvalBar && evalScore && (
          <EvalBar score={evalScore} turn="white" width={20} />
        )}
        <Board
          fen={fen}
          orientation="white"
          viewOnly
          legalMoves={EMPTY_DESTS}
          onMove={noop}
          lastMove={lastMove as [Key, Key] | undefined}
        />
      </div>
      <LivePlayer label={live.whiteLabel} side="white" ms={wMs} />

      {/* Ply navigation + live/reviewing indicator */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
        <ViewerBtn label="◀" title="Step back (←)" onClick={back} disabled={tipIdx < 1} />
        <span className="tabular-nums">
          game #{live.gameId} · move {moveNo}
        </span>
        <ViewerBtn label="▶" title="Step forward (→)" onClick={forward} disabled={atTip} />
        {atTip ? (
          <span className="text-green-400">● live</span>
        ) : (
          <button
            className="text-primary hover:underline"
            onClick={() => setViewIdx(null)}
            title="Jump back to the live position"
          >
            reviewing — go live
          </button>
        )}
      </div>

      {/* Batch control bar */}
      {controls && (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <ViewerBtn
            label="Stop"
            title="Stop the tournament (in-flight games are aborted, finished games kept)"
            onClick={controls.onStop}
          />
          <ViewerBtn
            label={controls.paused ? "Resume" : "Pause"}
            title={controls.paused ? "Resume play" : "Pause between moves (clocks freeze)"}
            active={controls.paused}
            onClick={() => {
              const wasPaused = controls.paused
              controls.onTogglePause()
              if (wasPaused) setViewIdx(null) // resuming snaps back to the tip
            }}
          />
          <ViewerBtn
            label="Start next game"
            title="Advance to the next game"
            disabled={!controls.waitingForNext}
            onClick={() => {
              controls.onStartNext()
              setViewIdx(null)
            }}
          />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-green-600"
              checked={controls.autoStartNext}
              onChange={controls.onToggleAutoStart}
            />
            auto-start next
          </label>
          <select
            className="bg-background border border-input rounded-md px-2 py-1 text-xs text-foreground"
            value={controls.delayMs}
            onChange={(e) => controls.onSetDelay(Number(e.target.value))}
            title="Minimum time each move stays on the board"
          >
            {MOVE_DELAY_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>{o.label}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

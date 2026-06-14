"use client"

import { useEffect, useState, useCallback } from "react"
import dynamic from "next/dynamic"
import { TooltipProvider } from "@/components/ui/tooltip"
import { MoveList } from "@/components/move-list"
import { AnalysisPanel } from "@/components/analysis-panel"
import { PromotionDialog } from "@/components/promotion-dialog"
import { PgnImportDialog } from "@/components/pgn-import-dialog"
import { ErrorBoundary } from "@/components/error-boundary"
import { TournamentTab } from "@/components/tournament-tab"
import { useChessGame } from "@/hooks/use-chess-game"
import { useEngine } from "@/hooks/use-engine"
import type { LiveGame } from "@/lib/tournament"
import type { Key } from "@lichess-org/chessground/types"

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
  const turn = game.fen.includes(" w ") ? ("white" as const) : ("black" as const)
  const isPlayMode = engine.state.mode === "play"
  const playerColor = engine.state.playerColor
  const [boardSize, setBoardSize] = useState(560)
  const [view, setView] = useState<"board" | "tournament">("board")
  const [tournamentRunning, setTournamentRunning] = useState(false)
  const [liveGame, setLiveGame] = useState<LiveGame | null>(null)
  // Watch a live engine-vs-engine game on the board while a tournament runs.
  const liveViewing = view === "board" && tournamentRunning
  const [pgnDialogOpen, setPgnDialogOpen] = useState(false)
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

  const formatClock = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
    const s = (totalSeconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  // Auto-flip board when starting a game as black
  useEffect(() => {
    if (isPlayMode) {
      game.setOrientation(playerColor)
    }
  }, [isPlayMode, playerColor])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey

      if (meta && e.key === "v") {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag !== "INPUT" && tag !== "TEXTAREA") {
          e.preventDefault()
          setPgnDialogOpen(true)
          return
        }
      }

      if (e.key === "ArrowLeft" || (meta && e.key === "z" && !e.shiftKey)) {
        e.preventDefault()
        // In play mode, Cmd+Z undoes a full move (2 plies: your move + engine's response).
        // Arrow left still steps 1 ply for reviewing.
        const step = (meta && e.key === "z" && isPlayMode) ? 2 : 1
        if (isPlayMode) engine.cancelThinking()
        game.goToMove(game.currentMoveIndex - step)
      } else if (
        e.key === "ArrowRight" ||
        (meta && e.key === "z" && e.shiftKey)
      ) {
        e.preventDefault()
        game.goToMove(game.currentMoveIndex + 1)
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
  }, [game.currentMoveIndex, game.moves.length, game.goToMove, game.flipBoard, isPlayMode])

  return (
    <ErrorBoundary>
    <TooltipProvider>
      <div className="h-screen flex flex-col bg-[#0a0a0a]">
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-3 border-b border-white/10">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold tracking-tight text-foreground">
              ChessGUI
            </span>
          </div>
          <nav className="flex items-center gap-1">
            <button
              className={`px-3 py-1.5 text-sm transition-colors rounded-md hover:bg-white/5 ${
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
              className={`px-3 py-1.5 text-sm transition-colors rounded-md hover:bg-white/5 ${
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
              className={`px-3 py-1.5 text-sm transition-colors rounded-md hover:bg-white/5 ${
                view === "tournament" ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setView("tournament")}
              title="Run headless engine-vs-engine tournaments"
            >
              Tournament
            </button>
            <button className="px-3 py-1.5 text-sm text-muted-foreground/40 cursor-not-allowed rounded-md" disabled>
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

        {/* Tournament view — kept mounted so a running batch survives switching
            to the board to watch a live game. */}
        <main
          className="flex-1 min-h-0"
          style={view === "tournament" ? undefined : { display: "none" }}
        >
          <TournamentTab
            onRunningChange={setTournamentRunning}
            onLiveUpdate={setLiveGame}
          />
        </main>

        {/* Live tournament game viewer */}
        {liveViewing && (
          <main className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 p-4">
            <LiveGameView live={liveGame} />
          </main>
        )}

        {/* Main content - three-column grid */}
        <main
          className="flex-1 grid grid-cols-[220px_1fr_220px] gap-4 p-4 min-h-0"
          style={view === "tournament" || liveViewing ? { display: "none" } : undefined}
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

            {/* Player card (bottom of board) */}
            <div className="bg-secondary/40 backdrop-blur-md border border-white/10 rounded-lg p-4 mt-auto">
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
            {game.status.label && (
              <div
                className={`shrink-0 px-4 py-1.5 rounded-md text-sm font-semibold ${
                  game.status.over
                    ? "bg-red-900/60 text-red-100 border border-red-700/50"
                    : "bg-amber-900/40 text-amber-200 border border-amber-700/40"
                }`}
              >
                {game.status.label}
              </div>
            )}
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
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5"
                onClick={() => {
                  if (isPlayMode) engine.cancelThinking()
                  game.goToMove(game.currentMoveIndex - (isPlayMode ? 2 : 1))
                }}
                title="Undo"
              >
                Undo
              </button>
              <button
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5"
                onClick={() => game.flipBoard()}
                title="Flip board (F)"
              >
                Flip
              </button>
              <button
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5"
                onClick={() => game.newGame()}
                title="New game"
              >
                New
              </button>
            </div>
          </div>

          {/* Right column: Game Analytics */}
          <div className="flex flex-col gap-4 min-h-0 overflow-hidden">
            <div className="shrink-0">
              <AnalysisPanel engine={engine} turn={turn} />
            </div>
            <MoveList
              moves={game.moves}
              currentIndex={game.currentMoveIndex}
              onGoToMove={game.goToMove}
            />
          </div>
        </main>
      </div>

      <PgnImportDialog
        open={pgnDialogOpen}
        onOpenChange={setPgnDialogOpen}
        onLoadGame={game.loadGame}
      />
    </TooltipProvider>
    </ErrorBoundary>
  )
}

const EMPTY_DESTS = new Map<Key, Key[]>()
const noop = () => {}

/** Read-only board that watches the currently-featured live tournament game. */
function LiveGameView({ live }: { live: LiveGame | null }) {
  if (!live) {
    return (
      <div className="text-sm text-muted-foreground">
        Waiting for the first move&hellip;
      </div>
    )
  }
  const moveNo = Math.floor((live.ply + 1) / 2)
  return (
    <div className="flex flex-col items-center gap-3 w-full h-full min-h-0 py-2">
      <div className="text-sm font-medium text-foreground">
        {live.blackLabel} <span className="text-muted-foreground">(black)</span>
      </div>
      <div className="flex-1 flex items-center justify-center w-full overflow-hidden">
        <Board
          fen={live.fen}
          orientation="white"
          viewOnly
          legalMoves={EMPTY_DESTS}
          onMove={noop}
          lastMove={live.lastMove as [Key, Key] | undefined}
        />
      </div>
      <div className="text-sm font-medium text-foreground">
        {live.whiteLabel} <span className="text-muted-foreground">(white)</span>
      </div>
      <div className="text-xs text-muted-foreground font-mono">
        game #{live.gameId} &middot; move {moveNo}
      </div>
    </div>
  )
}

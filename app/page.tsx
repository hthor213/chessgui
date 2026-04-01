"use client"

import { useEffect, useState, useCallback } from "react"
import dynamic from "next/dynamic"
import { TooltipProvider } from "@/components/ui/tooltip"
import { MoveList } from "@/components/move-list"
import { AnalysisPanel } from "@/components/analysis-panel"
import { PromotionDialog } from "@/components/promotion-dialog"
import { PgnImportDialog } from "@/components/pgn-import-dialog"
import { useChessGame } from "@/hooks/use-chess-game"
import { useEngine } from "@/hooks/use-engine"

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

  const engine = useEngine(game.fen, handleBestMove)
  const turn = game.fen.includes(" w ") ? ("white" as const) : ("black" as const)
  const isPlayMode = engine.state.mode === "play"
  const [boardSize, setBoardSize] = useState(560)
  const [pgnDialogOpen, setPgnDialogOpen] = useState(false)

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
        game.goToMove(game.currentMoveIndex - 1)
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
      } else if (e.key === "f" || e.key === "F") {
        if (!meta) {
          game.flipBoard()
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [game.currentMoveIndex, game.moves.length, game.goToMove, game.flipBoard])

  return (
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
            <button className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5">
              Play
            </button>
            <button className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5">
              Analyze
            </button>
            <button className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/5">
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

        {/* Main content - three-column grid */}
        <main className="flex-1 grid grid-cols-[20%_auto_25%] gap-6 p-6 min-h-0">
          {/* Left column: Player Panel */}
          <div className="flex flex-col gap-4">
            {/* Opponent card */}
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
                    {isPlayMode ? "Engine" : game.headers["BlackElo"] || "---"}
                  </p>
                </div>
              </div>
              <div className="mt-3 text-2xl font-mono text-foreground text-center tracking-wider">
                --:--
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

            {/* Player card */}
            <div className="bg-secondary/40 backdrop-blur-md border border-white/10 rounded-lg p-4 mt-auto">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
                  <span className="text-sm font-medium">
                    {game.headers["White"]?.[0] || "W"}
                  </span>
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {game.headers["White"] || "White"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {game.headers["WhiteElo"] || "---"}
                  </p>
                </div>
              </div>
              <div className="mt-3 text-2xl font-mono text-foreground text-center tracking-wider">
                --:--
              </div>
            </div>
          </div>

          {/* Center column: Board */}
          <div className="flex flex-col items-center gap-4 min-h-0">
            <div className="flex-1 flex items-center justify-center">
              <Board
                fen={game.fen}
                orientation={game.orientation}
                movableColor={isPlayMode ? "white" : "both"}
                onMove={game.onMove}
                legalMoves={
                  isPlayMode && turn === "black" ? new Map() : game.legalMoves
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
                onClick={() => game.goToMove(game.currentMoveIndex - 1)}
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
            <AnalysisPanel engine={engine} turn={turn} />
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
  )
}

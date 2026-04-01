import { useEffect, useState } from "react";
import { AppShell, Group, Stack, Text } from "@mantine/core";
import { Board } from "./components/Board";
import { MoveList } from "./components/MoveList";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { PromotionDialog } from "./components/PromotionDialog";
import { PgnImportModal } from "./components/PgnImportModal";
import { useChessGame } from "./hooks/useChessGame";
import { useEngine } from "./hooks/useEngine";

function App() {
  return (
    <AppShell padding="md">
      <AppShell.Main style={{ height: "100vh" }}>
        <MainLayout />
      </AppShell.Main>
    </AppShell>
  );
}

function MainLayout() {
  const game = useChessGame();
  const engine = useEngine(game.fen);
  const turn = game.fen.includes(" w ") ? "white" as const : "black" as const;
  const [boardSize, setBoardSize] = useState(560);
  const [pgnModalOpen, setPgnModalOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      if (meta && e.key === "v") {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA") {
          e.preventDefault();
          setPgnModalOpen(true);
          return;
        }
      }

      if (e.key === "ArrowLeft" || (meta && e.key === "z" && !e.shiftKey)) {
        e.preventDefault();
        game.goToMove(game.currentMoveIndex - 1);
      } else if (e.key === "ArrowRight" || (meta && e.key === "z" && e.shiftKey)) {
        e.preventDefault();
        game.goToMove(game.currentMoveIndex + 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        game.goToMove(-1);
      } else if (e.key === "End") {
        e.preventDefault();
        game.goToMove(game.moves.length - 1);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [game.currentMoveIndex, game.moves.length, game.goToMove]);

  return (
    <Group align="flex-start" gap="md" wrap="nowrap" style={{ height: "100%" }}>
      <Board
        fen={game.fen}
        orientation={game.orientation}
        onMove={game.onMove}
        legalMoves={game.legalMoves}
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
      <Stack gap="md" style={{ flex: 1, minWidth: 250, height: "100%" }}>
        {game.headers["White"] && (
          <div
            style={{
              backgroundColor: "#1e1c19",
              border: "1px solid #2a2825",
              borderRadius: 4,
              padding: "6px 10px",
            }}
          >
            <Text size="sm" fw={600} c="#bababa">
              {game.headers["White"]} vs {game.headers["Black"] || "?"}
            </Text>
            {(game.headers["Event"] || game.headers["Date"] || game.headers["Result"]) && (
              <Text size="xs" c="dimmed">
                {[game.headers["Event"], game.headers["Date"], game.headers["Result"]]
                  .filter(Boolean)
                  .join(" \u2022 ")}
              </Text>
            )}
          </div>
        )}
        <AnalysisPanel engine={engine} turn={turn} />
        <MoveList
          moves={game.moves}
          currentIndex={game.currentMoveIndex}
          onGoToMove={game.goToMove}
        />
      </Stack>
      <PgnImportModal
        opened={pgnModalOpen}
        onClose={() => setPgnModalOpen(false)}
        onLoadGame={game.loadGame}
      />
    </Group>
  );
}

export default App;

import { useEffect } from "react";
import { AppShell, Group, Stack } from "@mantine/core";
import { Board } from "./components/Board";
import { MoveList } from "./components/MoveList";
import { AnalysisPanel } from "./components/AnalysisPanel";
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
  const turn = game.fen.includes(" w ") ? "white" : "black" as const;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

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
      />
      <Stack gap="md" style={{ flex: 1, minWidth: 250, height: "100%" }}>
        <AnalysisPanel engine={engine} turn={turn} />
        <MoveList
          moves={game.moves}
          currentIndex={game.currentMoveIndex}
          onGoToMove={game.goToMove}
        />
      </Stack>
    </Group>
  );
}

export default App;

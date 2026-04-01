import { AppShell, Group, Title, Stack } from "@mantine/core";
import { Board } from "./components/Board";
import { MoveList } from "./components/MoveList";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { useChessGame } from "./hooks/useChessGame";

function App() {
  return (
    <AppShell
      header={{ height: 44 }}
      padding="md"
    >
      <AppShell.Header
        style={{
          display: "flex",
          alignItems: "center",
          paddingInline: 16,
          WebkitAppRegion: "drag",
        }}
      >
        <Title order={4} style={{ fontWeight: 600 }}>
          ChessGUI
        </Title>
      </AppShell.Header>

      <AppShell.Main style={{ height: "calc(100vh - 44px)" }}>
        <MainLayout />
      </AppShell.Main>
    </AppShell>
  );
}

function MainLayout() {
  const game = useChessGame();

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
        <AnalysisPanel />
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

import { Paper, Text, Stack, Group, Badge, ActionIcon, Button, Tooltip } from "@mantine/core";
import { formatScore, scoreToNumeric, type PvLine } from "../lib/uciParser";
import type { EngineState } from "../hooks/useEngine";

interface AnalysisPanelProps {
  engine: {
    state: EngineState;
    startEngine: (path?: string) => Promise<void>;
    stopEngine: () => Promise<void>;
    toggleAnalysis: () => void;
  };
  turn: "white" | "black";
}

function formatNodes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

function EvalBar({ score, turn }: { score: PvLine["score"]; turn: "white" | "black" }) {
  const numeric = scoreToNumeric(score, turn);
  // Clamp to [-10, 10], map to percentage (50% = equal)
  const clamped = Math.max(-10, Math.min(10, numeric));
  const whitePct = 50 + (clamped / 10) * 50;

  return (
    <div style={{
      width: 26,
      height: "100%",
      minHeight: 200,
      borderRadius: 4,
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      flexShrink: 0,
    }}>
      <div style={{
        flex: `${100 - whitePct} 0 0`,
        backgroundColor: "#403d39",
        transition: "flex 0.3s ease",
      }} />
      <div style={{
        flex: `${whitePct} 0 0`,
        backgroundColor: "#e8e6e1",
        transition: "flex 0.3s ease",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 2,
      }}>
        {whitePct > 55 && (
          <Text size="9px" fw={700} c="#333" style={{ fontFamily: "monospace" }}>
            {Math.abs(numeric).toFixed(1)}
          </Text>
        )}
      </div>
    </div>
  );
}

function ScoreBadge({ score, turn }: { score: PvLine["score"]; turn: "white" | "black" }) {
  const numeric = scoreToNumeric(score, turn);
  const color = numeric > 0.2 ? "green" : numeric < -0.2 ? "red" : "gray";

  return (
    <Badge
      size="sm"
      variant="filled"
      color={color}
      style={{ minWidth: 52, fontFamily: "monospace", fontWeight: 700 }}
    >
      {formatScore(score, turn)}
    </Badge>
  );
}

function PvLineRow({ line, turn }: { line: PvLine; turn: "white" | "black" }) {
  return (
    <Group gap={6} wrap="nowrap" align="flex-start">
      <ScoreBadge score={line.score} turn={turn} />
      <Text
        size="xs"
        c="dimmed"
        style={{ fontFamily: "monospace", lineHeight: 1.6, wordBreak: "break-word" }}
      >
        {line.sanMoves.join("  ")}
      </Text>
    </Group>
  );
}

export function AnalysisPanel({ engine, turn }: AnalysisPanelProps) {
  const { state } = engine;

  if (!state.isRunning) {
    return (
      <Paper
        p="md"
        radius="sm"
        style={{ backgroundColor: "#1e1c19", border: "1px solid #2a2825" }}
      >
        <Stack gap="xs" align="center" py="lg">
          <Text size="sm" c="dimmed">
            No engine connected
          </Text>
          <Button
            size="sm"
            variant="filled"
            color="green"
            onClick={() => engine.startEngine()}
          >
            Load Stockfish
          </Button>
        </Stack>
      </Paper>
    );
  }

  const topLine = state.lines.find((l) => l.multipv === 1);

  return (
    <Group gap={0} wrap="nowrap" align="stretch">
      {topLine && <EvalBar score={topLine.score} turn={turn} />}
      <Paper
        p="sm"
        radius="sm"
        style={{
          backgroundColor: "#1e1c19",
          border: "1px solid #2a2825",
          flex: 1,
          minWidth: 0,
        }}
      >
        <Group justify="space-between" mb={6}>
          <Group gap={6}>
            <Text size="xs" fw={600} c="#bababa">
              {state.engineName}
            </Text>
            {state.isAnalyzing && (
              <Text size="xs" c="dimmed">
                depth {state.depth}
              </Text>
            )}
          </Group>
          <Group gap={4}>
            {state.isAnalyzing && state.nps > 0 && (
              <Text size="xs" c="dimmed">
                {formatNodes(state.nps)}/s
              </Text>
            )}
            <Tooltip label={state.isAnalyzing ? "Pause" : "Resume"}>
              <ActionIcon size="xs" variant="subtle" color="gray" onClick={() => engine.toggleAnalysis()}>
                <Text size="xs">{state.isAnalyzing ? "⏸" : "▶"}</Text>
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Disconnect">
              <ActionIcon size="xs" variant="subtle" color="red" onClick={() => engine.stopEngine()}>
                <Text size="xs">✕</Text>
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>

        {topLine && (
          <Text
            size="xl"
            fw={700}
            mb={6}
            style={{ fontFamily: "monospace", letterSpacing: -0.5 }}
            c={scoreToNumeric(topLine.score, turn) > 0.2 ? "#7fba3a" : scoreToNumeric(topLine.score, turn) < -0.2 ? "#e05555" : "#bababa"}
          >
            {formatScore(topLine.score, turn)}
          </Text>
        )}

        <Stack gap={4}>
          {state.lines.map((line) => (
            <PvLineRow key={line.multipv} line={line} turn={turn} />
          ))}
          {state.lines.length === 0 && state.isAnalyzing && (
            <Text size="xs" c="dimmed">
              Calculating...
            </Text>
          )}
        </Stack>
      </Paper>
    </Group>
  );
}

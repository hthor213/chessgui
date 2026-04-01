import { Paper, Text, Stack, Group, Badge } from "@mantine/core";

export function AnalysisPanel() {
  // Placeholder — will be wired to Stockfish UCI output via Tauri IPC
  return (
    <Paper p="sm" radius="md" withBorder>
      <Group justify="space-between" mb="xs">
        <Text size="sm" fw={600}>
          Analysis
        </Text>
        <Badge size="sm" variant="outline" color="gray">
          No engine
        </Badge>
      </Group>
      <Stack gap={4}>
        <Text size="xs" c="dimmed">
          Connect Stockfish to see engine evaluation.
        </Text>
        <Text size="xs" c="dimmed">
          Engine integration coming in spec:011.
        </Text>
      </Stack>
    </Paper>
  );
}

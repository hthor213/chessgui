import { Paper, Text, ScrollArea, Group } from "@mantine/core";

interface MoveListProps {
  moves: string[];
  currentIndex: number;
  onGoToMove: (index: number) => void;
}

export function MoveList({ moves, currentIndex, onGoToMove }: MoveListProps) {
  const pairs: [string, string | undefined][] = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push([moves[i], moves[i + 1]]);
  }

  return (
    <Paper p="sm" radius="md" withBorder style={{ flex: 1, overflow: "hidden" }}>
      <Text size="sm" fw={600} mb="xs">
        Moves
      </Text>
      <ScrollArea style={{ height: "calc(100% - 30px)" }}>
        {pairs.length === 0 ? (
          <Text size="sm" c="dimmed">
            Play a move to begin...
          </Text>
        ) : (
          pairs.map(([white, black], pairIdx) => (
            <Group key={pairIdx} gap={4} mb={2}>
              <Text size="sm" c="dimmed" w={30} ta="right">
                {pairIdx + 1}.
              </Text>
              <Text
                size="sm"
                fw={currentIndex === pairIdx * 2 ? 700 : 400}
                bg={currentIndex === pairIdx * 2 ? "dark.5" : undefined}
                px={4}
                style={{ cursor: "pointer", borderRadius: 3 }}
                onClick={() => onGoToMove(pairIdx * 2)}
              >
                {white}
              </Text>
              {black && (
                <Text
                  size="sm"
                  fw={currentIndex === pairIdx * 2 + 1 ? 700 : 400}
                  bg={currentIndex === pairIdx * 2 + 1 ? "dark.5" : undefined}
                  px={4}
                  style={{ cursor: "pointer", borderRadius: 3 }}
                  onClick={() => onGoToMove(pairIdx * 2 + 1)}
                >
                  {black}
                </Text>
              )}
            </Group>
          ))
        )}
      </ScrollArea>
    </Paper>
  );
}

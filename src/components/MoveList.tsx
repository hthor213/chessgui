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
    <Paper
      p="sm"
      radius="sm"
      style={{
        flex: 1,
        overflow: "hidden",
        backgroundColor: "#1e1c19",
        border: "1px solid #2a2825",
      }}
    >
      <Text size="xs" fw={600} c="#bababa" mb="xs">
        Moves
      </Text>
      <ScrollArea style={{ height: "calc(100% - 28px)" }}>
        {pairs.length === 0 ? (
          <Text size="sm" c="dimmed">
            Play a move to begin...
          </Text>
        ) : (
          pairs.map(([white, black], pairIdx) => (
            <Group key={pairIdx} gap={0} mb={1} wrap="nowrap">
              <Text
                size="xs"
                c="dimmed"
                w={28}
                ta="right"
                mr={6}
                style={{ fontFamily: "monospace", flexShrink: 0 }}
              >
                {pairIdx + 1}.
              </Text>
              <Text
                size="sm"
                fw={currentIndex === pairIdx * 2 ? 700 : 400}
                c={currentIndex === pairIdx * 2 ? "#fff" : "#bababa"}
                bg={currentIndex === pairIdx * 2 ? "rgba(155, 199, 0, 0.25)" : undefined}
                px={6}
                py={1}
                w={70}
                style={{
                  cursor: "pointer",
                  borderRadius: 2,
                  fontFamily: "monospace",
                  flexShrink: 0,
                }}
                onClick={() => onGoToMove(pairIdx * 2)}
              >
                {white}
              </Text>
              {black && (
                <Text
                  size="sm"
                  fw={currentIndex === pairIdx * 2 + 1 ? 700 : 400}
                  c={currentIndex === pairIdx * 2 + 1 ? "#fff" : "#bababa"}
                  bg={currentIndex === pairIdx * 2 + 1 ? "rgba(155, 199, 0, 0.25)" : undefined}
                  px={6}
                  py={1}
                  w={70}
                  style={{
                    cursor: "pointer",
                    borderRadius: 2,
                    fontFamily: "monospace",
                    flexShrink: 0,
                  }}
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

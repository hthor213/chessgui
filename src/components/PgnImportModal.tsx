import { useState } from "react";
import {
  Modal,
  Textarea,
  Button,
  Text,
  Group,
  Stack,
  Paper,
} from "@mantine/core";
import { parsePgn, startingPosition } from "chessops/pgn";
import type { PgnNodeData } from "chessops/pgn";
import { makeSan, parseSan } from "chessops/san";

interface PgnGame {
  headers: Record<string, string>;
  moves: string[];
}

interface PgnImportModalProps {
  opened: boolean;
  onClose: () => void;
  onLoadGame: (moves: string[], headers?: Record<string, string>) => void;
}

function extractMoves(
  gameNode: { moves: { mainline(): Iterable<PgnNodeData> } },
  headers: Map<string, string>,
): string[] {
  const pos = startingPosition(headers);
  if (pos.isErr) return [];
  const chess = pos.unwrap();
  const moves: string[] = [];
  for (const node of gameNode.moves.mainline()) {
    const move = parseSan(chess, node.san);
    if (!move) break;
    moves.push(makeSan(chess, move));
    chess.play(move);
  }
  return moves;
}

function headersToRecord(headers: Map<string, string>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [k, v] of headers) {
    if (v && v !== "?" && v !== "????.??.??") {
      record[k] = v;
    }
  }
  return record;
}

function gameLabel(headers: Record<string, string>, index: number): string {
  const white = headers["White"] || "?";
  const black = headers["Black"] || "?";
  const result = headers["Result"] || "*";
  return `${index + 1}. ${white} vs ${black}  ${result}`;
}

export function PgnImportModal({
  opened,
  onClose,
  onLoadGame,
}: PgnImportModalProps) {
  const [pgnText, setPgnText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [parsedGames, setParsedGames] = useState<PgnGame[] | null>(null);

  const handleClose = () => {
    setPgnText("");
    setError(null);
    setParsedGames(null);
    onClose();
  };

  const handleLoad = () => {
    setError(null);
    setParsedGames(null);

    const trimmed = pgnText.trim();
    if (!trimmed) {
      setError("Please paste a PGN.");
      return;
    }

    const games = parsePgn(trimmed);
    if (games.length === 0) {
      setError("No valid games found in PGN.");
      return;
    }

    const parsed: PgnGame[] = games.map((g) => ({
      headers: headersToRecord(g.headers),
      moves: extractMoves(g, g.headers),
    }));

    const valid = parsed.filter((g) => g.moves.length > 0);
    if (valid.length === 0) {
      setError("Could not parse any moves from the PGN.");
      return;
    }

    if (valid.length === 1) {
      onLoadGame(valid[0].moves, valid[0].headers);
      handleClose();
      return;
    }

    setParsedGames(valid);
  };

  const handlePickGame = (game: PgnGame) => {
    onLoadGame(game.moves, game.headers);
    handleClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title="Import PGN"
      size="lg"
      styles={{
        header: { backgroundColor: "#1e1c19", borderBottom: "1px solid #2a2825" },
        body: { backgroundColor: "#1e1c19" },
        content: { backgroundColor: "#1e1c19" },
      }}
    >
      {parsedGames ? (
        <Stack gap="xs">
          <Text size="sm" c="#bababa">
            Multiple games found. Select one:
          </Text>
          {parsedGames.map((game, i) => (
            <Paper
              key={i}
              p="xs"
              style={{
                backgroundColor: "#2a2825",
                border: "1px solid #3a3835",
                cursor: "pointer",
              }}
              onClick={() => handlePickGame(game)}
            >
              <Text size="sm" c="#bababa">
                {gameLabel(game.headers, i)}
              </Text>
              {game.headers["Event"] && (
                <Text size="xs" c="dimmed">
                  {game.headers["Event"]}
                  {game.headers["Date"] ? ` - ${game.headers["Date"]}` : ""}
                </Text>
              )}
            </Paper>
          ))}
          <Button variant="subtle" color="gray" onClick={() => setParsedGames(null)}>
            Back
          </Button>
        </Stack>
      ) : (
        <Stack gap="sm">
          <Textarea
            placeholder="Paste PGN here..."
            minRows={10}
            maxRows={20}
            autosize
            value={pgnText}
            onChange={(e) => setPgnText(e.currentTarget.value)}
            styles={{
              input: {
                backgroundColor: "#2a2825",
                borderColor: "#3a3835",
                color: "#bababa",
                fontFamily: "monospace",
              },
            }}
          />
          {error && (
            <Text size="sm" c="red">
              {error}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="subtle" color="gray" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              color="green"
              onClick={handleLoad}
            >
              Load
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

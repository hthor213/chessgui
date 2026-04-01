"use client"

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { parsePgn, startingPosition } from "chessops/pgn";
import type { PgnNodeData } from "chessops/pgn";
import { makeSan, parseSan } from "chessops/san";

interface PgnGame {
  headers: Record<string, string>;
  moves: string[];
}

interface PgnImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

export function PgnImportDialog({
  open,
  onOpenChange,
  onLoadGame,
}: PgnImportDialogProps) {
  const [pgnText, setPgnText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [parsedGames, setParsedGames] = useState<PgnGame[] | null>(null);

  const handleClose = () => {
    setPgnText("");
    setError(null);
    setParsedGames(null);
    onOpenChange(false);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#1e1c19] border-[#2a2825] text-[#bababa] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[#f6f6f6]">Import PGN</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Paste a PGN game or select from multiple games.
          </DialogDescription>
        </DialogHeader>

        {parsedGames ? (
          <div className="flex flex-col gap-2">
            <span className="text-sm text-[#bababa]">
              Multiple games found. Select one:
            </span>
            {parsedGames.map((game, i) => (
              <Card
                key={i}
                className="bg-[#2a2825] border-[#3a3835] p-2 cursor-pointer hover:bg-[#3a3835] transition-colors"
                onClick={() => handlePickGame(game)}
              >
                <span className="text-sm text-[#bababa]">
                  {gameLabel(game.headers, i)}
                </span>
                {game.headers["Event"] && (
                  <span className="text-xs text-muted-foreground block">
                    {game.headers["Event"]}
                    {game.headers["Date"] ? ` - ${game.headers["Date"]}` : ""}
                  </span>
                )}
              </Card>
            ))}
            <Button
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => setParsedGames(null)}
            >
              Back
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Textarea
              placeholder="Paste PGN here..."
              rows={10}
              value={pgnText}
              onChange={(e) => setPgnText(e.target.value)}
              className="bg-[#2a2825] border-[#3a3835] text-[#bababa] font-mono resize-none"
            />
            {error && (
              <span className="text-sm text-red-400">
                {error}
              </span>
            )}
            <DialogFooter>
              <Button
                variant="ghost"
                className="text-muted-foreground"
                onClick={handleClose}
              >
                Cancel
              </Button>
              <Button
                className="bg-green-600 hover:bg-green-700 text-white"
                onClick={handleLoad}
              >
                Load
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

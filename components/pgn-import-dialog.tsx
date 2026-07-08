"use client"

import { useRef, useState } from "react";
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
import { makeFen } from "chessops/fen";
import { validateFen, padFen } from "@/lib/fen";

const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

interface PgnGame {
  headers: Record<string, string>;
  moves: string[];
  startFen: string;
}

interface PgnImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLoadGame: (moves: string[], headers?: Record<string, string>, startFen?: string) => void;
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

// The start position of a game, honoring any [FEN]/[SetUp] header.
function startFenFromHeaders(headers: Map<string, string>): string {
  const pos = startingPosition(headers);
  if (pos.isErr) return INITIAL_FEN;
  return makeFen(pos.unwrap().toSetup());
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClose = () => {
    setPgnText("");
    setError(null);
    setParsedGames(null);
    onOpenChange(false);
  };

  const doLoad = (raw: string) => {
    setError(null);
    setParsedGames(null);

    const trimmed = raw.trim();
    if (!trimmed) {
      setError("Please paste a PGN or FEN.");
      return;
    }

    // Single line that validates as a FEN → load it as a position.
    if (!trimmed.includes("\n")) {
      const padded = padFen(trimmed);
      if (validateFen(padded).ok) {
        onLoadGame([], { FEN: padded, SetUp: "1" }, padded);
        handleClose();
        return;
      }
    }

    const games = parsePgn(trimmed);
    if (games.length === 0) {
      setError("No valid games found.");
      return;
    }

    const parsed: PgnGame[] = games.map((g) => ({
      headers: headersToRecord(g.headers),
      moves: extractMoves(g, g.headers),
      startFen: startFenFromHeaders(g.headers),
    }));

    // A game with a [FEN] header but no moves is still a valid position import.
    const valid = parsed.filter((g) => g.moves.length > 0 || g.startFen !== INITIAL_FEN);
    if (valid.length === 0) {
      setError("Could not parse any moves or position from the input.");
      return;
    }

    if (valid.length === 1) {
      onLoadGame(valid[0].moves, valid[0].headers, valid[0].startFen);
      handleClose();
      return;
    }

    setParsedGames(valid);
  };

  const handleLoad = () => doLoad(pgnText);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    file.text().then((text) => {
      setPgnText(text);
      doLoad(text);
    });
  };

  const handlePickGame = (game: PgnGame) => {
    onLoadGame(game.moves, game.headers, game.startFen);
    handleClose();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#1e1c19] border-[#2a2825] text-[#bababa] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[#f6f6f6]">Import PGN or FEN</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Paste a PGN game, a FEN position, or open a .pgn file.
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
              placeholder="Paste PGN or FEN here..."
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
            <input
              ref={fileInputRef}
              type="file"
              accept=".pgn,.txt"
              className="hidden"
              onChange={handleFile}
            />
            <DialogFooter>
              <Button
                variant="ghost"
                className="text-muted-foreground mr-auto"
                onClick={() => fileInputRef.current?.click()}
              >
                Open file…
              </Button>
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

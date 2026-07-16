"use client"

import { useEffect, useRef, useState } from "react";
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
import { validateFen, padFen } from "@chessgui/core/fen";
import { parsePgnToTrees } from "@chessgui/core/pgn";
import { GameTree, INITIAL_FEN } from "@chessgui/core/game-tree";
import { clipboardEventImage, type ClipboardImage } from "@/lib/recognize-position";

interface PgnImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Load a fully-parsed game tree (variations, comments, NAGs preserved). */
  onLoadTree: (tree: GameTree) => void;
  /** Pre-fill the textarea (e.g. from a ⌘V paste or a dropped .pgn file). */
  initialText?: string;
  /** Called when the user pastes a screenshot of a position instead of text. */
  onImagePaste?: (image: ClipboardImage) => void;
}

function gameLabel(headers: Record<string, string>, index: number): string {
  const white = headers["White"] || "?";
  const black = headers["Black"] || "?";
  const result = headers["Result"] || "*";
  return `${index + 1}. ${white} vs ${black}  ${result}`;
}

// A tree is worth importing if it has moves or a non-standard start position.
function isImportable(tree: GameTree): boolean {
  return tree.root().children.length > 0 || tree.startFen !== INITIAL_FEN;
}

export function PgnImportDialog({
  open,
  onOpenChange,
  onLoadTree,
  initialText,
  onImagePaste,
}: PgnImportDialogProps) {
  const [pgnText, setPgnText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [parsedGames, setParsedGames] = useState<GameTree[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Seed the textarea when the dialog is opened with pre-filled text.
  useEffect(() => {
    if (open && initialText) setPgnText(initialText);
  }, [open, initialText]);

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
        onLoadTree(GameTree.create(padded, { FEN: padded, SetUp: "1" }));
        handleClose();
        return;
      }
    }

    const trees = parsePgnToTrees(trimmed);
    const valid = trees.filter(isImportable);
    if (valid.length === 0) {
      setError("Could not parse any moves or position from the input.");
      return;
    }

    if (valid.length === 1) {
      onLoadTree(valid[0]);
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

  const handlePickGame = (tree: GameTree) => {
    onLoadTree(tree);
    handleClose();
  };

  // Pasting a screenshot anywhere in the dialog hands the image to the
  // recognition flow instead of the textarea.
  const handlePaste = (e: React.ClipboardEvent) => {
    if (!onImagePaste) return;
    clipboardEventImage(e).then((image) => {
      if (!image) return;
      handleClose();
      onImagePaste(image);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="bg-[#1e1c19] border-[#2a2825] text-[#bababa] sm:max-w-lg"
        onPaste={handlePaste}
      >
        <DialogHeader>
          <DialogTitle className="text-[#f6f6f6]">Import PGN or FEN</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Paste a PGN game, a FEN position, a screenshot of a board, or open a .pgn file.
          </DialogDescription>
        </DialogHeader>

        {parsedGames ? (
          <div className="flex flex-col gap-2">
            <span className="text-sm text-[#bababa]">
              Multiple games found. Select one:
            </span>
            {parsedGames.map((tree, i) => (
              <Card
                key={i}
                className="bg-[#2a2825] border-[#3a3835] p-2 cursor-pointer hover:bg-[#3a3835] transition-colors"
                onClick={() => handlePickGame(tree)}
              >
                <span className="text-sm text-[#bababa]">
                  {gameLabel(tree.headers, i)}
                </span>
                {tree.headers["Event"] && tree.headers["Event"] !== "?" && (
                  <span className="text-xs text-muted-foreground block">
                    {tree.headers["Event"]}
                    {tree.headers["Date"] && tree.headers["Date"] !== "????.??.??"
                      ? ` - ${tree.headers["Date"]}`
                      : ""}
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

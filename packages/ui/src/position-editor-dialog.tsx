"use client"

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@chessgui/ui/ui/dialog";
import { Button } from "@chessgui/ui/ui/button";
import type { Key } from "@lichess-org/chessground/types";
import type { Color, Role } from "chessops";
import {
  validateFen,
  padFen,
  fenToPieceMap,
  pieceMapToFen,
  computeCastlingOptions,
  type PieceMap,
  type CastlingOptions,
} from "@chessgui/core/fen";
import { clipboardEventImage, type ClipboardImage } from "@/lib/recognize-position";

const Board = dynamic(
  () => import("@chessgui/ui/board").then((m) => ({ default: m.Board })),
  { ssr: false }
);

const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const EMPTY_DESTS = new Map<Key, Key[]>();

// Unicode glyphs for the off-board palette, mirroring promotion-dialog.
const GLYPH: Record<Color, Record<Role, string>> = {
  white: { king: "♔", queen: "♕", rook: "♖", bishop: "♗", knight: "♘", pawn: "♙" },
  black: { king: "♚", queen: "♛", rook: "♜", bishop: "♝", knight: "♞", pawn: "♟" },
};

const PALETTE_ROLES: Role[] = ["king", "queen", "rook", "bishop", "knight", "pawn"];

type Tool =
  | { kind: "piece"; color: Color; role: Role }
  | { kind: "erase" }
  | { kind: "pointer" };

interface PositionEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentFen: string;
  onSetPosition: (fen: string) => void;
  /** Called when the user pastes a screenshot of a position instead of editing. */
  onImagePaste?: (image: ClipboardImage) => void;
}

export function PositionEditorDialog({
  open,
  onOpenChange,
  currentFen,
  onSetPosition,
  onImagePaste,
}: PositionEditorDialogProps) {
  const [pieces, setPieces] = useState<PieceMap>(new Map());
  const [turn, setTurn] = useState<Color>("white");
  const [castling, setCastling] = useState<CastlingOptions>({ K: false, Q: false, k: false, q: false });
  const [tool, setTool] = useState<Tool>({ kind: "pointer" });
  const [orientation, setOrientation] = useState<Color>("white");
  const [fenText, setFenText] = useState("");
  const [fenError, setFenError] = useState<string | null>(null);

  // Commit a placement change: intersect castling with what's now structurally
  // possible (auto-untick), regenerate the FEN text, and re-validate.
  const applyState = useCallback((map: PieceMap, t: Color, c: CastlingOptions) => {
    const opts = computeCastlingOptions(map);
    const next: CastlingOptions = {
      K: c.K && opts.K,
      Q: c.Q && opts.Q,
      k: c.k && opts.k,
      q: c.q && opts.q,
    };
    const fen = pieceMapToFen(map, t, next);
    setPieces(map);
    setTurn(t);
    setCastling(next);
    setFenText(fen);
    const v = validateFen(fen);
    setFenError(v.ok ? null : v.error);
  }, []);

  // Seed from the live board each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const map = fenToPieceMap(currentFen);
    const parts = currentFen.split(/\s+/);
    const t: Color = parts[1] === "b" ? "black" : "white";
    const rights = parts[2] || "";
    applyState(map, t, {
      K: rights.includes("K"),
      Q: rights.includes("Q"),
      k: rights.includes("k"),
      q: rights.includes("q"),
    });
    setTool({ kind: "pointer" });
  }, [open, currentFen, applyState]);

  const handleSelect = useCallback(
    (square: string) => {
      if (tool.kind === "piece") {
        const map = new Map(pieces);
        map.set(square, { role: tool.role, color: tool.color });
        applyState(map, turn, castling);
      } else if (tool.kind === "erase" && pieces.has(square)) {
        const map = new Map(pieces);
        map.delete(square);
        applyState(map, turn, castling);
      }
    },
    [tool, pieces, turn, castling, applyState],
  );

  // A drag always relocates the piece (replacing any occupant) so Chessground's
  // own DOM and our placement state never diverge.
  const handleMove = useCallback(
    (from: string, to: string) => {
      const p = pieces.get(from);
      if (!p) return;
      const map = new Map(pieces);
      map.delete(from);
      map.set(to, p);
      applyState(map, turn, castling);
    },
    [pieces, turn, castling, applyState],
  );

  const handleFenInput = (text: string) => {
    setFenText(text);
    const padded = padFen(text);
    const v = validateFen(padded);
    if (!v.ok) {
      setFenError(v.error);
      return;
    }
    // Keep the user's exact text; update structured state (board follows).
    const map = fenToPieceMap(padded);
    const opts = computeCastlingOptions(map);
    const parts = padded.split(/\s+/);
    const rights = parts[2] || "";
    setPieces(map);
    setTurn(parts[1] === "b" ? "black" : "white");
    setCastling({
      K: rights.includes("K") && opts.K,
      Q: rights.includes("Q") && opts.Q,
      k: rights.includes("k") && opts.k,
      q: rights.includes("q") && opts.q,
    });
    setFenError(null);
  };

  const options = computeCastlingOptions(pieces);
  const boardFen = pieceMapToFen(pieces, turn, castling);
  const confirmDisabled = fenError !== null || !validateFen(boardFen).ok;

  const toggleCastle = (k: keyof CastlingOptions) =>
    applyState(pieces, turn, { ...castling, [k]: !castling[k] });

  const isPieceTool = (color: Color, role: Role) =>
    tool.kind === "piece" && tool.color === color && tool.role === role;

  const pieceBtnClass = (active: boolean) =>
    `w-9 h-9 flex items-center justify-center rounded text-2xl leading-none transition-colors ${
      active ? "bg-[#3a3835] ring-1 ring-green-600" : "bg-[#2a2825] hover:bg-[#3a3835]"
    }`;

  const toolBtnClass = (active: boolean) =>
    `px-2 py-1 text-xs rounded transition-colors ${
      active ? "bg-[#3a3835] text-[#f6f6f6] ring-1 ring-green-600" : "bg-[#2a2825] text-[#bababa] hover:bg-[#3a3835]"
    }`;

  // Pasting a screenshot anywhere in the editor hands the image to the
  // recognition flow instead of setting up by hand.
  const handleImagePaste = (e: React.ClipboardEvent) => {
    if (!onImagePaste) return;
    clipboardEventImage(e).then((image) => {
      if (!image) return;
      onOpenChange(false);
      onImagePaste(image);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="bg-[#1e1c19] border-[#2a2825] text-[#bababa] sm:max-w-3xl"
        onPaste={handleImagePaste}
      >
        <DialogHeader>
          <DialogTitle className="text-[#f6f6f6]">Set up position</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Place pieces, choose the side to move, or paste a screenshot of a board.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col md:flex-row gap-6">
          {/* Board */}
          <div style={{ width: 400, height: 448 }} className="mx-auto md:mx-0">
            <Board
              fen={boardFen}
              orientation={orientation}
              freeMove
              onMove={(from, to) => handleMove(from, to)}
              onSelect={handleSelect}
              legalMoves={EMPTY_DESTS}
            />
          </div>

          {/* Controls */}
          <div className="flex-1 flex flex-col gap-4 min-w-0">
            {/* Palette */}
            <div className="flex flex-col gap-2">
              {(["white", "black"] as Color[]).map((color) => (
                <div key={color} className="flex gap-1">
                  {PALETTE_ROLES.map((role) => (
                    <button
                      key={role}
                      type="button"
                      className={pieceBtnClass(isPieceTool(color, role))}
                      onClick={() => setTool({ kind: "piece", color, role })}
                      title={`${color} ${role}`}
                    >
                      {GLYPH[color][role]}
                    </button>
                  ))}
                </div>
              ))}
              <div className="flex gap-2 mt-1">
                <button
                  type="button"
                  className={toolBtnClass(tool.kind === "pointer")}
                  onClick={() => setTool({ kind: "pointer" })}
                >
                  Move
                </button>
                <button
                  type="button"
                  className={toolBtnClass(tool.kind === "erase")}
                  onClick={() => setTool({ kind: "erase" })}
                >
                  Eraser
                </button>
              </div>
            </div>

            {/* Side to move */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-24">Side to move</span>
              <button
                type="button"
                className={toolBtnClass(turn === "white")}
                onClick={() => applyState(pieces, "white", castling)}
              >
                White
              </button>
              <button
                type="button"
                className={toolBtnClass(turn === "black")}
                onClick={() => applyState(pieces, "black", castling)}
              >
                Black
              </button>
            </div>

            {/* Castling */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs text-muted-foreground w-24">Castling</span>
              {([
                ["K", "White O-O"],
                ["Q", "White O-O-O"],
                ["k", "Black O-O"],
                ["q", "Black O-O-O"],
              ] as [keyof CastlingOptions, string][]).map(([key, label]) => (
                <label
                  key={key}
                  className={`flex items-center gap-1 text-xs ${
                    options[key] ? "text-[#bababa]" : "text-muted-foreground/40"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={castling[key]}
                    disabled={!options[key]}
                    onChange={() => toggleCastle(key)}
                    className="accent-green-600"
                  />
                  {label}
                </label>
              ))}
            </div>

            {/* Quick actions */}
            <div className="flex gap-2">
              <button
                type="button"
                className={toolBtnClass(false)}
                onClick={() => applyState(fenToPieceMap(INITIAL_FEN), "white", { K: true, Q: true, k: true, q: true })}
              >
                Start position
              </button>
              <button
                type="button"
                className={toolBtnClass(false)}
                onClick={() => applyState(new Map(), turn, { K: false, Q: false, k: false, q: false })}
              >
                Clear board
              </button>
              <button
                type="button"
                className={toolBtnClass(false)}
                onClick={() => setOrientation((o) => (o === "white" ? "black" : "white"))}
              >
                Flip
              </button>
            </div>

            {/* FEN */}
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">FEN</span>
              <input
                type="text"
                value={fenText}
                onChange={(e) => handleFenInput(e.target.value)}
                spellCheck={false}
                className="bg-[#2a2825] border border-[#3a3835] rounded px-2 py-1 text-xs font-mono text-[#bababa] w-full"
              />
              {fenError && <span className="text-xs text-red-400">{fenError}</span>}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" className="text-muted-foreground" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="bg-green-600 hover:bg-green-700 text-white disabled:opacity-40"
            disabled={confirmDisabled}
            onClick={() => {
              onSetPosition(boardFen);
              onOpenChange(false);
            }}
          >
            Set up position
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

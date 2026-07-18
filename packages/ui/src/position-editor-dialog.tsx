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
import {
  validate960BackRank,
  complete960Fen,
  random960BackRank,
  type BackRankSlots,
} from "@chessgui/core/chess960-setup";
import type { ActiveGameMeta } from "@chessgui/core/active-game";
import {
  ActiveGameSetupSection,
  activeGameMetaFromSetup,
  emptyActiveGameSetup,
  type ActiveGameSetupValue,
} from "@chessgui/ui/active-game-setup";
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
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const isRank1 = (square: string) => square[1] === "1";
const NO_CASTLING: CastlingOptions = { K: false, Q: false, k: false, q: false };

// The White back rank the user has placed on rank 1, as file-indexed slots for
// validate960BackRank / complete960Fen (Chess960 quick setup, spec 014).
function whiteBackRankSlots(pieces: PieceMap): BackRankSlots {
  return FILES.map((file) => {
    const p = pieces.get(`${file}1`);
    return p && p.color === "white" ? p.role : null;
  });
}

type Tool =
  | { kind: "piece"; color: Color; role: Role }
  | { kind: "erase" }
  | { kind: "pointer" };

interface PositionEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentFen: string;
  /** `activeGame` is the spec 219 flag: non-null when the user marked the
   *  position as coming from a live chess.com daily game (engine lockout). */
  onSetPosition: (fen: string, activeGame: ActiveGameMeta | null) => void;
  /** Called when the user pastes a screenshot of a position instead of editing. */
  onImagePaste?: (image: ClipboardImage) => void;
  /** Prefill for the active-game username field (the user's own account,
   *  remembered per shell — they have more than one). */
  defaultChesscomUsername?: string;
  /** The OPEN game's active flag, when set: it carries over to the edited
   *  position and cannot be unchecked here (spec 219 B "no bypass"). */
  currentActiveGame?: ActiveGameMeta | null;
  /** Current board orientation — seeds the "I'm playing" selector so a user
   *  who already flipped the board isn't silently defaulted to White. */
  boardOrientation?: "white" | "black";
}

export function PositionEditorDialog({
  open,
  onOpenChange,
  currentFen,
  onSetPosition,
  onImagePaste,
  defaultChesscomUsername = "",
  currentActiveGame = null,
  boardOrientation = "white",
}: PositionEditorDialogProps) {
  const [pieces, setPieces] = useState<PieceMap>(new Map());
  const [turn, setTurn] = useState<Color>("white");
  const [castling, setCastling] = useState<CastlingOptions>({ K: false, Q: false, k: false, q: false });
  const [tool, setTool] = useState<Tool>({ kind: "pointer" });
  const [orientation, setOrientation] = useState<Color>("white");
  const [fenText, setFenText] = useState("");
  const [fenError, setFenError] = useState<string | null>(null);
  // Chess960 quick setup (spec 014): when on, the user places only White's
  // rank-1 pieces and the rest of the position is auto-generated live.
  const [chess960, setChess960] = useState(false);
  // Active-game flag (spec 219 A). Reset on every open; username prefilled
  // with the shell-remembered default.
  const [activeGameSetup, setActiveGameSetup] = useState<ActiveGameSetupValue>(
    emptyActiveGameSetup,
  );

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
    setChess960(false);
    setActiveGameSetup(emptyActiveGameSetup(defaultChesscomUsername, boardOrientation));
  }, [open, currentFen, applyState, defaultChesscomUsername, boardOrientation]);

  // Derived Chess960 state: what the user has placed on rank 1, whether it is a
  // legal 960 back rank, and (when legal) the full auto-completed start FEN.
  const chess960Slots = chess960 ? whiteBackRankSlots(pieces) : null;
  const chess960Validation = chess960Slots ? validate960BackRank(chess960Slots) : null;
  const chess960Fen =
    chess960Slots && chess960Validation?.valid
      ? complete960Fen(chess960Slots as Role[])
      : null;

  // In 960 mode we don't run the standard castling/turn machinery — just store
  // the placed pieces (White forced) and let the derived state drive the board.
  const applyPieces960 = useCallback((map: PieceMap) => {
    setPieces(map);
    setTurn("white");
  }, []);

  const enableChess960 = useCallback((on: boolean) => {
    setChess960(on);
    if (on) {
      // Fresh placement: empty rank-1 canvas, White to move.
      setPieces(new Map());
      setTurn("white");
      setTool({ kind: "pointer" });
    }
  }, []);

  const handleRandom960 = useCallback(() => {
    const rank = random960BackRank(Math.random);
    const map: PieceMap = new Map();
    rank.forEach((role, file) => map.set(`${FILES[file]}1`, { role, color: "white" }));
    applyPieces960(map);
  }, [applyPieces960]);

  const handleSelect = useCallback(
    (square: string) => {
      if (chess960) {
        // Only rank-1 White pieces matter; palette color is forced White.
        if (tool.kind === "piece" && isRank1(square)) {
          const map = new Map(pieces);
          map.set(square, { role: tool.role, color: "white" });
          applyPieces960(map);
        } else if (tool.kind === "erase" && pieces.has(square)) {
          const map = new Map(pieces);
          map.delete(square);
          applyPieces960(map);
        }
        return;
      }
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
    [chess960, tool, pieces, turn, castling, applyState, applyPieces960],
  );

  // A drag always relocates the piece (replacing any occupant) so Chessground's
  // own DOM and our placement state never diverge.
  const handleMove = useCallback(
    (from: string, to: string) => {
      if (chess960) {
        // Rank-1 rearrangement only; auto-generated pieces aren't draggable.
        if (!isRank1(from) || !isRank1(to)) return;
        const p = pieces.get(from);
        if (!p) return;
        const map = new Map(pieces);
        map.delete(from);
        map.set(to, { role: p.role, color: "white" });
        applyPieces960(map);
        return;
      }
      const p = pieces.get(from);
      if (!p) return;
      const map = new Map(pieces);
      map.delete(from);
      map.set(to, p);
      applyState(map, turn, castling);
    },
    [chess960, pieces, turn, castling, applyState, applyPieces960],
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
  // In 960 mode the board shows the auto-completed position when the rank-1
  // placement is legal, otherwise just the partial White rank the user is
  // building (no castling rights until it completes).
  const boardFen = chess960
    ? chess960Fen ?? pieceMapToFen(pieces, "white", NO_CASTLING)
    : pieceMapToFen(pieces, turn, castling);
  const confirmDisabled = chess960
    ? !chess960Fen
    : fenError !== null || !validateFen(boardFen).ok;

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
        className="bg-[#1e1c19] border-[#2a2825] text-[#bababa] sm:max-w-4xl"
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
          {/* ~560px at md+ (close to the main playing board); below md the
              wrapper shrinks to the dialog width and the Board's ResizeObserver
              follows (max 400 to keep the mobile layout intact). */}
          <div className="mx-auto md:mx-0 w-full max-w-[400px] md:w-[560px] md:max-w-none h-[448px] md:h-[608px]">
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
            {/* Chess960 quick setup (spec 014) */}
            <div className="flex flex-col gap-2 rounded border border-[#2a2825] bg-[#232120] p-2">
              <div className="flex items-center gap-2 flex-wrap">
                <label className="flex items-center gap-2 text-xs text-[#bababa]">
                  <input
                    type="checkbox"
                    checked={chess960}
                    onChange={(e) => enableChess960(e.target.checked)}
                    className="accent-green-600"
                    data-testid="chess960-checkbox"
                  />
                  Chess960 starting position
                </label>
                <button
                  type="button"
                  className={toolBtnClass(false)}
                  disabled={!chess960}
                  onClick={handleRandom960}
                  data-testid="chess960-random"
                >
                  Random 960
                </button>
              </div>
              {chess960 && (
                <p className="text-xs text-muted-foreground">
                  {chess960Fen ? (
                    <span className="text-green-500">
                      Valid 960 back rank — pawns, Black&apos;s mirror, and castling filled in.
                    </span>
                  ) : (
                    <span className="text-amber-400" data-testid="chess960-problem">
                      Place White&apos;s rank-1 pieces. {chess960Validation?.problem}
                    </span>
                  )}
                </p>
              )}
            </div>

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
                      {/* White backing square (spec 219 E, unconditional):
                          on the dark theme the bare glyphs made white vs
                          black pieces ambiguous. Black glyph text on white
                          keeps outlines dark, so ♔ reads white, ♚ black. */}
                      <span
                        aria-hidden
                        className="w-7 h-7 rounded-[5px] bg-white text-black flex items-center justify-center"
                        data-testid={`palette-${color}-${role}`}
                      >
                        {GLYPH[color][role]}
                      </span>
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

            {/* Side to move (Chess960 forces White) */}
            {!chess960 && (
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
            )}

            {/* Castling (derived from rook files in Chess960 mode) */}
            {!chess960 && (
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
            )}

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
                value={chess960 ? boardFen : fenText}
                onChange={(e) => handleFenInput(e.target.value)}
                readOnly={chess960}
                spellCheck={false}
                className="bg-[#2a2825] border border-[#3a3835] rounded px-2 py-1 text-xs font-mono text-[#bababa] w-full disabled:opacity-60"
              />
              {!chess960 && fenError && <span className="text-xs text-red-400">{fenError}</span>}
            </div>
          </div>
        </div>

        {/* Active-game flag (spec 219 A) — deliberately full-width and above
            the confirm button, not buried in an options row. */}
        <ActiveGameSetupSection
          value={activeGameSetup}
          onChange={setActiveGameSetup}
          lockedMeta={currentActiveGame}
        />

        <DialogFooter>
          <Button variant="ghost" className="text-muted-foreground" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="bg-green-600 hover:bg-green-700 text-white disabled:opacity-40"
            disabled={confirmDisabled}
            onClick={() => {
              // An already-flagged game keeps its ORIGINAL meta (same
              // flaggedAt, so it stays the same active-games record) —
              // spec 219 B: no unflag path through re-editing.
              onSetPosition(
                boardFen,
                currentActiveGame ?? activeGameMetaFromSetup(activeGameSetup),
              );
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

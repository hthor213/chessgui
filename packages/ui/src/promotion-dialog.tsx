"use client"

import { useEffect, useCallback, useState } from "react";
import type { PendingPromotion, PromotionRole } from "@/hooks/use-chess-game";

const PIECES: { role: PromotionRole; white: string; black: string; label: string }[] = [
  { role: "queen", white: "\u2655", black: "\u265B", label: "Queen" },
  { role: "rook", white: "\u2656", black: "\u265C", label: "Rook" },
  { role: "bishop", white: "\u2657", black: "\u265D", label: "Bishop" },
  { role: "knight", white: "\u2658", black: "\u265E", label: "Knight" },
];

// Bottom-sheet cutover (spec 223): the in-board column picker is too small
// for thumbs, so phone-width viewports get a fixed bottom sheet with four
// large targets instead. Media-query gated \u2014 desktop keeps the exact
// existing overlay.
const SHEET_QUERY = "(max-width: 640px)";

function useIsSheetViewport(): boolean {
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(SHEET_QUERY);
    const update = () => setSheet(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return sheet;
}

interface PromotionDialogProps {
  promotion: PendingPromotion;
  orientation: "white" | "black";
  boardSize: number;
  onConfirm: (role: PromotionRole) => void;
  onCancel: () => void;
}

export function PromotionDialog({
  promotion,
  orientation,
  boardSize,
  onConfirm,
  onCancel,
}: PromotionDialogProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
    },
    [onCancel],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const isSheet = useIsSheetViewport();

  if (isSheet) {
    // position:fixed escapes the board's absolutely-positioned overlay slot
    // (no transformed ancestors), so the sheet spans the real viewport.
    return (
      <>
        <div
          onClick={onCancel}
          className="fixed inset-0 z-[100] bg-black/50"
          data-testid="promotion-sheet-backdrop"
        />
        <div
          className="fixed inset-x-0 bottom-0 z-[101] rounded-t-2xl border-t border-white/10 bg-[#1a1a1a] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          data-testid="promotion-sheet"
        >
          <p className="text-center text-xs text-muted-foreground mb-2">Promote to</p>
          <div className="grid grid-cols-4 gap-2">
            {PIECES.map(({ role, white, black, label }) => (
              <button
                key={role}
                onClick={() => onConfirm(role)}
                data-testid={`promotion-sheet-${role}`}
                className="flex flex-col items-center justify-center gap-1 rounded-xl bg-[#f0d9b5] py-3 active:bg-[#e6c9a0]"
              >
                <span className="text-4xl leading-none text-black">
                  {promotion.color === "white" ? white : black}
                </span>
                <span className="text-[11px] font-medium text-black/70">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </>
    );
  }

  const squareSize = boardSize / 8;
  const file = promotion.to.charCodeAt(0) - 97; // 0-7
  const rank = parseInt(promotion.to[1]) - 1; // 0-7

  // Convert to visual coordinates based on orientation
  const visualFile = orientation === "white" ? file : 7 - file;
  const visualRank = orientation === "white" ? 7 - rank : rank;

  // Position the dialog column at the promotion file
  const left = visualFile * squareSize;

  // For white promoting (rank 8 = index 7), show from top; for black (rank 1 = index 0), show from bottom
  const promotingToTop = visualRank === 0;
  const top = promotingToTop ? 0 : (visualRank - 3) * squareSize;

  return (
    <>
      {/* Backdrop to catch clicks outside */}
      <div
        onClick={onCancel}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 100,
        }}
      />
      {/* Piece picker */}
      <div
        style={{
          position: "absolute",
          left,
          top,
          zIndex: 101,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        {PIECES.map(({ role, white, black }) => (
          <button
            key={role}
            onClick={() => onConfirm(role)}
            style={{
              width: squareSize,
              height: squareSize,
              fontSize: squareSize * 0.7,
              lineHeight: 1,
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#f0d9b5",
              padding: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "#e6c9a0";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "#f0d9b5";
            }}
          >
            {promotion.color === "white" ? white : black}
          </button>
        ))}
      </div>
    </>
  );
}

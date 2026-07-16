"use client"

import { useEffect, useCallback } from "react";
import type { PendingPromotion, PromotionRole } from "@/hooks/use-chess-game";

const PIECES: { role: PromotionRole; white: string; black: string }[] = [
  { role: "queen", white: "\u2655", black: "\u265B" },
  { role: "rook", white: "\u2656", black: "\u265C" },
  { role: "bishop", white: "\u2657", black: "\u265D" },
  { role: "knight", white: "\u2658", black: "\u265E" },
];

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

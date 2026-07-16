"use client"

import { scoreToNumeric, type PvLine } from "@chessgui/core/uci-parser"

interface EvalBarProps {
  score: PvLine["score"];
  turn: "white" | "black";
  /** Bar width in px (defaults to the analysis-panel size). */
  width?: number;
}

/** Vertical white/black evaluation bar, lichess-style. 50% = equal. */
export function EvalBar({ score, turn, width = 26 }: EvalBarProps) {
  const numeric = scoreToNumeric(score, turn);
  // Clamp to [-10, 10], map to percentage (50% = equal)
  const clamped = Math.max(-10, Math.min(10, numeric));
  const whitePct = 50 + (clamped / 10) * 50;

  return (
    <div
      className="min-h-[200px] rounded overflow-hidden flex flex-col shrink-0"
      style={{ height: "100%", width }}
    >
      <div
        className="transition-all duration-300 ease-in-out"
        style={{
          flex: `${100 - whitePct} 0 0`,
          backgroundColor: "#403d39",
        }}
      />
      <div
        className="flex items-start justify-center pt-0.5 transition-all duration-300 ease-in-out"
        style={{
          flex: `${whitePct} 0 0`,
          backgroundColor: "#e8e6e1",
        }}
      >
        {whitePct > 55 && (
          <span className="text-[9px] font-bold font-mono text-[#333]">
            {Math.abs(numeric).toFixed(1)}
          </span>
        )}
      </div>
    </div>
  );
}

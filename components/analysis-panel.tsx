"use client"

import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatScore, scoreToNumeric, type PvLine } from "@/lib/uci-parser"
import type { EngineState, EngineMode } from "@/hooks/use-engine"

interface AnalysisPanelProps {
  engine: {
    state: EngineState;
    startEngine: (path?: string, mode?: EngineMode) => Promise<void>;
    stopEngine: () => Promise<void>;
    toggleAnalysis: () => void;
  };
  turn: "white" | "black";
}

function formatNodes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

function EvalBar({ score, turn }: { score: PvLine["score"]; turn: "white" | "black" }) {
  const numeric = scoreToNumeric(score, turn);
  // Clamp to [-10, 10], map to percentage (50% = equal)
  const clamped = Math.max(-10, Math.min(10, numeric));
  const whitePct = 50 + (clamped / 10) * 50;

  return (
    <div className="w-[26px] min-h-[200px] rounded overflow-hidden flex flex-col shrink-0"
      style={{ height: "100%" }}
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

function ScoreBadge({ score, turn }: { score: PvLine["score"]; turn: "white" | "black" }) {
  const numeric = scoreToNumeric(score, turn);
  const colorClasses = numeric > 0.2
    ? "bg-green-700 text-green-100"
    : numeric < -0.2
      ? "bg-red-700 text-red-100"
      : "bg-gray-700 text-gray-100";

  return (
    <Badge
      variant="secondary"
      className={`min-w-[52px] font-mono font-bold ${colorClasses}`}
    >
      {formatScore(score, turn)}
    </Badge>
  );
}

function PvLineRow({ line, turn }: { line: PvLine; turn: "white" | "black" }) {
  return (
    <div className="flex flex-nowrap items-start gap-1.5">
      <ScoreBadge score={line.score} turn={turn} />
      <span className="text-xs text-muted-foreground font-mono leading-relaxed break-words">
        {line.sanMoves.join("  ")}
      </span>
    </div>
  );
}

export function AnalysisPanel({ engine, turn }: AnalysisPanelProps) {
  const { state } = engine;

  if (!state.isRunning) {
    return (
      <Card className="bg-[#1e1c19] border-[#2a2825] p-4">
        <div className="flex flex-col items-center gap-3 py-6">
          <span className="text-sm text-muted-foreground">
            No engine connected
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="bg-green-600 hover:bg-green-700 text-white"
              onClick={() => engine.startEngine()}
            >
              Analyze
            </Button>
            <Button
              size="sm"
              className="bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => engine.startEngine(undefined, "play")}
            >
              Play vs Stockfish
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  const topLine = state.lines.find((l) => l.multipv === 1);

  return (
    <div className="flex flex-nowrap items-stretch gap-0">
      {topLine && <EvalBar score={topLine.score} turn={turn} />}
      <Card className="bg-[#1e1c19] border-[#2a2825] p-3 flex-1 min-w-0">
        <div className="flex justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-[#bababa]">
              {state.engineName}
            </span>
            {state.mode === "play" ? (
              <Badge variant="secondary" className="text-blue-400 bg-blue-950 text-xs">
                Playing Black
              </Badge>
            ) : state.isAnalyzing ? (
              <span className="text-xs text-muted-foreground">
                depth {state.depth}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            {state.isAnalyzing && state.nps > 0 && (
              <span className="text-xs text-muted-foreground">
                {formatNodes(state.nps)}/s
              </span>
            )}
            {state.isThinking && state.nps > 0 && (
              <span className="text-xs text-muted-foreground">
                {formatNodes(state.nps)}/s
              </span>
            )}
            {state.mode !== "play" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => engine.toggleAnalysis()}>
                    <span className="text-xs">{state.isAnalyzing ? "\u23F8" : "\u25B6"}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {state.isAnalyzing ? "Pause" : "Resume"}
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-red-400 hover:text-red-300" onClick={() => engine.stopEngine()}>
                  <span className="text-xs">{"\u2715"}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Disconnect</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {topLine && (
          <p
            className="text-xl font-bold font-mono mb-1.5"
            style={{
              letterSpacing: -0.5,
              color: scoreToNumeric(topLine.score, turn) > 0.2
                ? "#7fba3a"
                : scoreToNumeric(topLine.score, turn) < -0.2
                  ? "#e05555"
                  : "#bababa",
            }}
          >
            {formatScore(topLine.score, turn)}
          </p>
        )}

        <div className="flex flex-col gap-1">
          {state.mode === "play" ? (
            state.isThinking ? (
              <>
                {state.lines.map((line) => (
                  <PvLineRow key={line.multipv} line={line} turn={turn} />
                ))}
                <span className="text-xs text-muted-foreground">
                  Thinking... depth {state.depth}
                </span>
              </>
            ) : (
              <>
                {state.lines.length > 0 && state.lines.map((line) => (
                  <PvLineRow key={line.multipv} line={line} turn={turn} />
                ))}
                <span className="text-xs text-muted-foreground">
                  Your move
                </span>
              </>
            )
          ) : (
            <>
              {state.lines.map((line) => (
                <PvLineRow key={line.multipv} line={line} turn={turn} />
              ))}
              {state.lines.length === 0 && state.isAnalyzing && (
                <span className="text-xs text-muted-foreground">
                  Calculating...
                </span>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

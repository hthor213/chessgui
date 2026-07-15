"use client"

import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Settings } from "lucide-react"
import { formatScore, scoreToNumeric, type PvLine } from "@/lib/uci-parser"
import { EvalBar } from "@/components/eval-bar"
import { HumanEvalSection } from "@/components/human-eval"
import { EngineSettingsDialog } from "@/components/engine-settings-dialog"
import { DEFAULT_PRIOR_CURVE, paceStrength, type EloCurve } from "@/lib/time-elo"
import { useMachineProfile } from "@/hooks/use-machine-profile"
import type { EngineSettings } from "@/lib/engine-settings"
import type { EngineState, EngineMode, PlayerColor } from "@/hooks/use-engine"

interface AnalysisPanelProps {
  engine: {
    state: EngineState;
    settings: EngineSettings;
    updateSettings: (next: EngineSettings) => Promise<void>;
    startEngine: (path?: string, mode?: EngineMode, playerColor?: PlayerColor) => Promise<void>;
    stopEngine: () => Promise<void>;
    toggleAnalysis: () => void;
    setPlayMode: (enabled: boolean, playerColor?: PlayerColor) => Promise<void>;
    enginePaceSeconds: number;
    setEnginePaceSeconds: (seconds: number) => void;
  };
  turn: "white" | "black";
  /** Click a PV move to preview the line up to it on the board (spec 011).
   *  Omitted in play mode — previews are an analysis-only affordance. */
  onPreviewPv?: (line: PvLine, ply: number) => void;
  /** Which line/ply is currently being previewed (highlights the prefix). */
  previewPv?: { multipv: number; ply: number } | null;
}

// The curve's own top anchor (216: b shrinks to its flattest, ~full-strength
// rate at 240s/move) doubles as the "how strong could it be" reference for
// the engine-pace readout — there's no separate user time control in the Play
// vs engine flow to compress against (spec 216 UI:4's "standalone" case).
const ENGINE_PACE_REFERENCE_SECONDS = 240
const ENGINE_PACE_MIN_SECONDS = 1
const ENGINE_PACE_MAX_SECONDS = 120

function EnginePaceControl({
  paceSeconds,
  onChange,
}: {
  paceSeconds: number
  onChange: (seconds: number) => void
}) {
  // Prefer this machine's measured b(t) curve once the Tier-1 ladder has fitted
  // one; fall back to the literature prior until then (spec 216:28-30).
  const { profile } = useMachineProfile()
  const curve = (profile?.curve as EloCurve | null) ?? DEFAULT_PRIOR_CURVE
  const clamped = Math.min(ENGINE_PACE_MAX_SECONDS, Math.max(ENGINE_PACE_MIN_SECONDS, paceSeconds))
  const logMin = Math.log2(ENGINE_PACE_MIN_SECONDS)
  const logMax = Math.log2(ENGINE_PACE_MAX_SECONDS)
  const fraction = ((Math.log2(clamped) - logMin) / (logMax - logMin)) * 100
  const referenceC = ENGINE_PACE_REFERENCE_SECONDS / clamped
  const readout = paceStrength(curve, ENGINE_PACE_REFERENCE_SECONDS, referenceC, {
    timeSensitive: true,
  })

  return (
    <div className="flex flex-col gap-1.5 w-full">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          Engine pace — {clamped < 1 ? `${Math.round(clamped * 1000)}ms` : `${clamped.toFixed(1)}s`}/move
        </span>
        <Badge variant="secondary" className="font-mono text-[10px]">
          {curve.source.toUpperCase()}
        </Badge>
      </div>
      <Slider
        data-testid="engine-pace-slider"
        min={0}
        max={100}
        step={0.5}
        value={[fraction]}
        onValueChange={([v]) => {
          const f = v / 100
          onChange(2 ** (logMin + f * (logMax - logMin)))
        }}
      />
      <span className="text-xs text-muted-foreground">{readout.reason}</span>
    </div>
  )
}

function formatNodes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
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

function PvLineRow({
  line,
  turn,
  onPreview,
  previewPly,
}: {
  line: PvLine;
  turn: "white" | "black";
  onPreview?: (line: PvLine, ply: number) => void;
  /** Ply of this line currently previewed, or null/undefined when not this line. */
  previewPly?: number | null;
}) {
  if (!onPreview) {
    return (
      <div className="flex flex-nowrap items-start gap-1.5">
        <ScoreBadge score={line.score} turn={turn} />
        <span className="text-xs text-muted-foreground font-mono leading-relaxed break-words">
          {line.sanMoves.join("  ")}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-nowrap items-start gap-1.5" data-testid={`pv-line-${line.multipv}`}>
      <ScoreBadge score={line.score} turn={turn} />
      <span className="text-xs font-mono leading-relaxed break-words">
        {line.sanMoves.map((san, i) => (
          <button
            key={i}
            className={`mr-1.5 rounded px-0.5 hover:text-foreground hover:bg-white/10 ${
              previewPly != null && i <= previewPly
                ? "text-sky-300 bg-sky-950/60"
                : "text-muted-foreground"
            }`}
            onClick={() => onPreview(line, i)}
            title="Preview this line on the board (does not change the game)"
            data-testid={`pv-move-${line.multipv}-${i}`}
          >
            {san}
          </button>
        ))}
      </span>
    </div>
  );
}

export function AnalysisPanel({ engine, turn, onPreviewPv, previewPv }: AnalysisPanelProps) {
  const { state } = engine;

  const isPlayWhite = state.mode === "play" && state.playerColor === "white";
  const isPlayBlack = state.mode === "play" && state.playerColor === "black";

  const settingsButton = (
    <EngineSettingsDialog
      settings={engine.settings}
      onSave={engine.updateSettings}
      trigger={
        <Button variant="ghost" size="icon" className="h-6 w-6" title="Engine settings">
          <Settings className="h-3.5 w-3.5" />
        </Button>
      }
    />
  );

  if (!state.isRunning) {
    return (
      <Card className="bg-[#1e1c19] border-[#2a2825] p-4">
        <div className="flex flex-col items-center gap-3 py-6">
          <div className="flex items-center gap-1">
            <span className="text-sm text-muted-foreground">
              No engine connected
            </span>
            {settingsButton}
          </div>
          <div className="flex flex-col gap-2 w-full">
            <Button
              size="sm"
              className="bg-green-600 hover:bg-green-700 text-white w-full"
              onClick={() => engine.startEngine()}
            >
              Analyze
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="w-full border-blue-600 text-blue-400 hover:bg-blue-950"
              onClick={() => engine.setPlayMode(true, "white")}
            >
              Play White vs Stockfish
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="w-full border-blue-600 text-blue-400 hover:bg-blue-950"
              onClick={() => engine.setPlayMode(true, "black")}
            >
              Play Black vs Stockfish
            </Button>
          </div>
          <div className="w-full border-t border-[#2a2825] pt-3">
            <EnginePaceControl
              paceSeconds={engine.enginePaceSeconds}
              onChange={engine.setEnginePaceSeconds}
            />
          </div>
        </div>
      </Card>
    );
  }

  const topLine = state.lines.find((l) => l.multipv === 1);
  // Use the turn from when scores were computed, not the live turn —
  // in play mode, cached lines persist after the engine moves but turn flips.
  const scoreTurn = state.scoreTurn ?? turn;

  return (
    <div className="flex flex-nowrap items-stretch gap-0">
      {topLine && <EvalBar score={topLine.score} turn={scoreTurn} />}
      <Card className="bg-[#1e1c19] border-[#2a2825] p-3 flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1 mb-1.5">
          {/* Informational text — clips at its box edge (overflow-hidden) so
              the action buttons always stay on screen, even in a narrow
              column. The buttons reserve their width via shrink-0 below. */}
          <div className="flex items-baseline gap-1.5 min-w-0 overflow-hidden whitespace-nowrap">
            <span className="text-xs font-semibold text-[#bababa]">
              {state.engineName}
            </span>
            {(state.isAnalyzing || state.isThinking) && state.depth > 0 && (
              <span className="text-xs text-muted-foreground">
                depth {state.depth}
              </span>
            )}
            {(state.isAnalyzing || state.isThinking) && state.nps > 0 && (
              <span className="text-xs text-muted-foreground">
                {formatNodes(state.nps)}/s
              </span>
            )}
          </div>
          {/* Action buttons — arrows toggle, settings, pause/resume, stop.
              shrink-0 keeps the whole cluster from being clipped. */}
          <div className="flex items-center gap-1 shrink-0">
            {state.mode !== "play" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-6 w-6 ${engine.settings.showArrows ? "text-blue-400 hover:text-blue-300" : "text-muted-foreground"}`}
                    onClick={() =>
                      engine.updateSettings({ ...engine.settings, showArrows: !engine.settings.showArrows })
                    }
                  >
                    <span className="text-xs">{"\u2197"}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {engine.settings.showArrows ? "Hide best-move arrows" : "Show best-move arrows"}
                </TooltipContent>
              </Tooltip>
            )}
            {settingsButton}
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

        {/* Play mode toggles */}
        <div className="flex items-center gap-3 mb-2">
          <div className="flex items-center gap-1.5">
            <Switch
              checked={isPlayWhite}
              onCheckedChange={(checked) => engine.setPlayMode(checked, "white")}
              className="scale-75 data-[state=checked]:bg-blue-600 data-[state=unchecked]:bg-zinc-600"
            />
            <span className={`text-xs ${isPlayWhite ? "text-blue-400 font-semibold" : "text-[#bababa]"}`}>
              White
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Switch
              checked={isPlayBlack}
              onCheckedChange={(checked) => engine.setPlayMode(checked, "black")}
              className="scale-75 data-[state=checked]:bg-blue-600 data-[state=unchecked]:bg-zinc-600"
            />
            <span className={`text-xs ${isPlayBlack ? "text-blue-400 font-semibold" : "text-muted-foreground"}`}>
              Black
            </span>
          </div>
        </div>

        {state.mode === "play" && (
          <div className="mb-2">
            <EnginePaceControl
              paceSeconds={engine.enginePaceSeconds}
              onChange={engine.setEnginePaceSeconds}
            />
          </div>
        )}

        {topLine && (
          <p
            className="text-xl font-bold font-mono mb-1.5"
            style={{
              letterSpacing: -0.5,
              color: scoreToNumeric(topLine.score, scoreTurn) > 0.2
                ? "#7fba3a"
                : scoreToNumeric(topLine.score, scoreTurn) < -0.2
                  ? "#e05555"
                  : "#bababa",
            }}
          >
            {formatScore(topLine.score, scoreTurn)}
          </p>
        )}

        <div className="flex flex-col gap-1">
          {state.mode === "play" ? (
            state.isThinking ? (
              <>
                {state.lines.map((line) => (
                  <PvLineRow key={line.multipv} line={line} turn={scoreTurn} />
                ))}
                <span className="text-xs text-muted-foreground">
                  Thinking... depth {state.depth}
                </span>
              </>
            ) : (
              <>
                {state.lines.length > 0 && state.lines.map((line) => (
                  <PvLineRow key={line.multipv} line={line} turn={scoreTurn} />
                ))}
                <span className="text-xs text-muted-foreground">
                  Your move
                </span>
              </>
            )
          ) : (
            <>
              {state.lines.map((line) => (
                <PvLineRow
                  key={line.multipv}
                  line={line}
                  turn={scoreTurn}
                  onPreview={onPreviewPv}
                  previewPly={previewPv?.multipv === line.multipv ? previewPv.ply : null}
                />
              ))}
              {state.lines.length === 0 && state.isAnalyzing && (
                <span className="text-xs text-muted-foreground">
                  Calculating...
                </span>
              )}
            </>
          )}
        </div>

        <HumanEvalSection
          analysisFen={state.analysisFen}
          scoreTurn={scoreTurn}
          lines={state.lines}
          engineRunning={state.isRunning}
        />
      </Card>
    </div>
  );
}

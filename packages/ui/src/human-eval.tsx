"use client"

import { Badge } from "@chessgui/ui/ui/badge"
import { Slider } from "@chessgui/ui/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@chessgui/ui/ui/tooltip"
import { MAIA_SLIDER_BANDS } from "@/lib/maia"
import { materialPawns } from "@/lib/human-eval"
import { clampTreePawns } from "@/lib/human-eval-tree"
import { useHumanEval } from "@/hooks/use-human-eval"
import type { PvLine } from "@chessgui/core/uci-parser"

interface HumanEvalSectionProps {
  analysisFen: string;
  scoreTurn: "white" | "black";
  lines: PvLine[];
  engineRunning: boolean;
}

const BANDS: readonly number[] = MAIA_SLIDER_BANDS; // [1100,1300,1500,1700,1900]

function formatPawns(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(2)}`;
}

function pawnColor(n: number): string {
  return n > 0.2 ? "#7fba3a" : n < -0.2 ? "#e05555" : "#bababa";
}

/** One "Label  value" row in the three-eval readout. */
function EvalRow({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className="text-xs font-mono font-bold tabular-nums"
        style={{ color: muted ? "#8a8a8a" : pawnColor(value) }}
      >
        {formatPawns(value)}
      </span>
    </div>
  );
}

/**
 * Tier-0 of the Elo-conditioned evaluator (spec 213): a rating slider whose
 * value blends the live Stockfish eval toward a no-resource baseline by how much
 * a rating-R human plays Stockfish's move. Stockfish and Human@R are shown side
 * by side — the divergence is the point.
 */
export function HumanEvalSection({
  analysisFen,
  scoreTurn,
  lines,
  engineRunning,
}: HumanEvalSectionProps) {
  const {
    available,
    band,
    setBand,
    result,
    loading,
    error,
    tree,
    setTree,
    treeResult,
    treeLoading,
    treeError,
  } = useHumanEval({
    analysisFen,
    scoreTurn,
    lines,
    engineRunning,
  });

  // No lc0 → hide the feature behind a one-line install hint (design §7.4).
  if (!available) {
    return (
      <div className="mt-2 pt-2 border-t border-[#2a2825]">
        <span className="text-[11px] text-muted-foreground">
          Human eval needs lc0 —{" "}
          <code className="font-mono text-[#bababa]">brew install lc0</code>
        </span>
      </div>
    );
  }

  const sliderIndex = band === null ? 0 : BANDS.indexOf(band) + 1;
  const onSlide = (v: number[]) => {
    const i = v[0];
    setBand(i === 0 ? null : BANDS[i - 1]);
  };

  // Tier-1 value when the tree toggle is on and a result matches the current
  // position; otherwise the tier-0 blend keeps rendering (progressive display).
  const treeValue = tree && treeResult ? clampTreePawns(treeResult.pawns) : null;

  return (
    <div className="mt-2 pt-2 border-t border-[#2a2825] flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[#bababa]">Human eval</span>
        <div className="flex items-center gap-1.5">
          {band !== null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="secondary"
                  className="h-4 px-1.5 text-[10px] font-normal bg-zinc-700 text-zinc-300 cursor-help"
                >
                  ≈ fast
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px] text-xs">
                Tier-0 instant estimate: blends the Stockfish eval toward a
                no-resource baseline by how often rating-{band} players actually
                play Stockfish&apos;s move. A one-pass approximation — toggle
                &quot;tree&quot; for the full human-visible-tree eval. Not yet
                win-prob calibrated.
              </TooltipContent>
            </Tooltip>
          )}
          {band !== null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setTree(!tree)}
                  aria-pressed={tree}
                  aria-label="Toggle human-visible tree search (tier-1, experimental)"
                >
                  <Badge
                    variant="secondary"
                    className={`h-4 px-1.5 text-[10px] font-normal cursor-pointer ${
                      tree
                        ? "bg-blue-900 text-blue-200"
                        : "bg-zinc-800 text-zinc-500"
                    }`}
                  >
                    tree
                  </Badge>
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px] text-xs">
                Tier-1 (experimental): a real search over only the moves
                rating-{band} humans consider — each node&apos;s candidates are
                the top-p of the Maia policy, leaves scored by Stockfish. Slower
                (~0.2–4 s/position); the fast estimate shows until it lands.
              </TooltipContent>
            </Tooltip>
          )}
          <span className="text-xs font-mono text-blue-400 min-w-[34px] text-right">
            {band === null ? "Off" : band}
          </span>
        </div>
      </div>

      <Slider
        value={[sliderIndex]}
        onValueChange={onSlide}
        min={0}
        max={BANDS.length}
        step={1}
        aria-label="Human eval rating"
      />
      <div className="flex justify-between text-[9px] text-muted-foreground font-mono px-0.5">
        <span>Off</span>
        {BANDS.map((b) => (
          <span key={b}>{b}</span>
        ))}
      </div>

      {band !== null && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          {result || treeValue !== null ? (
            <>
              <EvalRow label="Material" value={materialPawns(analysisFen)} muted />
              <EvalRow
                label={`Human@${band}${treeValue !== null ? " (tree)" : ""}`}
                value={treeValue !== null ? treeValue : result!.evalR}
              />
              {result && <EvalRow label="Stockfish" value={result.sfPawns} muted />}
              {result && (
                <span className="text-[10px] text-muted-foreground mt-0.5">
                  {`${band} plays Stockfish's move ${Math.round(result.w * 100)}% of the time`}
                  {result.anchorSource === "material" && " · baseline = material"}
                </span>
              )}
              {tree && (
                <span className="text-[10px] text-muted-foreground">
                  {treeValue !== null && treeResult
                    ? `tree: depth ${treeResult.depth} · ${treeResult.leaf_evals} Stockfish leaves · experimental`
                    : treeLoading
                      ? "Searching the human-visible tree…"
                      : treeError
                        ? humanizeError(treeError)
                        : null}
                </span>
              )}
            </>
          ) : loading ? (
            <span className="text-[10px] text-muted-foreground">Reading Maia policy…</span>
          ) : error ? (
            <span className="text-[10px] text-[#e0a055]">{humanizeError(error)}</span>
          ) : (
            <span className="text-[10px] text-muted-foreground">
              Waiting for a Stockfish eval…
            </span>
          )}
          {band === BANDS[BANDS.length - 1] && (
            <span className="text-[10px] text-muted-foreground mt-0.5">
              1900 is the top native Maia band; higher ratings need the high-band
              model (a later tier).
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function humanizeError(error: string): string {
  if (/download/i.test(error)) return "Couldn't download Maia weights — check your connection.";
  if (/terminal/i.test(error)) return "No human eval for a finished position.";
  if (/lc0 not found/i.test(error)) return "lc0 not found — brew install lc0.";
  if (/stockfish not found/i.test(error))
    return "Tree eval needs Stockfish — brew install stockfish.";
  return "Human eval unavailable for this position.";
}

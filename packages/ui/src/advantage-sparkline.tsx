"use client"

import { useMemo } from "react";
import { Card } from "@chessgui/ui/ui/card";
import { evalToUnit, nodeEval } from "@chessgui/core/annotations";
import type { GameTree } from "@chessgui/core/game-tree";

interface AdvantageSparklineProps {
  tree: GameTree;
  /** Bumped on every tree mutation (same contract as MoveList/EvalGraph). */
  version?: number;
}

// viewBox units; the SVG stretches to the card width (preserveAspectRatio
// "none"), so no ResizeObserver is needed at sparkline size.
const WIDTH = 100;
const HEIGHT = 28;
// Same inks and domain convention as the eval graph (eval-graph.tsx): the
// filled area is White's share of the advantage, the exposed background
// Black's. White is light.
const WHITE_AREA = "#cfccc7";
const PLOT_BG = "#12100e";
const MIDLINE = "rgba(255,255,255,0.18)";

/**
 * Advantage-area sparkline for the left player panel (spec 001 §3 "Match
 * History"). The eval graph's little sibling: the same mainline eval history
 * squashed to [-1, 1], at glanceable size — no axes, no hover, no cursor.
 * Renders nothing until at least two evals exist.
 */
export function AdvantageSparkline({ tree, version }: AdvantageSparklineProps) {
  const units = useMemo(() => {
    return tree
      .mainlineNodes()
      .slice(1) // drop the root — plies only, matching the eval graph's x-axis
      .map((node) => {
        const ev = nodeEval(node);
        return ev ? evalToUnit(ev) : null;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, version]);

  const known = units
    .map((unit, i) => ({ unit, i }))
    .filter((p): p is { unit: number; i: number } => p.unit !== null);
  if (known.length < 2) return null;

  const xFor = (i: number) => (units.length <= 1 ? WIDTH / 2 : (i / (units.length - 1)) * WIDTH);
  const yFor = (unit: number) => ((1 - unit) / 2) * HEIGHT;

  // Area path: along the eval curve (gaps bridged linearly), closed down to
  // the bottom edge — the filled region is White's share.
  const curve = known
    .map((p, k) => `${k === 0 ? "M" : "L"}${xFor(p.i).toFixed(1)},${yFor(p.unit).toFixed(1)}`)
    .join(" ");
  const first = known[0];
  const last = known[known.length - 1];
  const areaPath = `${curve} L${xFor(last.i).toFixed(1)},${HEIGHT} L${xFor(first.i).toFixed(1)},${HEIGHT} Z`;

  return (
    <Card
      className="bg-secondary/40 backdrop-blur-md border-white/10 p-3"
      data-testid="advantage-sparkline"
    >
      <span className="text-xs font-semibold text-[#bababa] mb-1.5 block">Advantage</span>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="block w-full rounded-sm"
        style={{ height: HEIGHT }}
      >
        <rect x={0} y={0} width={WIDTH} height={HEIGHT} fill={PLOT_BG} />
        {/* Spec 001 §3: "advantage area with linear gradient fill" */}
        <defs>
          <linearGradient id="advantage-sparkline-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={WHITE_AREA} />
            <stop offset="100%" stopColor={WHITE_AREA} stopOpacity={0.55} />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#advantage-sparkline-fill)" />
        {/* midline (eval 0) above the fill so it reads on both regions */}
        <line
          x1={0}
          x2={WIDTH}
          y1={HEIGHT / 2}
          y2={HEIGHT / 2}
          stroke={MIDLINE}
          strokeWidth={0.75}
          strokeDasharray="2,2"
        />
      </svg>
    </Card>
  );
}

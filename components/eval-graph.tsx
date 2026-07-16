"use client"

import { useMemo, useRef, useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { evalToUnit, formatEval, judgeMove, nodeEval, type MoveJudgment } from "@/lib/annotations";
import type { GameTree, MoveNode } from "@/lib/game-tree";

interface EvalGraphProps {
  tree: GameTree;
  currentId: string;
  onGoToNode: (id: string) => void;
  /** Bumped on every tree mutation (same contract as MoveList). */
  version?: number;
}

const HEIGHT = 72;
const PAD_X = 4;
const PAD_Y = 4;

// Chart inks. The area below the curve is White's share of the advantage
// (domain convention: White is light), the exposed background is Black's.
const WHITE_AREA = "#cfccc7";
const PLOT_BG = "#12100e";
const MIDLINE = "rgba(255,255,255,0.18)";
const CURVE = "#8a8783";
const CURRENT = "rgba(155,199,0,0.9)"; // matches the move list's current-move accent
// Judgment-dot inks (status colors, not series colors). The PLOT_BG ring keeps
// them legible where they land on the light fill region.
const MISTAKE = "#e69f00";
const BLUNDER = "#df5353";

interface Point {
  node: MoveNode;
  index: number; // 1-based ply position on the mainline
  unit: number | null; // eval squashed to [-1, 1]; null when unknown
  judgment: MoveJudgment | null; // null when fine or either side's eval is unknown
}

/**
 * Eval-per-move area chart for the mainline (spec 202). Pure inline SVG — no
 * chart library. Reads stored engine evals (node.eval) with [%eval] comment
 * tags as fallback, so imported Lichess games plot immediately. Click a point
 * to jump there; the vertical marker tracks the current move.
 */
export function EvalGraph({ tree, currentId, onGoToNode, version }: EvalGraphProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(200);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(Math.max(60, el.getBoundingClientRect().width));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const points = useMemo<Point[]>(() => {
    const mainline = tree.mainlineNodes(); // [0] is the root
    return mainline.slice(1).map((node, i) => {
      const ev = nodeEval(node);
      const before = nodeEval(mainline[i]); // parent = position the move was played from
      return {
        node,
        index: i + 1,
        unit: ev ? evalToUnit(ev) : null,
        judgment: ev && before ? judgeMove(before, ev, node.ply % 2 === 1) : null,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, version]);

  const n = points.length;
  const xFor = (index: number) =>
    n <= 1 ? width / 2 : PAD_X + ((index - 1) / (n - 1)) * (width - 2 * PAD_X);
  // unit +1 (White winning) maps to the top of the plot.
  const yFor = (unit: number) => PAD_Y + ((1 - unit) / 2) * (HEIGHT - 2 * PAD_Y);

  const known = points.filter((p): p is Point & { unit: number } => p.unit !== null);

  // Area path: along the eval curve (gaps bridged linearly), then closed down
  // to the bottom edge — the filled region is White's share.
  const areaPath = useMemo(() => {
    if (known.length === 0) return "";
    const curve = known
      .map((p, i) => `${i === 0 ? "M" : "L"}${xFor(p.index).toFixed(1)},${yFor(p.unit).toFixed(1)}`)
      .join(" ");
    const first = known[0];
    const last = known[known.length - 1];
    return `${curve} L${xFor(last.index).toFixed(1)},${HEIGHT} L${xFor(first.index).toFixed(1)},${HEIGHT} Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, width]);

  const curvePath = useMemo(() => {
    return known
      .map((p, i) => `${i === 0 ? "M" : "L"}${xFor(p.index).toFixed(1)},${yFor(p.unit).toFixed(1)}`)
      .join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, width]);

  // Where the cursor is on the mainline: the deepest ancestor-or-self of the
  // current node that lies on it (variations mark their branch point).
  const currentIndex = useMemo(() => {
    const byId = new Map(points.map((p) => [p.node.id, p.index]));
    const path = tree.pathToNode(currentId);
    for (let i = path.length - 1; i >= 0; i--) {
      const idx = byId.get(path[i].id);
      if (idx !== undefined) return idx;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, currentId, version, points]);

  const indexFromMouse = (clientX: number): number | null => {
    if (n === 0) return null;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = clientX - rect.left;
    if (n === 1) return 1;
    const t = (x - PAD_X) / (width - 2 * PAD_X);
    return Math.min(n, Math.max(1, Math.round(t * (n - 1)) + 1));
  };

  // `?? null` guards a hover index that outlives a shrinking game (new game
  // while the pointer is over the chart).
  const hover = hoverIdx !== null ? (points[hoverIdx - 1] ?? null) : null;
  const hoverEval = hover ? nodeEval(hover.node) : null;
  const moveLabel = (p: Point) =>
    `${Math.ceil(p.node.ply / 2)}${p.node.ply % 2 === 1 ? "." : "..."} ${p.node.san}`;

  return (
    <Card className="bg-[#1e1c19] border-[#2a2825] p-3 shrink-0">
      <span className="text-xs font-semibold text-[#bababa] mb-2 block">Evaluation</span>
      <div
        ref={wrapRef}
        className="relative w-full cursor-pointer select-none"
        style={{ height: HEIGHT }}
        onMouseMove={(e) => setHoverIdx(indexFromMouse(e.clientX))}
        onMouseLeave={() => setHoverIdx(null)}
        onClick={(e) => {
          const idx = indexFromMouse(e.clientX);
          if (idx !== null) onGoToNode(points[idx - 1].node.id);
        }}
      >
        <svg width={width} height={HEIGHT} className="block rounded-sm">
          <rect x={0} y={0} width={width} height={HEIGHT} fill={PLOT_BG} />
          {areaPath && <path d={areaPath} fill={WHITE_AREA} />}
          {curvePath && <path d={curvePath} fill="none" stroke={CURVE} strokeWidth={1} />}
          {/* midline (eval 0) above the fill so it stays readable on both regions */}
          <line x1={0} x2={width} y1={HEIGHT / 2} y2={HEIGHT / 2} stroke={MIDLINE} strokeWidth={1} strokeDasharray="3,3" />
          {/* Blunder/mistake dots (spec 202); inaccuracies stay tooltip-only
              to keep the chart calm. */}
          {points.map((p) =>
            p.unit !== null && (p.judgment === "blunder" || p.judgment === "mistake") ? (
              <circle
                key={p.node.id}
                cx={xFor(p.index)}
                cy={yFor(p.unit)}
                r={3}
                fill={p.judgment === "blunder" ? BLUNDER : MISTAKE}
                stroke={PLOT_BG}
                strokeWidth={1.5}
              />
            ) : null,
          )}
          {currentIndex !== null && (
            <line
              x1={xFor(currentIndex)}
              x2={xFor(currentIndex)}
              y1={0}
              y2={HEIGHT}
              stroke={CURRENT}
              strokeWidth={1.5}
            />
          )}
          {hover && hover.unit !== null && (
            <circle cx={xFor(hover.index)} cy={yFor(hover.unit)} r={3} fill={CURRENT} stroke={PLOT_BG} strokeWidth={1.5} />
          )}
        </svg>
        {/* A single point plots as an invisible sliver, so show the hint until
            there are at least two evals to actually draw a curve between. */}
        {known.length < 2 ? (
          <span className="absolute inset-0 flex items-center justify-center px-3 text-center text-xs text-[#6a6763] pointer-events-none">
            {n === 0
              ? "Play or load a game"
              : "Evals appear as you step through moves during analysis, or import a game with evals"}
          </span>
        ) : null}
        {hover && (
          <div
            className="absolute -top-1 px-1.5 py-0.5 rounded-sm bg-[#2a2825] border border-[#3a3835] text-xs font-mono text-foreground whitespace-nowrap pointer-events-none z-10"
            style={{
              left: Math.min(Math.max(xFor(hover.index), 30), width - 30),
              transform: "translate(-50%, -100%)",
            }}
          >
            {moveLabel(hover)} {hoverEval ? formatEval(hoverEval) : "—"}
            {hover.judgment ? ` · ${hover.judgment}` : ""}
          </div>
        )}
      </div>
    </Card>
  );
}

"use client";

// The Notebook's read-only display atoms (spec 226 C/F), shared by the move
// list, the move table and the notebook panel.
//
// Everything here is derived from the user's own handwriting: their
// assessments, their candidates. Nothing in this file knows the rules of
// chess, so there is no path by which it could name, count or hint at a move
// the user did not play themselves — which is the whole point (spec 226 "Two
// co-equal goals").

import {
  coverageLabel,
  formatPoint,
  formatValue,
  isProvisional,
} from "@chessgui/core/notebook";
import type { NodeValue } from "@chessgui/core/notebook";

/**
 * How a tree view should read the notebook. `sortByRank` is display order
 * ONLY — the stored tree and the exported PGN are byte-identical either way,
 * because the order the user explored in is real history (spec 226 F).
 */
export interface NotebookRender {
  values: Map<string, NodeValue>;
  sortByRank: boolean;
}

/**
 * A badge is worth its space only where the user actually wrote something: a
 * backed-up value, or more than one named candidate. An untouched game record
 * would otherwise sprout "0/1" against every move it has, which is noise
 * dressed up as bookkeeping.
 */
export function notebookBadgeVisible(v: NodeValue | undefined): boolean {
  return !!v && (v.objective !== null || v.named > 1);
}

/**
 * How settled a candidate is, as three dots rather than a fraction.
 *
 * The fraction it replaces ("1/7") was a second, noisier copy of what the
 * value range already said — a barely-examined branch got a range spanning
 * four bands precisely because it was barely examined, so the two numbers
 * restated each other and neither said what the player concluded (user
 * 2026-07-21). Confidence is a property you glance at; the value is the thing
 * you read.
 *
 * Lives here rather than in the panel because the candidates table reads the
 * same fact, and two drawings of one number is how a second visual language
 * starts. 13px floor on the dots, like everything else the user reads mid-think.
 */
export function Confidence({ value }: { value: NodeValue | undefined }) {
  if (!value || value.named <= 1) return <span />;
  const filled = Math.round((value.examined / value.named) * 3);
  return (
    <span
      className="font-mono text-[13px] tracking-tight text-muted-foreground/70 shrink-0"
      title={`${value.examined} of my ${value.named} candidates examined here`}
      data-testid="notebook-confidence"
    >
      {"●".repeat(filled)}
      {"○".repeat(Math.max(0, 3 - filled))}
    </span>
  );
}

/**
 * Backed-up value + coverage, side by side and never mixed: the value is what
 * the user judged, the coverage is how much of their own candidate list it
 * rests on. Under-examined branches read as a RANGE rather than a point,
 * because the honest statement is "somewhere between these, as far as I could
 * see" (spec 226 C).
 */
export function NotebookBadge({
  value,
  // The "?" is a coverage statement: it is true exactly when unexamined
  // candidates of the user's own remain, which is exactly what a fraction
  // ("1/3") or the confidence dots beside it already say. Where one of those is
  // on the same line, the marker is off — one drawing of one number (user
  // 2026-07-21). The quieter colour stays either way: that is a texture, not a
  // second symbol to parse.
  marker = true,
}: {
  value: NodeValue | undefined;
  marker?: boolean;
}) {
  if (!notebookBadgeVisible(value)) return null;
  const v = value as NodeValue;
  const val = formatPoint(v);
  if (!val) return null;
  const provisional = isProvisional(v);
  return (
    <span
      className={`inline-flex items-baseline mr-1 select-none align-baseline text-[13px] font-mono rounded-sm px-1.5 py-px bg-white/5 ${
        // A provisional value is shown quieter rather than wider: the reader
        // should see at a glance which conclusions are settled, without having
        // to parse a second symbol pair (user 2026-07-21).
        provisional ? "text-[#c9d99a]/55" : "text-[#c9d99a]"
      }`}
      data-testid="notebook-value"
      title={
        provisional
          ? `${formatValue(v)} — as far as I could see. ${coverageLabel(v) || "More of my candidates could still move this."}`
          : "My backed-up judgement"
      }
    >
      {val}
      {provisional && marker && <span className="ml-px opacity-70">?</span>}
    </span>
  );
}

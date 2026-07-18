// Per-game performance Elo (spec 202) — desktop wiring.
//
// The pure estimator lives in @chessgui/core/performance-elo (band likelihood
// under the corpus error model, with an ACPL fallback). This module is the only
// place the desktop shell couples that math to the corpus data file: it bundles
// the fitted model (data/personas/error_model.fit.json) and binds it into the
// estimator so callers keep the same `estimatePerformance(mainline)` signature.
//
// The fit is imported as a build-time static asset — it must be present in the
// checkout (spec 202's 2026-07-17 decision makes it the primary data source).
// If a side can't be scored against the corpus, the estimator degrades to the
// ACPL fallback on its own; the honesty gate is in core.

import {
  estimatePerformance as estimatePerformanceCore,
  type ErrorModelFit,
  type PerformanceElo,
  type SidePerformance,
} from "@chessgui/core/performance-elo"
import type { MoveNode } from "@chessgui/core/game-tree"
import fitJson from "../../../data/personas/error_model.fit.json"

// The 300KB JSON's inferred literal type is erased here so it doesn't ripple
// into tsc across the app.
const ERROR_MODEL_FIT = fitJson as unknown as ErrorModelFit

export type { PerformanceElo, SidePerformance }

/** Estimate each player's performance for the game's mainline (see core). */
export function estimatePerformance(mainline: MoveNode[]): PerformanceElo {
  return estimatePerformanceCore(mainline, ERROR_MODEL_FIT)
}

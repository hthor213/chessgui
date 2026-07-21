// Post-game review (spec 226 H): the shell half of the diagnosis.
//
// packages/core/notebook-diagnosis.ts owns the comparison — the player's
// recorded thinking against the engine's verdict, split into blind spot /
// misjudgement / selection error / opponent-model error. It is pure and takes
// the evals as an argument. This module is what PRODUCES those evals: it turns
// a training record into a target list, drives the batch runner over it, and
// hands the result back to the diagnosis.
//
// The one rule this file exists to enforce is spec 226's hardest: the whole
// output is engine-derived, so NONE of it may be reachable from a live game.
// That is not left to a hidden button. Every entry point here goes through
// `reviewContextFor`, which refuses unless the record says post-game TWICE —
// the archive flag is set (the only transition that lifts the spec 219
// lockout) and the embedded tree carries no active-game flag. An absent record
// refuses, the same inverted default as the training store's position gate:
// a caller who cannot say where it is standing gets a no.
//
// Nothing here writes anything back. The diagnosis is a document the caller
// renders and drops; no engine number reaches a node, a NAG, or `assessedBy`.

import {
  UNRESTRICTED_ENGINE_CONTEXT,
  type ActiveGameRecord,
} from "@chessgui/core/active-game"
import {
  diagnoseGame,
  type EngineBestMove,
  type EngineBestMoves,
  type EngineEvals,
  type GameDiagnosis,
} from "@chessgui/core/notebook-diagnosis"
import type { NodeEval } from "@chessgui/core/game-tree"
import { REDACTED_FEN, type TrainingRecord } from "@chessgui/core/training-record"
import { uciMovesToSan } from "@chessgui/core/uci-parser"
import { getProviders } from "@/lib/platform"
import { loadEnginePath, loadEngineSettings, treeChess960 } from "@/lib/engine-settings"
import { runGameAnalysis, type AnalysisTarget } from "@/lib/game-analysis"
import { getTrainingRecordForGame } from "@/lib/training-records"

/** Engine slot for the review — its own, so a review and an "Analyze Game"
 *  run cannot steal each other's engine process. */
export const NOTEBOOK_REVIEW_SESSION = "notebook-review"

export const REVIEW_REFUSED =
  "Post-game review is engine-derived and runs only on an archived game — " +
  "the game must be finished and imported before any of it exists (fair play, " +
  "spec 219 D / 226 H)."

export const REVIEW_NO_RECORD =
  "No training record for this game — nothing was written down while it was played."

export const REVIEW_REDACTED =
  "This training record came back without positions, so there is nothing to review."

/**
 * Whether the review may run at all.
 *
 * Two independent facts, both required, because they can only disagree if
 * something is wrong: `archived` is the flag the archive step sets and the only
 * transition that lifts the lockout, and an archived record's embedded tree has
 * had its active-game flag deleted. A record that claims one and not the other
 * is not a game we are willing to point an engine at.
 */
export function reviewAllowed(record: ActiveGameRecord | null | undefined): boolean {
  return !!record && record.archived === true && record.tree.activeGame === undefined
}

/**
 * The engine/query context for a review — and the only way to obtain one.
 *
 * Throwing here rather than returning a flag is deliberate: it makes the gate
 * impossible to forget downstream, because there is no context to pass on
 * without having gone through it.
 */
export function reviewContextFor(record: ActiveGameRecord | null | undefined): string {
  if (!reviewAllowed(record)) throw new Error(REVIEW_REFUSED)
  return UNRESTRICTED_ENGINE_CONTEXT
}

/**
 * The record of how the player thought in this game, reached BY THE GAME —
 * never by a position (spec 226 G/J). `null` for the active-game argument is
 * the truthful reading only because the gate above has already established
 * that this game is finished and archived.
 */
export async function loadReviewRecord(
  record: ActiveGameRecord,
): Promise<TrainingRecord | null> {
  reviewContextFor(record)
  return getTrainingRecordForGame(
    { activeGameId: record.id, gameUrl: record.meta.gameUrl },
    null,
  )
}

/**
 * Every position the diagnosis needs an eval for.
 *
 * Two per comparison: the position the decision was made FROM (the decision's
 * own node id, whose eval is the value of the engine's best move there) and the
 * position after each candidate. Both already carry their FEN in the record, so
 * this is a projection and not a replay — no move is generated, and in
 * particular no move the player did not name is ever put on a board.
 *
 * Deduped by node id: a candidate at one decision is the decision node at the
 * next, and searching the same position twice would double a long game's cost
 * for nothing.
 */
export function reviewTargets(training: TrainingRecord): AnalysisTarget[] {
  const out: AnalysisTarget[] = []
  const seen = new Set<string>()
  const push = (id: string, fen: string, uci: string) => {
    if (!fen || fen === REDACTED_FEN || seen.has(id)) return
    seen.add(id)
    out.push({ id, fen, uci })
  }
  for (const d of training.decisions) {
    push(d.nodeId, d.fen, "")
    // Every candidate, not only the player's own: an explorer-served move still
    // needs its eval for the played move's loss and the opponent-model cost.
    // What `own` governs is the DIAGNOSIS (core decides what counts as a
    // candidate they named); it is not a reason to leave a position unsearched.
    for (const c of d.candidates) push(c.nodeId, c.fen, c.uci)
  }
  return out
}

export interface ReviewRunOptions {
  record: ActiveGameRecord
  training: TrainingRecord
  onProgress?: (done: number, total: number) => void
  isCancelled?: () => boolean
  movetimeMs?: number
}

export interface ReviewRunResult {
  diagnosis: GameDiagnosis | null
  /** Positions the engine actually answered for — the honest denominator
   *  behind a cancelled or partial run. */
  evaluated: number
  /** Positions the run set out to search. `evaluated < targeted` is a PARTIAL
   *  review, and the surface has to say so: the counts underneath it are drawn
   *  from a denominator the user never chose. */
  targeted: number
  error: string | null
}

/**
 * Run the engine over the recorded positions and diagnose the game.
 *
 * A cancelled or errored run still diagnoses what it got: the decisions with no
 * eval drop out of `scoredDecisions`, and a decision whose candidate list was
 * only partly searched reports no blind spot at all (core suppresses the class
 * below full coverage — the claim is about the WHOLE list). Half a review is
 * worth reading; throwing it away because the user stopped it is not. But it
 * must be LABELLED half a review, which is what `targeted` is for.
 */
export async function runNotebookReview(opts: ReviewRunOptions): Promise<ReviewRunResult> {
  reviewContextFor(opts.record)

  const targets = reviewTargets(opts.training)
  if (targets.length === 0) {
    return { diagnosis: null, evaluated: 0, targeted: 0, error: REVIEW_REDACTED }
  }

  const evals = new Map<string, NodeEval>()
  const bestMoves = new Map<string, EngineBestMove>()
  // Decision positions only: a best move is worth naming where the player was
  // choosing, and `EngineBestMoves` is keyed by the position it is played from.
  const decisionFens = new Map<string, string>(
    opts.training.decisions.map((d) => [d.nodeId, d.fen]),
  )

  const settings = loadEngineSettings()
  const result = await runGameAnalysis({
    engine: getProviders().engine,
    enginePath: loadEnginePath(),
    targets,
    // The record is archived, so there IS no active game to serve. The runner
    // re-checks this before every search; passing `null` is a statement the
    // gate above has already made true.
    activeGame: () => null,
    isCancelled: () => opts.isCancelled?.() ?? false,
    threads: settings.threads,
    hash: settings.hash,
    chess960: treeChess960(opts.record.tree),
    independent: true,
    sessionId: NOTEBOOK_REVIEW_SESSION,
    ...(opts.movetimeMs !== undefined ? { movetimeMs: opts.movetimeMs } : {}),
    callbacks: {
      onEval: (id, ev) => evals.set(id, ev),
      // Never fires: judgments are suppressed in independent mode, because a
      // swing between two positions that never followed one another is not one.
      onJudgment: () => {},
      onProgress: (done, total) => opts.onProgress?.(done, total),
      onBestMove: (id, uci) => {
        const fen = decisionFens.get(id)
        if (!fen) return
        // SAN so the miss reads as chess. `uciMovesToSan` returns nothing for a
        // move the position does not admit, and an unnamed blind spot is the
        // documented fallback — better than printing a move that isn't there.
        const san = uciMovesToSan(fen, [uci], 1)[0]
        if (san) bestMoves.set(id, { san, uci })
      },
    },
  })

  const diagnosis = diagnoseGame(opts.training, evals as EngineEvals, {
    // Same gate, stated again at the pure boundary: core refuses a diagnosis
    // for any context but this one, and this one was earned above.
    context: reviewContextFor(opts.record),
    bestMoves: bestMoves as EngineBestMoves,
  })

  return { diagnosis, evaluated: evals.size, targeted: targets.length, error: result.error }
}

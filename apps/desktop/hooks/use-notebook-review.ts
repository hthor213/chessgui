// React shell around lib/notebook-review.ts (spec 226 H): loads the training
// record for one archived game, drives the engine over its recorded positions,
// and holds the diagnosis for the reading surface to render.
//
// The gate is not this hook's to relax. `reviewAllowed` is re-checked here
// before the record is even loaded, so a caller that renders the screen for a
// live game gets a refusal in place of a review rather than a hidden button —
// and lib/notebook-review refuses again on the way to the engine.

import { useCallback, useEffect, useRef, useState } from "react"
import type { ActiveGameRecord } from "@chessgui/core/active-game"
import type { GameDiagnosis } from "@chessgui/core/notebook-diagnosis"
import type { TrainingRecord } from "@chessgui/core/training-record"
import { getProviders } from "@/lib/platform"
import {
  loadReviewRecord,
  NOTEBOOK_REVIEW_SESSION,
  reviewAllowed,
  REVIEW_NO_RECORD,
  REVIEW_REFUSED,
  runNotebookReview,
} from "@/lib/notebook-review"

export interface NotebookReviewState {
  /** The record is being read off disk. */
  loading: boolean
  /** The engine is working through the recorded positions. */
  running: boolean
  done: number
  total: number
  /** How the player thought — present as soon as it loads, engine or not. */
  training: TrainingRecord | null
  diagnosis: GameDiagnosis | null
  /**
   * Positions the engine answered for, and positions the run set out to
   * search. They differ when the user pressed Stop or the engine failed
   * part-way, and the surface has to SAY so: a truncated run and a complete one
   * render identical counts otherwise, and "N reviewed decisions" out of an
   * unstated denominator is the review overclaiming about the user's chess.
   */
  evaluated: number
  targeted: number
  error: string | null
}

const IDLE: NotebookReviewState = {
  loading: false,
  running: false,
  done: 0,
  total: 0,
  training: null,
  diagnosis: null,
  evaluated: 0,
  targeted: 0,
  error: null,
}

export function useNotebookReview(record: ActiveGameRecord | null) {
  const [state, setState] = useState<NotebookReviewState>(IDLE)
  const runningRef = useRef(false)
  const cancelledRef = useRef(false)
  // The run reads the record it started with, not whatever is on screen when
  // it finishes: switching games mid-review must not land one game's evals on
  // another game's decisions.
  const recordRef = useRef(record)
  recordRef.current = record

  // A different game is a different review. Everything resets, including a
  // diagnosis the user was reading — leaving it up under a new heading would
  // be the worst possible lie this screen could tell.
  useEffect(() => {
    cancelledRef.current = true
    if (!record) {
      setState(IDLE)
      return
    }
    if (!reviewAllowed(record)) {
      setState({ ...IDLE, error: REVIEW_REFUSED })
      return
    }
    let live = true
    setState({ ...IDLE, loading: true })
    loadReviewRecord(record)
      .then((training) => {
        if (!live) return
        setState({
          ...IDLE,
          training,
          error: training ? null : REVIEW_NO_RECORD,
        })
      })
      .catch((e: unknown) => {
        if (!live) return
        setState({ ...IDLE, error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      live = false
    }
  }, [record])

  const cancel = useCallback(() => {
    if (!runningRef.current) return
    cancelledRef.current = true
    // Shortens the search in flight; the runner exits at its next step check.
    getProviders()
      .engine.sendCommand("stop", undefined, NOTEBOOK_REVIEW_SESSION)
      .catch(() => {})
  }, [])

  const run = useCallback(async () => {
    if (runningRef.current) return
    const current = recordRef.current
    const training = state.training
    if (!current || !training) return
    runningRef.current = true
    cancelledRef.current = false
    setState((s) => ({ ...s, running: true, done: 0, total: 0, error: null }))

    const result = await runNotebookReview({
      record: current,
      training,
      isCancelled: () => cancelledRef.current || recordRef.current !== current,
      onProgress: (done, total) => setState((s) => ({ ...s, done, total })),
    }).catch((e: unknown) => ({
      diagnosis: null,
      evaluated: 0,
      targeted: 0,
      error: e instanceof Error ? e.message : String(e),
    }))

    runningRef.current = false
    // A review that outlived its game is discarded rather than displayed: its
    // node ids belong to a record nobody is looking at any more.
    if (recordRef.current !== current) return
    setState((s) => ({
      ...s,
      running: false,
      diagnosis: result.diagnosis,
      evaluated: result.evaluated,
      targeted: result.targeted,
      error: result.error,
    }))
  }, [state.training])

  // Leaving the screen abandons the run and stops this session's process.
  useEffect(() => {
    return () => {
      cancelledRef.current = true
      getProviders().engine.stopEngine(NOTEBOOK_REVIEW_SESSION).catch(() => {})
    }
  }, [])

  return { state, run, cancel }
}

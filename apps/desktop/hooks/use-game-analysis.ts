// React shell around lib/game-analysis.ts's batch runner (spec 212 single-
// game "Analyze Game"): owns the progress state, snapshots the mainline at
// start, and writes results back through the game hook's setEval/setNags so
// the eval graph and move list fill in live. The spec 219 active-game
// lockout is enforced here (start refuses), inside the runner (re-checked
// per position), and by the context tag down in the Rust UCI manager.

import { useCallback, useEffect, useRef, useState } from "react"
import { getProviders } from "@/lib/platform"
import { engineAllowedForGame, ENGINE_LOCKED_MESSAGE, type ActiveGameMeta } from "@chessgui/core/active-game"
import { withJudgmentNag } from "@chessgui/core/annotations"
import type { GameTree, NodeEval } from "@chessgui/core/game-tree"
import { loadEnginePath, loadEngineSettings, treeChess960 } from "@/lib/engine-settings"
import {
  GAME_ANALYSIS_SESSION,
  runGameAnalysis,
  type AnalysisTarget,
} from "@/lib/game-analysis"

export interface GameAnalysisState {
  running: boolean
  /** Positions evaluated so far / total (0/0 when idle). */
  done: number
  total: number
  error: string | null
}

const IDLE: GameAnalysisState = { running: false, done: 0, total: 0, error: null }

export function useGameAnalysis(game: {
  tree: GameTree
  activeGame: ActiveGameMeta | null | undefined
  setEval: (id: string, ev: NodeEval) => void
  setNags: (id: string, nags: number[]) => void
}) {
  const [state, setState] = useState<GameAnalysisState>(IDLE)

  // Refs keep the running loop reading CURRENT values (same pattern as
  // use-engine): the tree identity changes on game load, the flag on
  // snapshot restore.
  const treeRef = useRef(game.tree)
  const activeGameRef = useRef(game.activeGame)
  const setEvalRef = useRef(game.setEval)
  const setNagsRef = useRef(game.setNags)
  treeRef.current = game.tree
  activeGameRef.current = game.activeGame
  setEvalRef.current = game.setEval
  setNagsRef.current = game.setNags

  const runningRef = useRef(false)
  const cancelledRef = useRef(false)

  const locked = !engineAllowedForGame(game.activeGame)

  const cancel = useCallback(() => {
    if (!runningRef.current) return
    cancelledRef.current = true
    // Shortens the search in flight; the runner exits at its next step check.
    getProviders().engine.sendCommand("stop", undefined, GAME_ANALYSIS_SESSION).catch(() => {})
  }, [])

  const start = useCallback(async () => {
    if (runningRef.current) return
    if (!engineAllowedForGame(activeGameRef.current)) {
      setState({ ...IDLE, error: ENGINE_LOCKED_MESSAGE })
      return
    }
    const tree = treeRef.current
    const mainline = tree.mainlineNodes() // [0] is the root
    if (mainline.length < 2) {
      setState({ ...IDLE, error: "Nothing to analyze — load or play a game first." })
      return
    }
    const targets: AnalysisTarget[] = mainline.map((n) => ({ id: n.id, fen: n.fen, uci: n.uci }))

    runningRef.current = true
    cancelledRef.current = false
    setState({ running: true, done: 0, total: targets.length, error: null })

    const settings = loadEngineSettings()
    const result = await runGameAnalysis({
      engine: getProviders().engine,
      // The MAIN engine's configured binary (bare key): batch analysis is
      // "the user's engine", not a separately configured slot.
      enginePath: loadEnginePath(),
      targets,
      activeGame: () => activeGameRef.current,
      // A game swap mid-run aborts: the snapshot's node ids belong to the
      // replaced tree (writes would no-op, the progress bar would lie).
      isCancelled: () => cancelledRef.current || treeRef.current !== tree,
      threads: settings.threads,
      hash: settings.hash,
      // Chess960 (spec 011): the batch run replays this tree's mainline, so
      // its variant decides the UCI_Chess960 assertion.
      chess960: treeChess960(tree),
      callbacks: {
        onEval: (id, ev) => setEvalRef.current(id, ev),
        onJudgment: (id, judgment) => {
          const node = treeRef.current.get(id)
          if (node) setNagsRef.current(id, withJudgmentNag(node.nags, judgment))
        },
        onProgress: (done, total) => setState((s) => ({ ...s, done, total })),
      },
    })

    runningRef.current = false
    setState((s) => ({ ...s, running: false, error: result.error }))
  }, [])

  // Spec 219: if the game on the board becomes an active game mid-run
  // (snapshot restore, resume from the list), kill the run immediately —
  // same stance as use-engine's stop-on-lock effect.
  useEffect(() => {
    if (locked && runningRef.current) cancel()
  }, [locked, cancel])

  // Unmount: abandon the run and stop this session's engine process.
  useEffect(() => {
    return () => {
      cancelledRef.current = true
      getProviders().engine.stopEngine(GAME_ANALYSIS_SESSION).catch(() => {})
    }
  }, [])

  return { state, start, cancel, locked }
}

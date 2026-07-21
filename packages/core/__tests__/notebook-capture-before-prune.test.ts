// The prune must not eat the record (spec 219 F vs spec 226 J).
//
// Observed on disk 2026-07-21: the user's board held 131 nodes / 17
// assessments / 9 branch points; the store, one sync later, held 36 / 0 / 0.
// Pruning behind the live position is right for the move list and deletes
// exactly the candidate sets the training record is made of, so the capture
// has to happen BEFORE it — every sync, not once at archive.

import { describe, expect, it } from "vitest"
import { GameTree } from "../src/game-tree"
import { pruneBehindLive } from "../src/live-sync"
import {
  extractTrainingRecord,
  mergeDecisionLog,
  playerRefFrom,
  type DecisionRecord,
} from "../src/training-record"

const META = {
  opponent: "painterdenny",
  chesscomUsername: "hjaltth",
  gameUrl: null,
  flaggedAt: 1,
  myColor: "black" as const,
}
const GAME = {
  databaseGameId: null, gameUrl: null, activeGameId: "ag-1",
  importSource: "", archivedAt: 0,
}

/** A think at move 1 — three candidates named, then the game moves on. */
function thoughtHard() {
  const t = GameTree.create()
  const e4 = t.addMoveSan("e4")!
  t.goToStart(); const d4 = t.addMoveSan("d4")!
  t.goToStart(); const c4 = t.addMoveSan("c4")!
  t.setAssessment(e4, 0, "human-live"); t.setAssessment(d4, 1, "human-live")
  t.setAssessment(c4, -1, "human-live")
  // …and the game continued down e4.
  t.goTo(e4); const e5 = t.addMoveSan("e5")!
  return { t, e5 }
}

const decisionsOf = (t: GameTree, live: string) =>
  extractTrainingRecord(t, { id: "tr-1", game: GAME, player: playerRefFrom(META), liveNodeId: live }).decisions

describe("capture before prune", () => {
  it("keeps the candidate set the prune is about to delete", () => {
    const { t, e5 } = thoughtHard()
    const before = decisionsOf(t, e5)
    const root = before.find((d) => d.ply === 0)!
    expect(root.candidates).toHaveLength(3) // e4, d4, c4 — the real think

    // The game advances; the prune runs for the move list's sake.
    expect(pruneBehindLive(t, e5)).toBeGreaterThan(0)

    const after = decisionsOf(t, e5)
    expect(after.find((d) => d.ply === 0)!.candidates).toHaveLength(1) // gone

    // The log preserves it, which is the whole point.
    const log = mergeDecisionLog([], before)
    expect(mergeDecisionLog(log, after).find((d) => d.ply === 0)!.candidates).toHaveLength(3)
  })

  it("never lets a later, poorer snapshot overwrite a richer one", () => {
    // Without this rule the fix reintroduces the bug: every sync after a prune
    // re-extracts the node holding only the played move.
    const rich = [{ nodeId: "n0", ply: 0, candidates: [1, 2, 3] }] as unknown as DecisionRecord[]
    const poor = [{ nodeId: "n0", ply: 0, candidates: [1] }] as unknown as DecisionRecord[]
    expect(mergeDecisionLog(rich, poor)[0].candidates).toHaveLength(3)
    expect(mergeDecisionLog(poor, rich)[0].candidates).toHaveLength(3)
  })
})

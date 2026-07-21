// Post-game review (spec 226 H) — the shell half: the archived-only gate, the
// target projection, the end-to-end run against a scripted engine, and the
// reading surface.
//
// The gate is the part worth testing hardest. Everything this feature produces
// is engine-derived, so a live fair-play game must not be able to reach ANY of
// it — and "the button is hidden" is not a lockout. These tests drive the
// library directly, past every button.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { registerProviders } from "@/lib/platform"
import { browserProviders } from "@/lib/platform/browser"
import {
  newActiveGameRecord,
  withActiveGameFlag,
  type ActiveGameMeta,
  type ActiveGameRecord,
} from "@chessgui/core/active-game"
import { GameTree } from "@chessgui/core/game-tree"
import {
  extractTrainingRecord,
  REDACTED_FEN,
  TRAINING_RECORD_VERSION,
} from "@chessgui/core/training-record"
import type { TrainingRecord } from "@chessgui/core/training-record"
import {
  loadReviewRecord,
  reviewAllowed,
  reviewContextFor,
  reviewTargets,
  REVIEW_REFUSED,
  runNotebookReview,
  NOTEBOOK_REVIEW_SESSION,
} from "@/lib/notebook-review"
import { runGameAnalysis, type GameAnalysisEngine } from "@/lib/game-analysis"
import { classTotal, emptyCounts } from "@chessgui/core/notebook-diagnosis"
import {
  countsSummary,
  decisionLabel,
  failureText,
  NotebookReview,
  pawns,
} from "@chessgui/ui/notebook-review"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const META: ActiveGameMeta = {
  opponent: "dad",
  chesscomUsername: "hjaltth",
  gameUrl: "https://www.chess.com/game/daily/123456",
  flaggedAt: 1,
  myColor: "white",
}

/**
 * One game's worth of thinking, with exactly one of each failure waiting for
 * the engine (spec 226's done-when: "on a fixture game with one of each").
 *
 * White names e4/d4/c4 and plays e4; the engine's move is Nf3, which is on
 * nobody's list → BLIND SPOT. d4 is judged "+−" and the engine has it equal →
 * MISJUDGEMENT. Black's c5 was marked unlikely and is what he played →
 * OPPONENT-MODEL ERROR.
 */
function fixture(): { tree: GameTree; ids: Record<string, string> } {
  const t = GameTree.create()
  const e4 = t.addMoveSan("e4")!
  t.goTo(t.rootId)
  const d4 = t.addMoveSan("d4")!
  t.goTo(t.rootId)
  const c4 = t.addMoveSan("c4")!
  t.setAssessment(e4, 0, "human-live", 1000)
  t.setAssessment(d4, 3, "human-live", 1000)
  t.setAssessment(c4, 0, "human-live", 1000)

  t.goTo(e4)
  const e5 = t.addMoveSan("e5")!
  t.goTo(e4)
  const c5 = t.addMoveSan("c5")!
  t.setLikelihood(e5, 3)
  t.setLikelihood(c5, 1)
  t.recordPreference(e4, d4, {
    reason: "his king is safer after d4 and I never like those",
    tags: ["safer king", "I play these well"],
    at: 1000,
  })
  return { tree: t, ids: { root: t.rootId, e4, d4, c4, e5, c5 } }
}

function trainingFor(tree: GameTree, liveNodeId: string): TrainingRecord {
  return extractTrainingRecord(tree, {
    id: "tr-1",
    game: {
      databaseGameId: 7,
      gameUrl: META.gameUrl,
      importSource: "chesscom",
      activeGameId: "ag-1",
      archivedAt: 5,
    },
    player: { chesscomUsername: "hjaltth", opponent: "dad", myColor: "white" },
    liveNodeId,
    now: 10,
  })
}

function activeRecord(tree: GameTree, archived: boolean): ActiveGameRecord {
  const record = newActiveGameRecord("ag-1", tree.toJSON(), META, 1)
  if (!archived) return record
  // Exactly what markActiveGameArchived does: the flag off the tree, archived on.
  return { ...record, tree: withActiveGameFlag(record.tree, null), archived: true, archivedAt: 2 }
}

/** White-POV centipawns per position, by the FEN the engine is handed. */
function scriptedEvals(tree: GameTree, ids: Record<string, string>): Map<string, number> {
  const fen = (id: string) => tree.get(id)!.fen
  return new Map<string, number>([
    [fen(ids.root), 100],
    [fen(ids.e4), 0],
    [fen(ids.d4), 10],
    [fen(ids.c4), 5],
    [fen(ids.e5), 20],
    [fen(ids.c5), 60],
  ])
}

/**
 * Scripted engine answering by POSITION rather than by call order — which is
 * the only way to test the independent mode, since its whole point is that the
 * targets are not a sequence.
 */
function fakeEngine(whiteCp: Map<string, number>, best: Map<string, string>) {
  const commands: string[] = []
  const sessions: (string | undefined)[] = []
  let listener: ((line: string) => void) | null = null
  let lastFen: string | null = null
  const engine: GameAnalysisEngine = {
    async startEngine(_path, _context, sessionId) {
      sessions.push(sessionId)
      return { name: "FakeFish", ready: true }
    },
    async sendCommand(command, _context, sessionId) {
      commands.push(command)
      sessions.push(sessionId)
      if (command.startsWith("position fen ")) lastFen = command.slice("position fen ".length)
      if (command.startsWith("go ")) {
        const fen = lastFen ?? ""
        const white = whiteCp.get(fen) ?? 0
        // UCI scores are side-to-move POV; the runner flips them back.
        const mover = fen.split(" ")[1] === "b" ? -white : white
        const move = best.get(fen) ?? "e2e4"
        const l = listener
        queueMicrotask(() => {
          l?.(`info depth 20 seldepth 26 multipv 1 score cp ${mover} nodes 1000 nps 100000 pv ${move}`)
          l?.(`bestmove ${move}`)
        })
      }
    },
    async stopEngine() {
      listener = null
    },
    async onEngineLine(onLine) {
      listener = onLine
      return () => {
        listener = null
      }
    },
  }
  return { engine, commands, sessions }
}

let trainingStored: string | null = null

beforeEach(() => {
  trainingStored = null
})

function registerWith(engine: GameAnalysisEngine, record: TrainingRecord | null) {
  trainingStored = record
    ? JSON.stringify({ v: TRAINING_RECORD_VERSION, records: [record] })
    : null
  registerProviders({
    ...browserProviders,
    engine: { ...browserProviders.engine, ...engine } as never,
    trainingRecords: {
      load: async () => trainingStored,
      upsert: async () => {},
      remove: async () => {},
      queryByPosition: async () => "[]",
    },
  })
}

// ---------------------------------------------------------------------------
// The gate (constraint: post-game only, enforced — not merely hidden)
// ---------------------------------------------------------------------------

describe("archived-only gate (spec 219 D / 226 H)", () => {
  it("refuses a live fair-play game, an absent record, and a mismatched pair", () => {
    const { tree, ids } = fixture()
    expect(reviewAllowed(activeRecord(tree, false))).toBe(false)
    expect(reviewAllowed(null)).toBe(false)
    expect(reviewAllowed(undefined)).toBe(false)
    // archived:true but the tree still carries the lockout flag — the two facts
    // disagree, which is exactly when we refuse.
    const half = { ...activeRecord(tree, true), tree: withActiveGameFlag(tree.toJSON(), META) }
    expect(reviewAllowed(half)).toBe(false)
    expect(reviewAllowed(activeRecord(tree, true))).toBe(true)
    expect(ids.root).toBeTruthy()
  })

  it("throws rather than returning a context for a live game", () => {
    const { tree } = fixture()
    expect(() => reviewContextFor(activeRecord(tree, false))).toThrow(REVIEW_REFUSED)
    expect(reviewContextFor(activeRecord(tree, true))).toBe("unrestricted")
  })

  it("refuses the record load and the engine run, and never starts an engine", async () => {
    const { tree, ids } = fixture()
    const live = activeRecord(tree, false)
    const { engine, commands } = fakeEngine(new Map(), new Map())
    registerWith(engine, trainingFor(tree, ids.c5))

    await expect(loadReviewRecord(live)).rejects.toThrow(REVIEW_REFUSED)
    await expect(
      runNotebookReview({ record: live, training: trainingFor(tree, ids.c5) }),
    ).rejects.toThrow(REVIEW_REFUSED)
    // The refusal happens before any engine command, not after one.
    expect(commands).toEqual([])
  })

  it("loads the record by the GAME pointer, never by a position", async () => {
    const { tree, ids } = fixture()
    const queryByPosition = vi.fn(async () => "[]")
    trainingStored = JSON.stringify({ v: TRAINING_RECORD_VERSION, records: [trainingFor(tree, ids.c5)] })
    registerProviders({
      ...browserProviders,
      trainingRecords: {
        load: async () => trainingStored,
        upsert: async () => {},
        remove: async () => {},
        queryByPosition,
      },
    })
    const loaded = await loadReviewRecord(activeRecord(tree, true))
    expect(loaded?.id).toBe("tr-1")
    expect(queryByPosition).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

describe("review targets", () => {
  it("covers each decision and every candidate exactly once", () => {
    const { tree, ids } = fixture()
    const targets = reviewTargets(trainingFor(tree, ids.c5))
    const idsSeen = targets.map((t) => t.id)
    expect(new Set(idsSeen).size).toBe(idsSeen.length)
    for (const id of [ids.root, ids.e4, ids.d4, ids.c4, ids.e5, ids.c5]) {
      expect(idsSeen).toContain(id)
    }
  })

  it("drops redacted positions rather than searching an empty FEN", () => {
    const { tree, ids } = fixture()
    const record = trainingFor(tree, ids.c5)
    const redacted: TrainingRecord = {
      ...record,
      decisions: record.decisions.map((d) => ({
        ...d,
        fen: REDACTED_FEN,
        candidates: d.candidates.map((c) => ({ ...c, fen: REDACTED_FEN })),
      })),
    }
    expect(reviewTargets(redacted)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The runner's independent mode
// ---------------------------------------------------------------------------

describe("independent batch mode (spec 226 H)", () => {
  it("searches each target from its own FEN and emits no judgments", async () => {
    const { tree, ids } = fixture()
    const targets = reviewTargets(trainingFor(tree, ids.c5))
    const { engine, commands, sessions } = fakeEngine(
      scriptedEvals(tree, ids),
      new Map([[tree.get(ids.root)!.fen, "g1f3"]]),
    )
    const judgments: string[] = []
    const bests: Array<[string, string]> = []
    const result = await runGameAnalysis({
      engine,
      enginePath: "/bin/fake",
      targets,
      activeGame: () => null,
      isCancelled: () => false,
      independent: true,
      sessionId: NOTEBOOK_REVIEW_SESSION,
      callbacks: {
        onEval: () => {},
        onJudgment: (id) => judgments.push(id),
        onProgress: () => {},
        onBestMove: (id, uci) => bests.push([id, uci]),
      },
    })
    expect(result.completed).toBe(true)
    // Never a move chain: every search stands on its own position.
    expect(commands.filter((c) => c.startsWith("position "))).toHaveLength(targets.length)
    expect(commands.some((c) => c.includes(" moves "))).toBe(false)
    // A swing between two positions that never followed one another is not one.
    expect(judgments).toEqual([])
    expect(bests.find(([id]) => id === ids.root)?.[1]).toBe("g1f3")
    expect(sessions).toContain(NOTEBOOK_REVIEW_SESSION)
  })
})

// ---------------------------------------------------------------------------
// End to end: one game, one of each failure
// ---------------------------------------------------------------------------

describe("diagnosing a game (spec 226 H)", () => {
  async function run() {
    const { tree, ids } = fixture()
    const training = trainingFor(tree, ids.c5)
    const { engine } = fakeEngine(
      scriptedEvals(tree, ids),
      // The engine's move at the start is Nf3 — on nobody's candidate list.
      new Map([[tree.get(ids.root)!.fen, "g1f3"]]),
    )
    registerWith(engine, training)
    const out = await runNotebookReview({ record: activeRecord(tree, true), training })
    return { ...out, tree, ids, training }
  }

  it("finds a blind spot, a misjudgement and an opponent-model error", async () => {
    const { diagnosis, ids } = await run()
    expect(diagnosis).not.toBeNull()
    const root = diagnosis!.decisions.find((d) => d.nodeId === ids.root)!
    const blind = root.failures.find((f) => f.class === "blind-spot")
    expect(blind).toBeDefined()
    // Named, because the review captured the engine's own move.
    expect(blind && blind.class === "blind-spot" && blind.san).toBe("Nf3")
    expect(root.failures.some((f) => f.class === "misjudgement" && f.san === "d4")).toBe(true)
    // The earliest link in the chain is the headline: you cannot judge what you
    // never saw.
    expect(root.primary).toBe("blind-spot")

    const his = diagnosis!.decisions.find((d) => d.nodeId === ids.e4)!
    const model = his.failures.find((f) => f.class === "opponent-model")
    expect(model && model.class === "opponent-model" && model.kind).toBe("unlikely-played")
    expect(model && model.class === "opponent-model" && model.expectedSan).toBe("e5")

    expect(classTotal(diagnosis!.counts, "blind-spot")).toBe(1)
    expect(classTotal(diagnosis!.counts, "misjudgement")).toBe(1)
    // Sided, so a curriculum can tell "I missed his reply" from "I missed my
    // own move": the opponent-model error is at HIS decision.
    expect(diagnosis!.counts["opponent-model"]).toEqual({ mine: 0, his: 1 })
  })

  it("says out loud that one game is not a pattern", async () => {
    const { diagnosis } = await run()
    expect(diagnosis!.note).toMatch(/not a pattern/i)
  })

  it("writes nothing back — no engine verdict reaches the record", async () => {
    const { tree, ids } = fixture()
    const training = trainingFor(tree, ids.c5)
    const before = JSON.stringify(training)
    const treeBefore = JSON.stringify(tree.toJSON())
    const { engine } = fakeEngine(scriptedEvals(tree, ids), new Map())
    registerWith(engine, training)
    await runNotebookReview({ record: activeRecord(tree, true), training })
    expect(JSON.stringify(training)).toBe(before)
    expect(JSON.stringify(tree.toJSON())).toBe(treeBefore)
    // assessedBy stays human-only (spec 226 G): nothing stamped it otherwise.
    for (const d of training.decisions) {
      for (const c of d.candidates) {
        expect(c.assessedBy === undefined || c.assessedBy === "human-live").toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The reading surface
// ---------------------------------------------------------------------------

describe("the review screen", () => {
  async function diagnosed() {
    const { tree, ids } = fixture()
    const training = trainingFor(tree, ids.c5)
    const { engine } = fakeEngine(
      scriptedEvals(tree, ids),
      new Map([[tree.get(ids.root)!.fen, "g1f3"]]),
    )
    registerWith(engine, training)
    const { diagnosis } = await runNotebookReview({
      record: activeRecord(tree, true),
      training,
    })
    return renderToStaticMarkup(
      createElement(NotebookReview, {
        title: "vs dad · as hjaltth",
        myColor: "white" as const,
        training,
        diagnosis,
        onRun: () => {},
        onStop: () => {},
        onClose: () => {},
      }),
    )
  }

  it("shows what I considered, what I judged, and which failure it was", async () => {
    const html = await diagnosed()
    expect(html).toContain("Blind spot")
    expect(html).toContain("Misjudgement")
    expect(html).toContain("Opponent model")
    // My own candidate list, back in front of me.
    expect(html).toContain("d4")
    expect(html).toContain("c4")
  })

  it("shows my own words back to me — the reason and the tags", async () => {
    const html = await diagnosed()
    expect(html).toContain("safer king")
    expect(html).toContain("I play these well")
  })

  it("reports counts as counts and never as a verdict about the player", async () => {
    const html = await diagnosed()
    expect(html).toMatch(/1 × blind spot/)
    expect(html).toMatch(/observations/)
    expect(html.toLowerCase()).not.toContain("weakness")
    expect(html.toLowerCase()).not.toContain("you tend to")
    // The spec's forbidden phrase, wherever the notebook is read (spec 226 C).
    expect(html.toLowerCase()).not.toContain("fully examined")
  })

  it("labels a truncated run as a partial review", async () => {
    // The dangerous case: Stop leaves a smaller denominator, and without this
    // banner a partial review renders exactly like a complete one.
    const html = renderToStaticMarkup(
      createElement(NotebookReview, {
        title: "vs dad",
        myColor: "white" as const,
        training: null,
        diagnosis: {
          recordId: "r",
          game: {
            databaseGameId: null,
            gameUrl: null,
            activeGameId: "a",
            importSource: "s",
            archivedAt: 0,
          },
          player: { chesscomUsername: "me", opponent: "him", myColor: "white" as const },
          decisions: [],
          scoredDecisions: 3,
          scoredPlayedDecisions: 3,
          counts: emptyCounts(),
          decisionCounts: emptyCounts(),
          note: "",
        },
        evaluated: 12,
        targeted: 412,
        onRun: () => {},
        onStop: () => {},
        onClose: () => {},
      }),
    )
    expect(html).toContain("Partial review")
    expect(html).toContain("12 of 412")
  })

  it("says nothing about partiality when the engine answered for everything", async () => {
    expect(await diagnosed()).not.toContain("Partial review")
  })

  it("keeps the board shortcuts off the game hidden behind the review", () => {
    // The review is a full-view surface that HIDES the board rather than
    // unmounting it (like compare mode and Learn), so an unguarded ArrowLeft
    // moves the cursor on the game behind it and Cmd+N replaces its working
    // tree — which for a resumed daily game is where every assessment,
    // likelihood and preference lives until archive (spec 226 J).
    const page = readFileSync(
      path.join(__dirname, "..", "app", "page.tsx"),
      "utf8",
    )
    const handler = page.slice(page.indexOf("const handleKeyDown"))
    const guard = handler.indexOf("if (reviewGame) return")
    expect(guard).toBeGreaterThan(-1)
    // Before every shortcut it protects.
    expect(guard).toBeLessThan(handler.indexOf('e.key === "ArrowLeft"'))
    expect(guard).toBeLessThan(handler.indexOf('e.key === "f"'))
    expect(guard).toBeLessThan(handler.indexOf('e.key === "n"'))
    // …and in the effect's deps, or the guard is captured stale.
    const deps = handler.slice(handler.indexOf("removeEventListener"))
    expect(deps).toMatch(/\[[^\]]*reviewGame[^\]]*\]/)
  })

  it("puts nothing below 13px", async () => {
    const html = await diagnosed()
    for (const m of html.matchAll(/text-\[(\d+)px\]/g)) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(13)
    }
    // Tailwind's text-xs is 12px — banned on this surface.
    expect(html).not.toMatch(/\btext-xs\b/)
  })

  it("phrases the failures in the player's own first person", () => {
    expect(
      failureText({ class: "blind-spot", san: "Nf3", cp: 90, tier: "mistake", named: ["e4"] }),
    ).toContain("never on my list")
    expect(
      failureText({
        class: "opponent-model",
        kind: "unlikely-played",
        san: "c5",
        likelihood: 1,
        expectedSan: "e5",
        cp: 40,
      }),
    ).toContain("I marked c5 unlikely and he played it")
  })

  it("formats centipawns as pawns and labels decisions by move number", () => {
    expect(pawns(90)).toBe("0.90")
    expect(pawns(-40)).toBe("−0.40")
    expect(
      decisionLabel({
        nodeId: "n",
        ply: 0,
        line: [],
        fen: "",
        mine: true,
        played: true,
        playedSan: "e4",
        playedLossCp: 100,
        named: ["e4"],
        namedEvaluated: 1,
        failures: [],
        primary: null,
      }),
    ).toBe("1. e4")
  })

  it("summarises a clean game without inventing a finding", () => {
    expect(
      countsSummary({
        recordId: "r",
        game: {
          databaseGameId: null,
          gameUrl: null,
          activeGameId: "a",
          importSource: "s",
          archivedAt: 0,
        },
        player: { chesscomUsername: "me", opponent: "him", myColor: "white" },
        decisions: [],
        scoredDecisions: 12,
        scoredPlayedDecisions: 12,
        counts: emptyCounts(),
        decisionCounts: emptyCounts(),
        note: "",
      }),
    ).toBe("Nothing to flag across 12 reviewed decisions.")
  })
})

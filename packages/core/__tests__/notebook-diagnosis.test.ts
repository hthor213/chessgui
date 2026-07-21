// Spec 226 H: post-game diagnosis. The player's recorded thinking laid beside
// the engine's verdict on the same positions, split into failures that are
// separately trainable — and the refusals that keep it honest.

import { describe, it, expect } from "vitest";
import { GameTree } from "../src/game-tree";
import type { NodeEval } from "../src/game-tree";
import { UNRESTRICTED_ENGINE_CONTEXT, ACTIVE_GAME_CONTEXT_PREFIX } from "../src/active-game";
import { extractTrainingRecord, type ArchivedGameRef, type TrainingRecord } from "../src/training-record";
import {
  aggregateDiagnoses,
  bandDistanceCp,
  bandOf,
  classTotal,
  emptyCounts,
  diagnoseGame,
  DIAGNOSIS_REFUSED,
  FAILURE_SEVERITY,
  MATTERS_MIN_CP,
  MISJUDGEMENT_MIN_BANDS,
  PATTERN_MIN_CLASS_OBSERVATIONS,
  PATTERN_MIN_GAMES,
  PATTERN_MIN_GAMES_WITH_CLASS,
  PATTERN_MIN_SCORED_DECISIONS,
  SINGLE_GAME_NOTE,
  type EngineEvals,
  type FailureClass,
  type GameDiagnosis,
} from "../src/notebook-diagnosis";

const GAME: ArchivedGameRef = {
  databaseGameId: null,
  gameUrl: "https://www.chess.com/game/daily/999",
  activeGameId: "ag-h",
  importSource: "https://www.chess.com/game/daily/999",
  archivedAt: 1_750_000_000_000,
};

const PLAYER = { chesscomUsername: "hjaltth", opponent: "dad", myColor: "white" as const };

function record(tree: GameTree, liveNodeId?: string | null): TrainingRecord {
  return extractTrainingRecord(tree, {
    id: "tr-h",
    game: GAME,
    player: PLAYER,
    liveNodeId,
    now: 1_750_000_001_000,
  });
}

function evals(pairs: Record<string, number | NodeEval>): EngineEvals {
  return new Map(
    Object.entries(pairs).map(([id, v]) => [id, typeof v === "number" ? { cp: v, depth: 20 } : v]),
  );
}

const OK = { context: UNRESTRICTED_ENGINE_CONTEXT };

function diagnose(tree: GameTree, ev: EngineEvals, live?: string | null, bestMoves?: Map<string, { san: string; uci: string }>) {
  return diagnoseGame(record(tree, live), ev, { ...OK, bestMoves });
}

/** The one decision a fixture makes — every fixture below has exactly one
 *  reviewable decision, so the assertions read as chess rather than indexing. */
function only(g: GameDiagnosis) {
  expect(g.decisions).toHaveLength(1);
  return g.decisions[0];
}

// ---- the gate (rule 1: post-game only) -----------------------------------

describe("the lockout gate (spec 219 / 226 G)", () => {
  it("refuses a diagnosis requested from inside a live game", () => {
    const tree = GameTree.create();
    tree.addMoveSan("e4");
    expect(() =>
      diagnoseGame(record(tree), evals({}), { context: `${ACTIVE_GAME_CONTEXT_PREFIX}:ag-h` }),
    ).toThrow(DIAGNOSIS_REFUSED);
  });

  it("refuses a caller that could not say where it was standing", () => {
    const tree = GameTree.create();
    tree.addMoveSan("e4");
    expect(() => diagnoseGame(record(tree), evals({}), { context: undefined })).toThrow(
      DIAGNOSIS_REFUSED,
    );
    expect(() => diagnoseGame(record(tree), evals({}), { context: null })).toThrow(
      DIAGNOSIS_REFUSED,
    );
  });
});

// ---- band mapping --------------------------------------------------------

describe("engine eval → the seven-point band", () => {
  it("maps the scale symmetrically and collapses mate to the outer band", () => {
    expect(bandOf({ cp: 0 })).toBe(0);
    expect(bandOf({ cp: 29 })).toBe(0);
    expect(bandOf({ cp: 30 })).toBe(1);
    expect(bandOf({ cp: -120 })).toBe(-2);
    expect(bandOf({ cp: 400 })).toBe(3);
    expect(bandOf({ mate: 4 })).toBe(3);
    expect(bandOf({ mate: -2 })).toBe(-3);
  });
});

// ---- blind spot ----------------------------------------------------------

describe("blind spot — a move that mattered was never on the list", () => {
  /**
   * Two candidates, both judged correctly, and the engine says the position was
   * worth far more than either of them delivers. Nothing they named was good
   * enough, so something better existed that never made the list.
   */
  function fixture() {
    const tree = GameTree.create();
    const root = tree.rootId;
    const e4 = tree.addMoveSan("e4")!;
    tree.goTo(root);
    const d4 = tree.addMoveSan("d4")!;
    tree.setAssessment(e4, 0, "human-live");
    tree.setAssessment(d4, 0, "human-live");
    return { tree, root, e4, d4 };
  }

  it("fires when the whole candidate list falls short, and sizes the miss", () => {
    const { tree, root, e4, d4 } = fixture();
    const g = diagnose(tree, evals({ [root]: 200, [e4]: 20, [d4]: 10 }), e4);
    const d = only(g);
    expect(d.mine).toBe(true);
    expect(d.named).toEqual(["e4", "d4"]);
    expect(d.failures).toHaveLength(1);
    const f = d.failures[0];
    expect(f.class).toBe("blind-spot");
    if (f.class !== "blind-spot") throw new Error("unreachable");
    // Least-losing named move gave up 180cp against the engine's own reading.
    expect(f.cp).toBe(180);
    expect(f.tier).toBe("mistake");
    // No best-move data: the miss is detected but not named, and says so.
    expect(f.san).toBeNull();
    expect(f.named).toEqual(["e4", "d4"]);
    expect(d.primary).toBe("blind-spot");
    // Sided: this one was at the player's own move.
    expect(g.counts["blind-spot"]).toEqual({ mine: 1, his: 0 });
    expect(g.decisionCounts["blind-spot"]).toEqual({ mine: 1, his: 0 });
  });

  it("names the missed move when the review captured one", () => {
    const { tree, root, e4, d4 } = fixture();
    const g = diagnose(
      tree,
      evals({ [root]: 200, [e4]: 20, [d4]: 10 }),
      e4,
      new Map([[root, { san: "Nf3", uci: "g1f3" }]]),
    );
    const f = only(g).failures[0];
    if (f.class !== "blind-spot") throw new Error("expected a blind spot");
    expect(f.san).toBe("Nf3");
  });

  it("stays silent when the engine's move was on the list after all", () => {
    const { tree, root, e4, d4 } = fixture();
    const g = diagnose(
      tree,
      evals({ [root]: 200, [e4]: 20, [d4]: 10 }),
      e4,
      new Map([[root, { san: "e4", uci: "e2e4" }]]),
    );
    expect(only(g).failures).toHaveLength(0);
  });

  it("stays silent below the 'a move that mattered' threshold", () => {
    const { tree, root, e4, d4 } = fixture();
    const g = diagnose(tree, evals({ [root]: 20 + MATTERS_MIN_CP - 1, [e4]: 20, [d4]: 10 }), e4);
    expect(only(g).failures).toHaveLength(0);
    expect(only(g).primary).toBeNull();
  });
});

// ---- misjudgement --------------------------------------------------------

describe("misjudgement — listed, but assessed wrongly", () => {
  function fixture(band: -3 | -2 | -1 | 0 | 1 | 2 | 3) {
    const tree = GameTree.create();
    const root = tree.rootId;
    const e4 = tree.addMoveSan("e4")!;
    tree.setAssessment(e4, band, "human-live");
    return { tree, root, e4 };
  }

  it("fires on a two-band disagreement and records both symbols", () => {
    const { tree, root, e4 } = fixture(2);
    // Root eval sits next to the move's, so nothing better was available and
    // this is a clean misjudgement with no blind spot alongside it.
    const g = diagnose(tree, evals({ [root]: -80, [e4]: -100 }), e4);
    const d = only(g);
    expect(d.failures).toHaveLength(1);
    const f = d.failures[0];
    if (f.class !== "misjudgement") throw new Error("expected a misjudgement");
    expect(f.san).toBe("e4");
    expect(f.human).toBe(2);
    expect(f.engine).toBe(-2);
    expect(f.cp).toBe(-100);
    // White flattering a position that is actually bad for White.
    expect(f.overrated).toBe(true);
    expect(d.primary).toBe("misjudgement");
  });

  it("lets a one-band disagreement pass — that is inside the vocabulary", () => {
    const { tree, root, e4 } = fixture(0);
    // The engine has it slightly better for White (band 1); the player wrote
    // "=" (band 0). One band apart is taste, not a misjudgement.
    const g = diagnose(tree, evals({ [root]: 60, [e4]: 50 }), e4);
    expect(MISJUDGEMENT_MIN_BANDS).toBe(2);
    expect(only(g).failures).toHaveLength(0);
  });

  it("ignores a position NAG the player never stamped as their own", () => {
    const tree = GameTree.create();
    const root = tree.rootId;
    const e4 = tree.addMoveSan("e4")!;
    // An assessment symbol that arrived from an imported annotated PGN: no
    // human provenance, so the notebook cannot see it and neither can this.
    tree.setNags(e4, [18]);
    const g = diagnose(tree, evals({ [root]: -80, [e4]: -100 }), e4);
    expect(only(g).failures).toHaveLength(0);
  });
});

// ---- opponent-model error ------------------------------------------------

describe("opponent-model error — he did not do what I predicted", () => {
  /** White plays e4; Black's replies are bucketed and the unlikely one comes. */
  function fixture() {
    const tree = GameTree.create();
    const root = tree.rootId;
    const e4 = tree.addMoveSan("e4")!;
    // c5 first so it is the mainline — the reply that actually came.
    const c5 = tree.addMoveSan("c5")!;
    tree.goTo(e4);
    const e5 = tree.addMoveSan("e5")!;
    tree.setLikelihood(c5, 1);
    tree.setLikelihood(e5, 3);
    return { tree, root, e4, c5, e5 };
  }

  it("fires when the reply marked unlikely is the one that arrives", () => {
    const { tree, root, e4, c5, e5 } = fixture();
    const g = diagnose(tree, evals({ [root]: 20, [e4]: 20, [c5]: 20, [e5]: 30 }), c5);
    // Two decisions get reviewed: the root (mine) and after e4 (his).
    const his = g.decisions.find((d) => !d.mine)!;
    expect(his.failures).toHaveLength(1);
    const f = his.failures[0];
    if (f.class !== "opponent-model") throw new Error("expected an opponent-model error");
    expect(f.kind).toBe("unlikely-played");
    expect(f.san).toBe("c5");
    expect(f.likelihood).toBe(1);
    expect(f.expectedSan).toBe("e5");
    // Player-POV: the surprise left White 10cp worse off than the reply they
    // were expecting.
    expect(f.cp).toBe(-10);
    expect(g.decisions.find((d) => d.mine)!.failures).toHaveLength(0);
    // At HIS decision, and the aggregate must never pool that with mine.
    expect(g.counts["opponent-model"]).toEqual({ mine: 0, his: 1 });
  });

  it("fires when a reply marked likely never comes", () => {
    const { tree, root, e4, c5, e5 } = fixture();
    tree.setLikelihood(c5, 2); // merely possible — not written off
    const g = diagnose(tree, evals({ [root]: 20, [e4]: 20, [c5]: 20, [e5]: 30 }), c5);
    const f = g.decisions.find((d) => !d.mine)!.failures[0];
    if (f.class !== "opponent-model") throw new Error("expected an opponent-model error");
    expect(f.kind).toBe("likely-absent");
    expect(f.expectedSan).toBe("e5");
  });

  it("scores nothing when the player made no prediction at all", () => {
    const { tree, root, e4, c5, e5 } = fixture();
    tree.setLikelihood(c5, null);
    tree.setLikelihood(e5, null);
    const g = diagnose(tree, evals({ [root]: 20, [e4]: 20, [c5]: 20, [e5]: 30 }), c5);
    expect(g.decisions.find((d) => !d.mine)!.failures).toHaveLength(0);
  });

  it("scores at most one per decision — it is one prediction that failed", () => {
    const { tree, root, e4, c5, e5 } = fixture();
    tree.goTo(e4);
    const Nf6 = tree.addMoveSan("Nf6")!;
    tree.setLikelihood(Nf6, 3); // a second likely reply that also never came
    const g = diagnose(tree, evals({ [root]: 20, [e4]: 20, [c5]: 20, [e5]: 30, [Nf6]: 25 }), c5);
    expect(g.decisions.find((d) => !d.mine)!.failures).toHaveLength(1);
  });

  it("says nothing about the player's own decisions", () => {
    const { tree, root, e4, c5, e5 } = fixture();
    const g = diagnose(tree, evals({ [root]: 20, [e4]: 20, [c5]: 20, [e5]: 30 }), c5);
    const mine = g.decisions.find((d) => d.mine)!;
    expect(mine.failures.some((f) => f.class === "opponent-model")).toBe(false);
  });
});

// ---- selection error (the fourth thing) ----------------------------------

describe("selection error — seen, judged right, and passed over anyway", () => {
  it("separates the choice from the judgement", () => {
    const tree = GameTree.create();
    const root = tree.rootId;
    const e4 = tree.addMoveSan("e4")!; // mainline: the move played
    tree.goTo(root);
    const d4 = tree.addMoveSan("d4")!;
    tree.setAssessment(e4, 0, "human-live");
    tree.setAssessment(d4, 1, "human-live"); // engine band of +120 is 2 — one off, fine
    const g = diagnose(tree, evals({ [root]: 130, [e4]: 0, [d4]: 120 }), e4);
    const d = only(g);
    expect(d.playedLossCp).toBe(130);
    expect(d.failures).toHaveLength(1);
    const f = d.failures[0];
    if (f.class !== "selection-error") throw new Error("expected a selection error");
    expect(f.san).toBe("d4");
    expect(f.playedSan).toBe("e4");
    expect(f.cp).toBe(120);
    expect(f.tier).toBe("mistake");
  });

  it("does not fire when the better move was itself misjudged — that is the judgement", () => {
    const tree = GameTree.create();
    const root = tree.rootId;
    const e4 = tree.addMoveSan("e4")!;
    tree.goTo(root);
    const d4 = tree.addMoveSan("d4")!;
    tree.setAssessment(e4, 0, "human-live");
    tree.setAssessment(d4, -2, "human-live"); // engine says +2: they wrote it off
    const g = diagnose(tree, evals({ [root]: 130, [e4]: 0, [d4]: 120 }), e4);
    const classes = only(g).failures.map((f) => f.class);
    expect(classes).toContain("misjudgement");
    expect(classes).not.toContain("selection-error");
  });
});

// ---- co-occurrence -------------------------------------------------------

describe("co-occurrence", () => {
  it("reports a blind spot and a misjudgement side by side, headlining the blind spot", () => {
    const tree = GameTree.create();
    const root = tree.rootId;
    const e4 = tree.addMoveSan("e4")!;
    tree.goTo(root);
    const d4 = tree.addMoveSan("d4")!;
    tree.setAssessment(e4, 0, "human-live"); // engine 20cp → band 0, agreed
    tree.setAssessment(d4, 3, "human-live"); // engine -100cp → band -2, badly wrong
    const g = diagnose(tree, evals({ [root]: 300, [e4]: 20, [d4]: -100 }), e4);
    const d = only(g);
    expect(d.failures.map((f) => f.class).sort()).toEqual(["blind-spot", "misjudgement"]);
    // Both are true and both are trainable, so neither is dropped; `primary` is
    // only the label you print first, and it follows the explanatory order.
    expect(d.primary).toBe("blind-spot");
    expect(FAILURE_SEVERITY.indexOf("blind-spot")).toBeLessThan(
      FAILURE_SEVERITY.indexOf("misjudgement"),
    );
    expect(classTotal(g.counts, "blind-spot")).toBe(1);
    expect(classTotal(g.counts, "misjudgement")).toBe(1);
    // One decision, two failures — the decision unit counts it once per class.
    expect(g.decisionCounts["blind-spot"].mine).toBe(1);
    expect(g.decisionCounts.misjudgement.mine).toBe(1);
  });
});

// ---- nothing to say ------------------------------------------------------

describe("a game with no notebook data", () => {
  it("produces nothing rather than throwing", () => {
    const tree = GameTree.create();
    const g = diagnoseGame(record(tree), evals({}), OK);
    expect(g.decisions).toEqual([]);
    expect(g.scoredDecisions).toBe(0);
    expect(g.counts).toEqual(emptyCounts());
    expect(g.note).toBe(SINGLE_GAME_NOTE);
  });

  it("drops decisions the engine never reviewed rather than guessing at them", () => {
    const tree = GameTree.create();
    tree.addMoveSan("e4");
    tree.addMoveSan("e5");
    expect(diagnoseGame(record(tree), evals({}), OK).scoredDecisions).toBe(0);
  });

  it("leaves the record untouched — no engine verdict is written back", () => {
    const tree = GameTree.create();
    const root = tree.rootId;
    const e4 = tree.addMoveSan("e4")!;
    tree.setAssessment(e4, 2, "human-live");
    const r = record(tree, e4);
    const before = JSON.parse(JSON.stringify(r));
    diagnoseGame(r, evals({ [root]: -80, [e4]: -100 }), OK);
    expect(r).toEqual(before);
    expect(r.decisions[0].candidates[0].assessedBy).toBe("human-live");
  });
});

// ---- the aggregate -------------------------------------------------------

/**
 * A per-game diagnosis with the given number of DECISIONS carrying each class,
 * all at the player's own moves unless `side` says otherwise. The aggregate
 * ranks on decisions rather than failure instances, so the fixture speaks in
 * that unit.
 */
function fakeGame(
  counts: Partial<Record<FailureClass, number>>,
  scored: number,
  side: "mine" | "his" = "mine",
): GameDiagnosis {
  const c = emptyCounts();
  for (const cls of FAILURE_SEVERITY) c[cls][side] = counts[cls] ?? 0;
  return {
    recordId: `g-${Math.random()}`,
    game: GAME,
    player: PLAYER,
    decisions: [],
    scoredDecisions: scored,
    scoredPlayedDecisions: scored,
    counts: c,
    decisionCounts: c,
    note: SINGLE_GAME_NOTE,
  };
}

describe("aggregate — refusing to characterise a small sample", () => {
  it("names no pattern from a single game, however lopsided", () => {
    const a = aggregateDiagnoses([fakeGame({ "blind-spot": 9 }, 12)]);
    expect(a.pattern).toBeNull();
    expect(a.sample.verdict).toBe("insufficient-sample");
    // The counts are still facts and still reported.
    expect(classTotal(a.counts, "blind-spot")).toBe(9);
    expect(a.sample.reasons.join(" ")).toContain(String(PATTERN_MIN_GAMES));
  });

  it("refuses on too few reviewed decisions even with enough games", () => {
    const games = Array.from({ length: PATTERN_MIN_GAMES }, () => fakeGame({ "blind-spot": 3 }, 2));
    const a = aggregateDiagnoses(games);
    expect(a.pattern).toBeNull();
    expect(a.sample.verdict).toBe("insufficient-sample");
    expect(a.sample.reasons.join(" ")).toContain(String(PATTERN_MIN_SCORED_DECISIONS));
  });

  it("refuses when no class leads clearly, even on a big enough sample", () => {
    const games = Array.from({ length: 6 }, () =>
      fakeGame({ "blind-spot": 2, misjudgement: 2 }, 10),
    );
    const a = aggregateDiagnoses(games);
    expect(a.pattern).toBeNull();
    expect(a.sample.verdict).toBe("no-clear-pattern");
    expect(classTotal(a.counts, "blind-spot")).toBe(12);
  });

  it("refuses when the leading class is too thin, however clean the lead", () => {
    const games = Array.from({ length: 6 }, () => fakeGame({ "blind-spot": 1 }, 10));
    const a = aggregateDiagnoses(games);
    expect(classTotal(a.counts, "blind-spot")).toBeLessThan(PATTERN_MIN_CLASS_OBSERVATIONS);
    expect(a.pattern).toBeNull();
    expect(a.sample.verdict).toBe("no-clear-pattern");
  });

  it("names the pattern once every floor is cleared", () => {
    const games = Array.from({ length: 6 }, () =>
      fakeGame({ "blind-spot": 4, misjudgement: 1 }, 10),
    );
    const a = aggregateDiagnoses(games);
    expect(a.sample.verdict).toBe("pattern");
    expect(a.pattern).not.toBeNull();
    expect(a.pattern!.leading).toBe("blind-spot");
    expect(a.pattern!.side).toBe("mine");
    expect(a.pattern!.count).toBe(24);
    expect(a.pattern!.games).toBe(6);
    expect(a.pattern!.share).toBeCloseTo(24 / 30);
  });

  it("says nothing at all about an empty season", () => {
    const a = aggregateDiagnoses([]);
    expect(a.games).toBe(0);
    expect(a.pattern).toBeNull();
    expect(a.sample.verdict).toBe("insufficient-sample");
  });
});

// ---- what the misjudgement is graded against ------------------------------

describe("misjudgement is graded on the CONCLUSION, not the first impression", () => {
  /**
   * The discipline section B exists to reward: write a symbol when you first
   * look, search, find the refutation, and let it back up. The notebook then
   * displays and ranks on the backed-up value — so that, and not the abandoned
   * symbol, is what the player actually concluded.
   */
  it("says nothing when the search already fixed the first impression", () => {
    const tree = GameTree.create();
    const root = tree.rootId;
    const b4 = tree.addMoveSan("b4")!;
    tree.setAssessment(b4, 1, "human-live"); // ⩲ — written when they first looked
    const e5 = tree.addMoveSan("e5")!;
    tree.setAssessment(e5, -2, "human-live"); // ∓ — the refutation they found
    tree.goTo(root);
    const d4 = tree.addMoveSan("d4")!;
    tree.setAssessment(d4, 0, "human-live");

    const r = record(tree, b4);
    const b4c = r.decisions[0].candidates.find((c) => c.san === "b4")!;
    expect(b4c.assessment).toBe(1);
    expect(b4c.backedUp).toBe(-2);

    // The engine AGREES with the conclusion: −180 is band −2.
    const g = diagnoseGame(r, evals({ [root]: -10, [b4]: -180, [d4]: -20, [e5]: -180 }), OK);
    const at = g.decisions.find((d) => d.nodeId === root)!;
    expect(at.failures.some((f) => f.class === "misjudgement" && f.san === "b4")).toBe(false);
  });

  it("still fires when the backed-up conclusion is the thing that is wrong", () => {
    const tree = GameTree.create();
    const root = tree.rootId;
    const b4 = tree.addMoveSan("b4")!;
    tree.setAssessment(b4, -2, "human-live"); // first impression: bad for White
    const e5 = tree.addMoveSan("e5")!;
    tree.setAssessment(e5, 2, "human-live"); // …but the search concluded ±
    const g = diagnoseGame(record(tree, b4), evals({ [root]: -80, [b4]: -180, [e5]: -180 }), OK);
    const f = g.decisions.find((d) => d.nodeId === root)!.failures.find(
      (x) => x.class === "misjudgement",
    );
    if (!f || f.class !== "misjudgement") throw new Error("expected a misjudgement");
    expect(f.human).toBe(2); // graded on what they concluded
    expect(f.firstImpression).toBe(-2); // and the revision is reported, not graded
    expect(f.engine).toBe(-2);
  });

  it("never flags a disagreement smaller than the noise floor it declares", () => {
    // A two-band gap on the signed scale is worth at least this many cp under
    // the current edges, so the module cannot flag a difference it would
    // elsewhere call search noise. Asserted rather than assumed: the guard is
    // what keeps that true if either constant ever moves.
    const worst = Math.min(
      ...([-3, -2, -1, 0, 1, 2, 3] as const).flatMap((human) =>
        [-3, -2, -1, 0, 1, 2, 3]
          .filter((engine) => Math.abs(human - engine) >= MISJUDGEMENT_MIN_BANDS)
          .map((engine) => {
            // The closest the engine's number can sit to the human's band while
            // still landing in `engine`'s band.
            const edges = [30, 90, 250];
            const mag = Math.abs(engine);
            const cp =
              (engine === 0 ? 0 : mag === 1 ? edges[0] : mag === 2 ? edges[1] : edges[2]) *
              Math.sign(engine || 1);
            return bandDistanceCp(human, cp);
          }),
      ),
    );
    expect(worst).toBeGreaterThanOrEqual(MATTERS_MIN_CP);
  });
});

// ---- a partial run must not invent a blind spot ---------------------------

describe("blind spot needs the WHOLE candidate list evaluated", () => {
  /** Two named candidates; on a full run there is no blind spot at all. */
  function fixture() {
    const tree = GameTree.create();
    const root = tree.rootId;
    const nf3 = tree.addMoveSan("Nf3")!;
    tree.goTo(root);
    const h4 = tree.addMoveSan("h4")!;
    return { tree, root, nf3, h4 };
  }

  it("finds nothing when every candidate was searched and one of them was fine", () => {
    const { tree, root, nf3, h4 } = fixture();
    const g = diagnose(tree, evals({ [root]: 50, [nf3]: 10, [h4]: -250 }), nf3);
    expect(only(g).failures).toHaveLength(0);
    expect(only(g).namedEvaluated).toBe(2);
  });

  it("says nothing rather than inventing one when the run was cut short", () => {
    // Exactly what Stop leaves behind: the decision node was searched, one of
    // its candidates never was. The minimum over the survivors is 3.00 — a
    // fabricated blind spot at a decision the complete run clears.
    const { tree, root, nf3, h4 } = fixture();
    const g = diagnose(tree, evals({ [root]: 50, [h4]: -250 }), nf3);
    const d = only(g);
    expect(d.failures.some((f) => f.class === "blind-spot")).toBe(false);
    expect(d.named).toEqual(["Nf3", "h4"]);
    expect(d.namedEvaluated).toBe(1);
  });
});

// ---- the dispersion floor ------------------------------------------------

describe("aggregate — one evening is not a season", () => {
  it("refuses a leading class that came almost entirely from one game", () => {
    // Five games, 30 reviewed decisions, and eight blind spots — every one of
    // them from the same tired evening. The games floor counts games
    // DIAGNOSED, so without a dispersion test this reads as a pattern.
    const games = [
      fakeGame({ "blind-spot": 8, misjudgement: 1 }, 20),
      fakeGame({ misjudgement: 1 }, 3),
      fakeGame({ misjudgement: 1 }, 3),
      fakeGame({ misjudgement: 1 }, 2),
      fakeGame({}, 2),
    ];
    const a = aggregateDiagnoses(games);
    expect(a.pattern).toBeNull();
    expect(a.sample.verdict).toBe("no-clear-pattern");
    expect(a.sample.reasons.join(" ")).toContain(String(PATTERN_MIN_GAMES_WITH_CLASS));
  });

  it("keeps my blind spots and his apart when naming one", () => {
    // Same class, opposite sides: failing to enumerate HIS replies is not the
    // same skill as generating my own candidates, and a pooled count would
    // send the player to the wrong training.
    const games = Array.from({ length: 6 }, () => fakeGame({ "blind-spot": 4 }, 10, "his"));
    const a = aggregateDiagnoses(games);
    expect(a.pattern!.leading).toBe("blind-spot");
    expect(a.pattern!.side).toBe("his");
    expect(a.counts["blind-spot"]).toEqual({ mine: 0, his: 24 });
  });

  it("counts decisions rather than failure instances", () => {
    // Six games; each has ONE flagged decision that went wrong three ways.
    // Instances would read 18 blind spots and clear the class floor; decisions
    // read 6, which is what actually happened.
    const g = (): GameDiagnosis => {
      const counts = emptyCounts();
      const decisionCounts = emptyCounts();
      counts["blind-spot"].mine = 3;
      decisionCounts["blind-spot"].mine = 1;
      return {
        recordId: `g-${Math.random()}`,
        game: GAME,
        player: PLAYER,
        decisions: [],
        scoredDecisions: 10,
        scoredPlayedDecisions: 10,
        counts,
        decisionCounts,
        note: SINGLE_GAME_NOTE,
      };
    };
    const a = aggregateDiagnoses(Array.from({ length: 6 }, g));
    expect(classTotal(a.counts, "blind-spot")).toBe(18);
    expect(a.pattern).toBeNull();
    expect(a.sample.reasons.join(" ")).toContain("6 decisions");
  });

  it("does not let a wide analysis tree buy its way past the decision floor", () => {
    // Plenty of scored decisions, but almost none of them were ever on the
    // board: a single three-day think is not a season of chances to go wrong.
    const games = Array.from({ length: 6 }, () => ({
      ...fakeGame({ "blind-spot": 4 }, 10),
      scoredPlayedDecisions: 2,
    }));
    const a = aggregateDiagnoses(games);
    expect(a.pattern).toBeNull();
    expect(a.sample.verdict).toBe("insufficient-sample");
    expect(a.scoredDecisions).toBe(60);
    expect(a.scoredPlayedDecisions).toBe(12);
  });
});

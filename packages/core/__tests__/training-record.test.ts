// Spec 226 J: the training record — the private artifact. Its shape, the
// extraction from a finished notebook tree, and the doctrine gate on the one
// dangerous query.

import { describe, it, expect } from "vitest";
import { GameTree } from "../src/game-tree";
import { syncLiveLine } from "../src/live-sync";
import { archivePgnImpurity, containsNotebookTags } from "../src/annotations";
import {
  TRAINING_RECORD_VERSION,
  emptyTrainingRecordsStore,
  extractTrainingRecord,
  findTrainingRecordForGame,
  parseTrainingRecordsStore,
  playerRefFrom,
  readTrainingRecordsStore,
  REDACTED_FEN,
  positionQueryAllowed,
  queryDecisionsByPosition,
  removeTrainingRecord,
  upsertTrainingRecord,
  type ArchivedGameRef,
  type TrainingRecord,
} from "../src/training-record";

const GAME: ArchivedGameRef = {
  databaseGameId: null,
  gameUrl: "https://www.chess.com/game/daily/123456",
  activeGameId: "ag-1",
  importSource: "https://www.chess.com/game/daily/123456",
  archivedAt: 1_750_000_000_000,
};

const PLAYER = { chesscomUsername: "hjaltth", opponent: "dad", myColor: "white" as const };

function extract(tree: GameTree, liveNodeId?: string | null): TrainingRecord {
  return extractTrainingRecord(tree, {
    id: "tr-ag-1",
    game: GAME,
    player: PLAYER,
    liveNodeId,
    now: 1_750_000_001_000,
  });
}

/**
 * A small worked game: 1.e4 with three candidates named at the start, two of
 * them judged, one served out of the database, a likelihood on Black's reply
 * and one head-to-head recorded.
 */
function notebook(): { tree: GameTree; ids: Record<string, string> } {
  const tree = GameTree.create();
  const root = tree.rootId;
  const e4 = tree.addMoveSan("e4")!;
  tree.goTo(root);
  const d4 = tree.addMoveSan("d4")!;
  tree.goTo(root);
  // c4 came out of the opening explorer — the APP named it, not the player.
  const c4 = tree.addMoveUciFromDatabase("c2c4")!;

  tree.setAssessment(e4, 1, "human-live");
  tree.setAssessment(d4, 0, "human-live");
  // c4 is left unjudged on purpose: it must show up in `unjudged`.

  tree.goTo(e4);
  const e5 = tree.addMoveSan("e5")!;
  tree.setAssessment(e5, 1, "human-live");
  tree.setLikelihood(e5, 3);
  tree.goTo(e4);
  const c5 = tree.addMoveSan("c5")!;
  tree.setAssessment(c5, 0, "human-live");
  tree.setLikelihood(c5, 1);

  tree.recordPreference(e4, d4, { reason: "safer structure", tags: ["clearer plan"] });

  return { tree, ids: { root, e4, d4, c4, e5, c5 } };
}

describe("extraction (spec 226 J)", () => {
  it("points at the archived game and never carries it", () => {
    const { tree } = notebook();
    const rec = extract(tree);
    expect(rec.v).toBe(TRAINING_RECORD_VERSION);
    expect(rec.game.gameUrl).toBe(GAME.gameUrl);
    expect(rec.game.activeGameId).toBe("ag-1");
    // No PGN, no tree, no moves-as-played anywhere in the document.
    expect(JSON.stringify(rec)).not.toContain("[Event");
  });

  it("records the candidate set with own-vs-database provenance", () => {
    const { tree, ids } = notebook();
    const start = extract(tree).decisions.find((d) => d.nodeId === ids.root)!;
    const bySan = new Map(start.candidates.map((c) => [c.san, c]));
    expect([...bySan.keys()].sort()).toEqual(["c4", "d4", "e4"]);
    expect(bySan.get("e4")!.own).toBe(true);
    expect(bySan.get("c4")!.own).toBe(false);
    expect(bySan.get("c4")!.src).toBe("database");
  });

  it("does not count a move the sync appended as one of my candidates", () => {
    // The failure this closes: `syncLiveLine` appends what was PLAYED, so
    // without a mark every reply the opponent actually made — including ones
    // the player never considered for a second — reads as a named candidate.
    // The decision then shows full coverage and no blind spot at a position
    // where no work was done at all, which is the gap spec 226 calls fatal.
    const tree = GameTree.create();
    tree.addMoveSan("e4"); // the player's own move, on their own board
    const synced = syncLiveLine(tree, "1. e4 c5 *");
    expect(synced.status).toBe("ok");
    if (synced.status !== "ok") return;
    const rec = extract(synced.tree, synced.report.liveNodeId);
    const his = rec.decisions.find((d) => d.line.join(" ") === "e4")!;
    const c5 = his.candidates.find((c) => c.san === "c5")!;
    expect(c5.own).toBe(false);
    expect(c5.src).toBe("played");
    expect(his.coverage.named).toBe(0);
    // …and the player's own e4 is still theirs.
    const start = rec.decisions.find((d) => d.line.length === 0)!;
    expect(start.candidates.find((c) => c.san === "e4")!.own).toBe(true);
  });

  it("keeps assessments with their provenance stamp", () => {
    const { tree, ids } = notebook();
    const start = extract(tree).decisions.find((d) => d.nodeId === ids.root)!;
    const e4 = start.candidates.find((c) => c.san === "e4")!;
    expect(e4.assessment).toBe(1);
    expect(e4.assessedBy).toBe("human-live");
  });

  it("keeps likelihood labels on the opponent's replies", () => {
    const { tree, ids } = notebook();
    const afterE4 = extract(tree).decisions.find((d) => d.nodeId === ids.e4)!;
    const bySan = new Map(afterE4.candidates.map((c) => [c.san, c]));
    expect(bySan.get("e5")!.likelihood).toBe(3);
    expect(bySan.get("c5")!.likelihood).toBe(1);
    expect(afterE4.mine).toBe(false); // Black to move, user is White
  });

  it("records coverage against the user's OWN candidates, not the legal moves", () => {
    const { tree, ids } = notebook();
    const start = extract(tree).decisions.find((d) => d.nodeId === ids.root)!;
    // Three children, but only two are the player's own AND judged; c4 came
    // from the database so it is not one of "my candidates" at all.
    expect(start.coverage.named).toBe(2);
    expect(start.coverage.examined).toBe(2);
    // Twenty legal first moves exist. Nothing in the record knows that.
    expect(JSON.stringify(start.coverage)).not.toContain("20");
  });

  it("records width beside coverage", () => {
    const { tree, ids } = notebook();
    const afterE4 = extract(tree).decisions.find((d) => d.nodeId === ids.e4)!;
    expect(afterE4.width.likelyReplies).toBe(1);
  });

  it("carries the head-to-head with its reason and tags", () => {
    const { tree, ids } = notebook();
    const start = extract(tree).decisions.find((d) => d.nodeId === ids.root)!;
    expect(start.preferences).toHaveLength(1);
    expect(start.preferences[0].winnerSan).toBe("e4");
    expect(start.preferences[0].loserSan).toBe("d4");
    expect(start.preferences[0].reason).toBe("safer structure");
    expect(start.preferences[0].tags).toEqual(["clearer plan"]);
  });

  it("makes blind spots RECOVERABLE by storing the position, not by naming moves", () => {
    const { tree, ids } = notebook();
    const start = extract(tree).decisions.find((d) => d.nodeId === ids.root)!;
    // The position at the decision is stored — that plus the candidate set is
    // what lets a post-game pass work out what was never on the list. The
    // record itself enumerates nothing.
    expect(start.fen).toBe(tree.get(ids.root)!.fen);
    expect(start.unjudged).toEqual(["c4"]);
  });

  it("marks which decisions actually occurred in the game", () => {
    const { tree, ids } = notebook();
    const rec = extract(tree, ids.e5);
    const byId = new Map(rec.decisions.map((d) => [d.nodeId, d]));
    expect(byId.get(ids.root)!.played).toBe(true);
    expect(byId.get(ids.e4)!.played).toBe(true);
    // d4 was analysis, not a position the game reached — but it has no
    // children, so it is not a decision at all. c5 likewise.
    expect(byId.has(ids.d4)).toBe(false);
  });

  it("records what was actually played and whether it had been judged", () => {
    const { tree, ids } = notebook();
    const rec = extract(tree, ids.e5);
    const byId = new Map(rec.decisions.map((d) => [d.nodeId, d]));
    expect(byId.get(ids.root)!.playedMove!.san).toBe("e4");
    const reply = byId.get(ids.e4)!.playedMove!;
    expect(reply.san).toBe("e5");
    expect(reply.wasAssessed).toBe(true);
    expect(reply.likelihood).toBe(3);
  });

  it("flags an opponent reply that was never judged — the opponent-model signal", () => {
    const tree = GameTree.create();
    const e4 = tree.addMoveSan("e4")!;
    const surprise = tree.addMoveSan("Nf6")!; // never assessed, never bucketed
    const rec = extract(tree, surprise);
    const afterE4 = rec.decisions.find((d) => d.nodeId === e4)!;
    expect(afterE4.playedMove!.wasAssessed).toBe(false);
    expect(afterE4.playedMove!.likelihood).toBeNull();
  });

  it("does not mutate the tree it reads", () => {
    const { tree } = notebook();
    const before = JSON.stringify(tree.toJSON());
    extract(tree);
    expect(JSON.stringify(tree.toJSON())).toBe(before);
  });

  it("keeps the one-candidate decisions — 'I looked at nothing else' is data", () => {
    const tree = GameTree.create();
    tree.addMoveSan("e4");
    const rec = extract(tree);
    expect(rec.decisions).toHaveLength(1);
    expect(rec.decisions[0].candidates).toHaveLength(1);
  });

  it("defaults myColor when the game predates the flag's colour field", () => {
    expect(
      playerRefFrom({
        opponent: "dad",
        chesscomUsername: "hjaltth",
        gameUrl: null,
        flaggedAt: 1,
      }).myColor,
    ).toBe("white");
  });
});

describe("the training-record store", () => {
  const rec = (id: string, createdAt: number): TrainingRecord => ({
    v: TRAINING_RECORD_VERSION,
    id,
    game: { ...GAME, activeGameId: id },
    player: PLAYER,
    createdAt,
    playedOn: null,
    decisions: [],
  });

  it("round-trips through JSON", () => {
    const store = upsertTrainingRecord(emptyTrainingRecordsStore(), rec("a", 2));
    expect(parseTrainingRecordsStore(JSON.stringify(store))).toEqual(store);
  });

  it("upserts by id, newest first", () => {
    let store = upsertTrainingRecord(emptyTrainingRecordsStore(), rec("a", 1));
    store = upsertTrainingRecord(store, rec("b", 5));
    store = upsertTrainingRecord(store, rec("a", 9));
    expect(store.records.map((r) => r.id)).toEqual(["a", "b"]);
    expect(removeTrainingRecord(store, "a").records.map((r) => r.id)).toEqual(["b"]);
  });

  it("starts fresh rather than guessing at corrupt or future data", () => {
    expect(parseTrainingRecordsStore(null).records).toEqual([]);
    expect(parseTrainingRecordsStore("{not json").records).toEqual([]);
    expect(parseTrainingRecordsStore('{"v":99,"records":[{}]}').records).toEqual([]);
  });

  it("finds a record BY GAME — reached from the game, never from a position", () => {
    const store = upsertTrainingRecord(emptyTrainingRecordsStore(), rec("a", 1));
    expect(findTrainingRecordForGame(store, { gameUrl: GAME.gameUrl })!.id).toBe("a");
    expect(findTrainingRecordForGame(store, { activeGameId: "a" })!.id).toBe("a");
    expect(findTrainingRecordForGame(store, { gameUrl: "https://elsewhere" })).toBeNull();
  });
});

describe("the doctrine gate, layer 1 (spec 226 G/J)", () => {
  const { tree } = notebook();
  const store = upsertTrainingRecord(emptyTrainingRecordsStore(), extract(tree));
  const fen = tree.get(tree.rootId)!.fen;

  it("refuses a by-position query from a fair-play context", () => {
    expect(() => queryDecisionsByPosition(store, fen, "active-game:https://x")).toThrow(
      /fair play/i,
    );
  });

  it("refuses when the caller could not say where it was standing", () => {
    // The opposite default from the engine gate, on purpose: for the store
    // that will hold engine verdicts joined to positions, "I don't know" is no.
    expect(() => queryDecisionsByPosition(store, fen, undefined)).toThrow();
    expect(() => queryDecisionsByPosition(store, fen, null)).toThrow();
    expect(() => queryDecisionsByPosition(store, fen, "")).toThrow();
    expect(() => queryDecisionsByPosition(store, fen, "post-game")).toThrow();
    expect(positionQueryAllowed(undefined)).toBe(false);
  });

  it("allows it once the game is over", () => {
    const hits = queryDecisionsByPosition(store, fen, "unrestricted");
    expect(hits).toHaveLength(1);
    expect(hits[0].decision.candidates.map((c) => c.san).sort()).toEqual(["c4", "d4", "e4"]);
  });

  it("matches transpositions — which is exactly why it is gated", () => {
    const hits = queryDecisionsByPosition(
      store,
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 7 42",
      "unrestricted",
    );
    expect(hits).toHaveLength(1);
  });
});

describe("the bulk read is redacted, not just un-queryable (spec 226 G/J)", () => {
  const { tree } = notebook();
  const store = upsertTrainingRecord(emptyTrainingRecordsStore(), extract(tree));

  it("drops the join key in a fair-play context", () => {
    const read = readTrainingRecordsStore(store, "active-game:https://x");
    for (const d of read.records[0].decisions) {
      expect(d.fen).toBe(REDACTED_FEN);
      for (const c of d.candidates) expect(c.fen).toBe(REDACTED_FEN);
    }
  });

  it("keeps everything the linear read is FOR", () => {
    const read = readTrainingRecordsStore(store, undefined);
    const start = read.records[0].decisions.find((d) => d.ply === 0)!;
    // The notes survive; only the position by which they could be looked up
    // is gone — which is the whole difference between studying and querying.
    expect(start.candidates.length).toBeGreaterThan(0);
    expect(start.coverage.named).toBe(store.records[0].decisions[0].coverage.named);
    expect(start.candidates.map((c) => c.san)).toEqual(
      store.records[0].decisions[0].candidates.map((c) => c.san),
    );
  });

  it("hands over the positions outside a fair-play game", () => {
    const read = readTrainingRecordsStore(store, "unrestricted");
    expect(read.records[0].decisions.every((d) => d.fen.includes(" "))).toBe(true);
  });

  it("does not mutate the store it was given", () => {
    readTrainingRecordsStore(store, undefined);
    expect(store.records[0].decisions[0].fen).not.toBe(REDACTED_FEN);
  });
});

describe("archive purity: the notebook-tag detector (spec 226 J)", () => {
  it("sees the notebook tags our own serializer writes", () => {
    expect(containsNotebookTags("1. e4 {[%lik 3]} e5 *")).toBe(true);
    expect(containsNotebookTags("1. e4 {[%prov human-live,17]} *")).toBe(true);
    expect(containsNotebookTags("1. e4 {[%src db]} *")).toBe(true);
  });

  it("leaves an honestly annotated PGN alone", () => {
    // Position NAGs and [%eval]/[%clk] arrive in games from anywhere. Refusing
    // those would reject real games, so the detector must not see them.
    expect(containsNotebookTags('[Event "x"]\n\n1. e4 $14 {[%clk 0:29:50]} e5 {[%eval 0.2]} *')).toBe(
      false,
    );
  });
});

describe("archive purity: the strict check at the archive door (spec 226 J)", () => {
  it("passes the PGN chess.com serves", () => {
    expect(
      archivePgnImpurity(
        '[Event "Let\'s Play!"]\n[Site "Chess.com"]\n\n1. e4 {[%clk 23:59:47]} e5 1-0\n',
      ),
    ).toBeNull();
  });

  it("catches the two leaks the tag detector cannot see", () => {
    // A tree serialization with the notebook tags stripped is still the user's
    // whole analysis — and a bare assessment NAG is what the spec 202
    // annotation bar writes, with no provenance stamp to give it away.
    expect(archivePgnImpurity("1. e4 (1. d4 d5) e5 *")).toMatch(/variation/i);
    expect(archivePgnImpurity("1. e4 $14 e5 *")).toMatch(/NAG/i);
  });

  it("reads the movetext only — a header or a comment may say anything", () => {
    expect(archivePgnImpurity('[Event "Team Match (round 2)"]\n\n1. e4 e5 *')).toBeNull();
    expect(archivePgnImpurity("1. e4 {a pawn (not a piece) move} e5 *")).toBeNull();
  });
});

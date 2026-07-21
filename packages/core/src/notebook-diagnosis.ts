// Post-game diagnosis (spec 226 H): the payoff for refusing to supply the
// legal-move list.
//
// Once the game is over and the spec 219 lockout lifts, the engine reviews the
// same positions the player thought about. Laying the engine's verdict beside
// the player's RECORDED THINKING — the candidates they named BEFORE they saw
// the answer — splits "I played badly" into failures that are separately
// trainable, because they are different skills with different remedies:
//
//   BLIND SPOT            a move that mattered was never on the list at all
//                         → candidate generation; seeing the moves
//   MISJUDGEMENT          the move was listed, but assessed wrongly
//                         → positional evaluation
//   SELECTION ERROR       it was listed AND assessed right, and they played
//                         something else anyway
//                         → choosing under pressure, not evaluation
//   OPPONENT-MODEL ERROR  a reply marked "unlikely" came, or a reply marked
//                         "likely" never did
//                         → reading this specific opponent
//
// No existing tool separates these, because no existing tool records what the
// player considered before seeing the answer. That record exists only because
// the app refused to enumerate legal moves (spec 226 "Two co-equal goals").
//
// Four rules govern this module, and none is negotiable:
//
//  1. POST-GAME ONLY. Every output here is engine-derived by construction, so
//     `diagnoseGame` is gated at the query layer with the same inverted default
//     as the training store's by-position read: a caller who cannot say where
//     it is standing gets a refusal, not a diagnosis. There is no path from a
//     live game to any of this.
//  2. NOTHING IS WRITTEN BACK. This module takes a record and returns a new
//     document. It never mutates the record, never touches the tree, and in
//     particular never writes an engine verdict where the notebook's ranking
//     could read it — `assessedBy` stays human-only and engine numbers stay in
//     `node.eval` (spec 226 G).
//  3. NO POSITION INDEX IS BUILT. The join key here is the tree NODE ID, the
//     same key the batch review reports evals under. This module never keys
//     anything by FEN, so it adds no retrieval path the doctrine forbids
//     (spec 226 G/J); `fen` is carried through as context only.
//  4. HONESTY ABOUT SAMPLE SIZE. One game is a handful of data points, not a
//     pattern. `diagnoseGame` states that on every result it returns, and
//     `aggregateDiagnoses` REFUSES to name a leading failure class below the
//     floors declared below rather than dressing three observations as a
//     tendency (the same gate spec 225 applies to player profiles).

import { judgeMove, judgmentCp, type MoveJudgment } from "./annotations";
import type { Likelihood, NodeEval } from "./game-tree";
import type { Assessment } from "./notebook";
import { positionQueryAllowed } from "./training-record";
import type {
  ArchivedGameRef,
  CandidateRecord,
  DecisionRecord,
  TrainingPlayerRef,
  TrainingRecord,
} from "./training-record";

// ---- the engine's side of the comparison ---------------------------------

/**
 * What the batch review produced, in the shape it already produces it.
 *
 * `GameAnalysisCallbacks.onEval(id, ev)` (apps/desktop/lib/game-analysis.ts)
 * reports one white-POV `NodeEval` per tree node id, where a node's eval is the
 * position AFTER that node's move. Collecting those into a map is the whole
 * adapter — this module deliberately invents no eval format of its own, so a
 * second producer (a deeper re-run, evals lifted from `[%eval]` tags) drops in
 * with no translation.
 *
 * A decision's own node id therefore carries the eval of the position the
 * decision was MADE from, and each candidate's node id the eval of the position
 * after that candidate. Both are needed and both are already there.
 */
export type EngineEvals = ReadonlyMap<string, NodeEval>;

/**
 * The engine's preferred move from a position, keyed by the node id of the
 * position it is played FROM.
 *
 * Optional, because today's mainline runner reports evals and not `bestmove`.
 * Without it a blind spot is still DETECTED — the arithmetic below needs only
 * the evals — but it cannot be NAMED, and `san: null` says so rather than
 * guessing. Supplying it is what turns "something better existed" into "Nd5
 * existed", which is the difference between a statistic and a training
 * exercise.
 */
export interface EngineBestMove {
  san: string;
  uci: string;
}

export type EngineBestMoves = ReadonlyMap<string, EngineBestMove>;

// ---- thresholds ----------------------------------------------------------

/**
 * How much better a move has to be before it counts as "a move that mattered".
 *
 * Half a pawn, and not a number picked for feeling right: it is exactly the
 * floor at which `judgeMove` already calls a move an INACCURACY (spec 202). So
 * the diagnosis fires precisely where the app is already willing to criticise
 * the move in the move list, and never on a difference it would have let pass.
 * One threshold, one story.
 *
 * It also has to be at least this high for a second reason. The two evals being
 * compared come from two independent fixed-budget searches of two different
 * positions, so small differences are search noise as often as chess; and a
 * difference a human could not have acted on is not a training signal, it is a
 * complaint.
 */
export const MATTERS_MIN_CP = 50;

/**
 * The seven-point scale in centipawns — the translation the misjudgement test
 * needs, and the only place engine numbers are pushed into the human
 * vocabulary.
 *
 * Edges rather than a formula, because the vocabulary is ordinal and its
 * boundaries are conventions, not measurements: under a third of a pawn no
 * strong player writes anything but "=", around half to one pawn is the "⩲"
 * region, one to two and a half is where "±" is written, and past that people
 * write "+−". Mate collapses to the outer band.
 *
 * This mapping is used ONLY to compare against the human's own symbol. It is
 * never written onto a node — the ranking reads human assessments and nothing
 * else, and a derived band stored beside them would be exactly the laundering
 * spec 226 G forbids.
 */
export const ASSESSMENT_BAND_EDGES_CP: readonly [number, number, number] = [30, 90, 250];

/**
 * How far apart the human's symbol and the engine's band have to be before the
 * disagreement counts as a misjudgement. Two bands.
 *
 * One band is inside the noise of the vocabulary itself: whether a position is
 * "=" or "⩲" is a matter of taste even between two grandmasters, the engine's
 * number is a search result rather than a judgement, and the edges above are
 * conventions. Flagging one-band gaps would bury the real errors under a list
 * of quibbles. Two bands is a disagreement no amount of taste explains — "I had
 * it equal, the engine has me clearly worse".
 *
 * BUT band distance alone is not a constant amount of disagreement, and on its
 * own it contradicts MATTERS_MIN_CP: the scale is signed, so a symbol that
 * straddles zero can jump two bands over a few centipawns ("⩱" against an
 * engine reading of +0.30) while "=" against the same +0.30 passes as taste.
 * Flagging the first and not the second is indefensible chess. So a
 * misjudgement needs BOTH — two bands AND at least MATTERS_MIN_CP between the
 * engine's number and the nearest number the human's symbol admits
 * (`bandDistanceCp`). Same floor, same reason: a difference a human could not
 * have acted on is not a training signal.
 */
export const MISJUDGEMENT_MIN_BANDS = 2;

/**
 * The aggregate's floors (spec 226 H, "bounded honestly"; the same gate spec
 * 225 applies to player profiles).
 *
 * Five separate floors because each closes a different way of lying with a
 * small sample:
 *
 *  - GAMES, because failures inside one game are not independent observations.
 *    A single game where the player was tired and never looked past their first
 *    idea produces a dozen blind spots that are one event, not a tendency.
 *  - GAMES CONTRIBUTING THE LEADING CLASS, because counting games DIAGNOSED
 *    does not close that hole at all: five games whose blind spots all came
 *    from one of them is still one tired evening, dressed as a season. The
 *    leading finding has to be DISPERSED before it is a tendency.
 *  - PLAYED DECISIONS, because that is the actual denominator — and played
 *    ones, so a single three-day think with a wide analysis tree cannot buy its
 *    way past the gate with decisions that were never on the board.
 *  - DECISIONS IN THE LEADING CLASS, because "blind spots lead 3-2" is
 *    arithmetic, not a finding. Counted as DECISIONS rather than failure
 *    instances: one decision can carry a blind spot, a misjudgement and a
 *    selection error at once, so instances let a handful of positions clear a
 *    floor meant to represent a handful of separate events.
 *
 * And a LEAD RATIO on top, because a near-tie between two classes points at no
 * remedy at all — which is the only thing the aggregate exists to do.
 */
export const PATTERN_MIN_GAMES = 5;
export const PATTERN_MIN_GAMES_WITH_CLASS = 3;
export const PATTERN_MIN_SCORED_DECISIONS = 30;
export const PATTERN_MIN_CLASS_OBSERVATIONS = 8;
export const PATTERN_MIN_LEAD_RATIO = 1.5;

/** Stamped on every single-game result. One game is never a pattern, and the
 *  result says so in its own words rather than leaving the caller to remember. */
export const SINGLE_GAME_NOTE =
  "One game is a handful of data points, not a pattern — aggregate across games " +
  "before reading a tendency into these.";

export const DIAGNOSIS_REFUSED =
  "Post-game diagnosis is engine-derived and is refused during an active " +
  "chess.com daily game (fair play, spec 219 / 226 G). It runs after the game.";

// ---- the failure classes -------------------------------------------------

export type FailureClass =
  | "blind-spot"
  | "misjudgement"
  | "selection-error"
  | "opponent-model";

/**
 * Severity order for the headline, most fundamental first.
 *
 * Not a ranking of how costly the mistakes were — that is `cp`, and it is
 * reported per failure. This is the order in which the failures EXPLAIN each
 * other: you cannot judge a move you never saw, and you cannot choose a move
 * you judged wrongly. So the earliest link in that chain is the one worth
 * putting at the top of a decision.
 */
export const FAILURE_SEVERITY: readonly FailureClass[] = [
  "blind-spot",
  "misjudgement",
  "selection-error",
  "opponent-model",
];

/**
 * One failure at one decision.
 *
 * A discriminated union rather than one wide record with mostly-null fields:
 * the four classes carry genuinely different evidence, and a shape that made
 * `bands` optional on a blind spot would invite a consumer to look for it.
 */
export type Failure =
  | {
      class: "blind-spot";
      /** The move they missed, when the engine named one; null when only its
       *  existence is known (no best-move data — see `EngineBestMoves`). */
      san: string | null;
      /** How far short their WHOLE candidate list fell, mover-POV cp. */
      cp: number;
      tier: MoveJudgment | null;
      /** What they did name, so the miss reads in context. */
      named: string[];
    }
  | {
      class: "misjudgement";
      san: string;
      /**
       * The player's CONCLUSION about the move — the backed-up value the
       * notebook itself displays and ranks on, not the symbol sitting on the
       * move. A player who wrote "⩲" when they first looked, then searched,
       * found the refutation and backed "∓" up to the move got it RIGHT, and
       * grading them on the abandoned first impression would misfire on exactly
       * the players who use the notebook as section B intends.
       */
      human: Assessment;
      /** The abandoned first impression, present only when the search moved
       *  it. Not a misjudgement — "I was wrong at first and my search fixed
       *  it" is a different (and better) fact, and it is reported as one. */
      firstImpression?: Assessment;
      engine: Assessment;
      /** The engine's own number for the position after the move, white-POV. */
      cp: number;
      /** True when the player's symbol was better for THEM than the engine's. */
      overrated: boolean;
    }
  | {
      class: "selection-error";
      /** The better move — on their list, and correctly assessed. */
      san: string;
      playedSan: string;
      /** How much better it was than what they played, mover-POV cp. */
      cp: number;
      tier: MoveJudgment | null;
    }
  | {
      class: "opponent-model";
      kind: "unlikely-played" | "likely-absent";
      /** The reply that actually came. */
      san: string;
      likelihood: Likelihood | null;
      /** The reply they had marked likely, when there was one. */
      expectedSan: string | null;
      /**
       * What the surprise cost the PLAYER, cp, negative when the reply that
       * came was worse for them than the one they expected. Null whenever there
       * is no expected reply to measure against, or either eval is missing —
       * an unmeasured cost is reported as unmeasured.
       */
      cp: number | null;
    };

/** Per-decision verdict. Present for every decision the engine could speak
 *  about, including the clean ones, so the denominator is never lost. */
export interface DecisionDiagnosis {
  nodeId: string;
  ply: number;
  line: string[];
  /** Carried through from the record. Empty when the record arrived redacted;
   *  this module never keys on it (rule 3). */
  fen: string;
  /** True when it was the USER's move — their candidate generation on trial.
   *  False when it was the opponent's — their reading of him on trial. */
  mine: boolean;
  played: boolean;
  playedSan: string | null;
  /** Mover-POV centipawn loss of the move actually played; null when it has no
   *  eval (a decision inside a line the engine did not review). */
  playedLossCp: number | null;
  /** The candidates the player produced THEMSELVES — never topped up. */
  named: string[];
  /**
   * How many of `named` the engine actually answered for.
   *
   * The blind-spot test is a claim about their WHOLE list ("nothing I named was
   * good enough"), so it is only true if the whole list was evaluated. A
   * cancelled or errored run leaves some candidates unevaluated, and the
   * minimum over the survivors would invent a blind spot that a complete run
   * does not find. Below full coverage the class is suppressed and these two
   * numbers say why.
   */
  namedEvaluated: number;
  failures: Failure[];
  /** The headline class by `FAILURE_SEVERITY`; null when the decision is clean.
   *  Blind spot and misjudgement CO-OCCUR routinely (missing the best move and
   *  misjudging a move you did see are independent events), so both stay in
   *  `failures` and this is only the label you would print first. */
  primary: FailureClass | null;
}

/**
 * Counts split by whose decision it was — never pooled.
 *
 * The blind-spot pass runs at the opponent's decisions too, deliberately, and
 * `mine` on each decision is what keeps the two populations separable. Folding
 * them into one number throws that away at the last step: "your leading failure
 * is blind spots" reads as a claim about generating YOUR OWN candidates, and it
 * may be entirely about failing to enumerate HIS replies. Those are different
 * skills with different remedies, which is the whole premise of the section.
 */
export interface SidedCount {
  mine: number;
  his: number;
}

export type FailureCounts = Record<FailureClass, SidedCount>;

export type FailureSide = "mine" | "his";

/** Both sides of one class. A fact worth having, but never the thing a
 *  pattern is claimed over — that ranks on the split (`aggregateDiagnoses`). */
export function classTotal(counts: FailureCounts, c: FailureClass): number {
  return counts[c].mine + counts[c].his;
}

export function failuresTotal(counts: FailureCounts): number {
  return FAILURE_SEVERITY.reduce((n, c) => n + classTotal(counts, c), 0);
}

export interface GameDiagnosis {
  recordId: string;
  /** The pointer, so a finding is actionable: it leads back to the game. */
  game: ArchivedGameRef;
  player: TrainingPlayerRef;
  /** Every decision the engine could speak about, in ply order. */
  decisions: DecisionDiagnosis[];
  /** Decisions the engine could speak about — the denominator. */
  scoredDecisions: number;
  /** …of which occurred in the game AS PLAYED. The honest denominator for a
   *  cross-game claim: analysis side lines are real work, but a hundred of them
   *  in one think are not a hundred separate chances to go wrong. */
  scoredPlayedDecisions: number;
  /** Failure INSTANCES, by class and side. */
  counts: FailureCounts;
  /** DECISIONS carrying each class, by side — at most one per decision per
   *  class. This is what the aggregate ranks on: one position that went wrong
   *  in three ways is one position. */
  decisionCounts: FailureCounts;
  /** Always `SINGLE_GAME_NOTE`. Rule 4. */
  note: string;
}

// ---- arithmetic ----------------------------------------------------------

export function emptyCounts(): FailureCounts {
  return {
    "blind-spot": { mine: 0, his: 0 },
    misjudgement: { mine: 0, his: 0 },
    "selection-error": { mine: 0, his: 0 },
    "opponent-model": { mine: 0, his: 0 },
  };
}

/** White-POV capped cp, flipped to the mover's side. `judgmentCp` is shared
 *  with `judgeMove` so both agree about mate and about the ±10-pawn cap. */
function moverCp(ev: NodeEval, moverIsWhite: boolean): number {
  return moverIsWhite ? judgmentCp(ev) : -judgmentCp(ev);
}

/**
 * Grade a mover-POV loss with `judgeMove`'s own boundaries, by handing it a
 * synthetic pair that has exactly that drop. Reuse rather than re-declaration:
 * a second copy of 50/100/300 here would drift from the move list's ?!/?/??
 * the first time either moved.
 */
function tierForLoss(cp: number): MoveJudgment | null {
  return judgeMove({ cp: 0 }, { cp: -cp }, true);
}

/** White-POV eval → the seven-point band, for comparison against the human's
 *  own symbol only (never stored — see ASSESSMENT_BAND_EDGES_CP). */
export function bandOf(ev: NodeEval): Assessment {
  if (ev.mate !== undefined) return ev.mate > 0 ? 3 : -3;
  const cp = ev.cp ?? 0;
  const mag = Math.abs(cp);
  const [slight, clear, winning] = ASSESSMENT_BAND_EDGES_CP;
  const band = mag < slight ? 0 : mag < clear ? 1 : mag < winning ? 2 : 3;
  return (cp < 0 ? -band : band) as Assessment;
}

/**
 * The centipawn interval a symbol admits, White-positive — the inverse of
 * `bandOf`, and open-ended at the winning end because "+−" makes no claim about
 * how much winning.
 */
function bandIntervalCp(a: Assessment): [number, number] {
  const [slight, clear, winning] = ASSESSMENT_BAND_EDGES_CP;
  if (a === 0) return [-slight, slight];
  const mag = Math.abs(a);
  const lo = mag === 1 ? slight : mag === 2 ? clear : winning;
  const hi = mag === 1 ? clear : mag === 2 ? winning : Infinity;
  return a > 0 ? [lo, hi] : [-hi, -lo];
}

/**
 * How many centipawns apart the human's symbol and the engine's number
 * actually are: the distance from the engine's cp to the NEAREST cp the
 * human's band admits, so a symbol is never charged for the width of its own
 * interval. Zero whenever the engine's number is inside the band the player
 * wrote.
 */
export function bandDistanceCp(a: Assessment, cp: number): number {
  const [lo, hi] = bandIntervalCp(a);
  if (cp < lo) return lo - cp;
  if (cp > hi) return cp - hi;
  return 0;
}

/**
 * The player's CONCLUSION about a candidate: the backed-up value the notebook
 * displays and ranks on, falling back to the symbol on the move itself at a
 * leaf (where minimax makes them the same anyway).
 *
 * This is what a misjudgement has to be graded against. Section B exists to let
 * a player revise a first impression by searching, and grading the abandoned
 * impression would flag the discipline the feature is built to reward.
 */
function concluded(c: CandidateRecord): Assessment | null {
  if (c.backedUp === null) return c.assessment;
  const v = Math.round(c.backedUp);
  return Math.max(-3, Math.min(3, v)) as Assessment;
}

/** "At least as good for the mover", on the White-positive scale. */
function atLeastAsGood(a: Assessment, b: Assessment, moverIsWhite: boolean): boolean {
  return moverIsWhite ? a >= b : a <= b;
}

// ---- one decision --------------------------------------------------------

interface Scored {
  candidate: CandidateRecord;
  ev: NodeEval;
  /** Mover-POV centipawns given up versus the best the engine found here. */
  loss: number;
}

function diagnoseDecision(
  decision: DecisionRecord,
  myColor: "white" | "black",
  evals: EngineEvals,
  best: EngineBestMoves | undefined,
): DecisionDiagnosis | null {
  const before = evals.get(decision.nodeId);
  // No eval for the position the decision was made from means there is nothing
  // to compare anything against. Not an error — the batch review covers the
  // game as played, and a decision deep inside a side line simply was not
  // reviewed. It drops out of the denominator too, which is the honest handling.
  if (!before) return null;

  const moverIsWhite = decision.sideToMove === "white";
  const baseline = moverCp(before, moverIsWhite);

  // The candidate set is the moves the player produced THEMSELVES. A move the
  // app served out of a position-indexed corpus (`own === false`) is chess the
  // APP named; counting it here would quietly repair the blind-spot record this
  // whole feature exists to produce (spec 226 C).
  const own = decision.candidates.filter((c) => c.own);
  const named = own.map((c) => c.san);

  const scored: Scored[] = [];
  for (const c of own) {
    const ev = evals.get(c.nodeId);
    if (ev) scored.push({ candidate: c, ev, loss: baseline - moverCp(ev, moverIsWhite) });
  }

  const playedId = decision.playedMove?.nodeId ?? null;
  const playedEv = playedId ? evals.get(playedId) ?? null : null;
  const playedLossCp = playedEv ? baseline - moverCp(playedEv, moverIsWhite) : null;

  const failures: Failure[] = [];

  // ---- blind spot ----
  //
  // "A move that mattered was never on the candidate list at all." With the
  // position's own eval in hand this needs no best-move data to DETECT: the
  // engine's eval of the position is the value of its best move, so if the
  // least-losing move on the player's entire list still gives up more than
  // MATTERS_MIN_CP, then something better than anything they named existed.
  //
  // This applies at the OPPONENT's decisions too, and deliberately. Failing to
  // see his strongest reply is a failure of vision, not of opponent modelling —
  // `mine` on the result keeps the two populations separable, which is what a
  // curriculum needs.
  //
  // A decision where the only candidate was the move played is included rather
  // than special-cased: a one-move list that missed something better IS a blind
  // spot, and "at move 23 I put nothing on the board but the move I played" is
  // precisely the fact the record was built to keep.
  //
  // FULL COVERAGE IS REQUIRED. The claim is about their whole list, so it is
  // only true if the whole list was searched: with one candidate missing an
  // eval — which is exactly what Stop, or an engine error mid-run, leaves
  // behind — the minimum over the survivors can report a three-pawn blind spot
  // at a decision where the missing candidate was the best move on the board.
  // Same handling as a decision whose own node has no eval: say nothing.
  if (scored.length > 0 && scored.length === own.length) {
    const bestNamed = Math.min(...scored.map((s) => s.loss));
    const engineBest = best?.get(decision.nodeId) ?? null;
    // If the engine's own move is on their list, there is no blind spot to
    // report whatever the arithmetic says — the search noise the threshold
    // exists to absorb cannot have hidden a move they visibly named.
    const namedTheBest =
      engineBest !== null && own.some((c) => c.uci === engineBest.uci || c.san === engineBest.san);
    if (bestNamed >= MATTERS_MIN_CP && !namedTheBest) {
      failures.push({
        class: "blind-spot",
        san: engineBest?.san ?? null,
        cp: Math.round(bestNamed),
        tier: tierForLoss(bestNamed),
        named,
      });
    }
  }

  // ---- misjudgement ----
  //
  // "The move was listed, but assessed wrongly." Only the player's OWN symbols
  // count: `assessment` reads through `assessmentOf`, so a position NAG that
  // arrived in an imported annotated PGN is invisible here exactly as it is to
  // the notebook's ranking.
  //
  // Scored at both kinds of decision. Misjudging one of the opponent's replies
  // is a failure of positional evaluation just as much as misjudging your own
  // move, and it trains the same thing.
  const misjudged = new Set<string>();
  for (const s of scored) {
    const human = concluded(s.candidate);
    if (human === null) continue;
    const engine = bandOf(s.ev);
    const cp = judgmentCp(s.ev);
    if (Math.abs(human - engine) < MISJUDGEMENT_MIN_BANDS) continue;
    // …and a real amount of centipawns apart, not just a symbol that straddles
    // zero. See MISJUDGEMENT_MIN_BANDS.
    if (bandDistanceCp(human, cp) < MATTERS_MIN_CP) continue;
    misjudged.add(s.candidate.nodeId);
    const leaf = s.candidate.assessment;
    failures.push({
      class: "misjudgement",
      san: s.candidate.san,
      human,
      ...(leaf !== null && leaf !== human ? { firstImpression: leaf } : {}),
      engine,
      cp,
      // "Overrated" is from the PLAYER's side of the board, not White's — the
      // useful reading is "I flattered my position", whichever colour they had.
      overrated: myColor === "white" ? human > engine : human < engine,
    });
  }

  // ---- selection error ----
  //
  // The fourth thing, and it is handled rather than waved away: the engine's
  // better move WAS on the list, the player judged it correctly, and they
  // played something else. That is neither vision nor evaluation — it is what
  // happened between the judgement and the hand, and its remedy (time use,
  // second-guessing, playing the move you already decided on) is different
  // again. Left unclassified it would silently inflate the misjudgement count
  // and send the player to study positions they judged perfectly well.
  //
  // "Correctly assessed" is deliberately strict on both halves: the candidate
  // must not itself be a misjudgement, AND the player's own symbols must have
  // rated it at least as good as the move they chose. If they judged it worse
  // than what they played, they did not knowingly pass it over, and the failure
  // is the judgement — which the misjudgement pass has already recorded.
  //
  // Only at the player's own decisions: at the opponent's, they chose nothing.
  //
  // Judged on their CONCLUSIONS, the same values the notebook ranked on when
  // they made the choice — not on a first impression they had already revised.
  //
  // And ONLY when the notebook is what decided the move. A selection error
  // says "you had the answer in front of you and picked something else", which
  // is a claim about a choice made FROM the analysis. The user played b6 in a
  // real game having given up on reading their own panel — gut feel, notebook
  // unused (2026-07-21). Reported as a selection error that would prescribe
  // training for choosing badly, when nothing was chosen from; the real
  // finding is that the analysis was unreadable, which is a UI failure and not
  // a chess one. Unrecorded provenance counts as unknown, not as "notebook":
  // the conservative default, same as every other gate in this feature.
  const fromNotebook = decision.playedMove?.chosenBy === "notebook";
  if (decision.mine && playedId && playedLossCp !== null && fromNotebook) {
    const playedCandidate = own.find((c) => c.nodeId === playedId);
    const playedHuman = playedCandidate ? concluded(playedCandidate) : null;
    const better = scored
      .filter((s) => {
        const value = concluded(s.candidate);
        return (
          s.candidate.nodeId !== playedId &&
          !misjudged.has(s.candidate.nodeId) &&
          value !== null &&
          playedLossCp - s.loss >= MATTERS_MIN_CP &&
          (playedHuman === null || atLeastAsGood(value, playedHuman, moverIsWhite))
        );
      })
      .sort((a, b) => a.loss - b.loss)[0];
    if (better) {
      const gain = playedLossCp - better.loss;
      failures.push({
        class: "selection-error",
        san: better.candidate.san,
        playedSan: decision.playedMove!.san,
        cp: Math.round(gain),
        tier: tierForLoss(gain),
      });
    }
  }

  // ---- opponent-model error ----
  //
  // Only at HIS decisions, and only over replies the player actually bucketed.
  // A reply they never labelled carries no prediction, and grading a prediction
  // that was never made would manufacture an error out of silence.
  //
  // At most ONE per decision, because it is one prediction that failed. Two
  // replies marked likely and neither arriving is still a single wrong reading
  // of the position, and counting it twice would let a decision the player
  // labelled thoroughly outweigh one they barely labelled at all — rewarding
  // less work, which is the same defect that keeps width out of the ranking
  // (spec 226 I).
  if (!decision.mine && decision.playedMove) {
    const played = decision.playedMove;
    const likely = decision.candidates.filter((c) => c.likelihood === 3);
    const expected = likely.find((c) => c.nodeId !== played.nodeId) ?? null;
    // Cost is measured from the PLAYER's side: how much worse the reply that
    // came was for them than the one they were expecting. Only defined when
    // there was an expectation and both replies were evaluated.
    const playerIsWhite = !moverIsWhite;
    const expectedEv = expected ? evals.get(expected.nodeId) ?? null : null;
    const cp =
      playedEv && expectedEv
        ? Math.round(moverCp(playedEv, playerIsWhite) - moverCp(expectedEv, playerIsWhite))
        : null;

    if (played.likelihood === 1) {
      // He played the one they had written off.
      failures.push({
        class: "opponent-model",
        kind: "unlikely-played",
        san: played.san,
        likelihood: played.likelihood,
        expectedSan: expected?.san ?? null,
        cp,
      });
    } else if (expected && played.likelihood !== 3) {
      // They named a reply likely and it never came.
      failures.push({
        class: "opponent-model",
        kind: "likely-absent",
        san: played.san,
        likelihood: played.likelihood,
        expectedSan: expected.san,
        cp,
      });
    }
  }

  const primary =
    FAILURE_SEVERITY.find((c) => failures.some((f) => f.class === c)) ?? null;

  return {
    nodeId: decision.nodeId,
    ply: decision.ply,
    line: [...decision.line],
    fen: decision.fen,
    mine: decision.mine,
    played: decision.played,
    playedSan: decision.playedMove?.san ?? null,
    playedLossCp: playedLossCp === null ? null : Math.round(playedLossCp),
    named,
    namedEvaluated: scored.length,
    failures,
    primary,
  };
}

// ---- one game ------------------------------------------------------------

export interface DiagnoseOptions {
  /**
   * Where the caller is standing. Required, with no default, and checked
   * against the SAME gate as the training store's by-position read: everything
   * this module returns is engine-derived, so a caller who could not say where
   * it was gets a refusal. A parameter that defaulted to "allowed" would be a
   * gate that opens itself the first time somebody forgets it.
   */
  context: string | null | undefined;
  /** Engine best moves per decision position, when the review captured them. */
  bestMoves?: EngineBestMoves;
}

/**
 * Diagnose one finished game: the player's recorded thinking against the
 * engine's verdict on the same positions.
 *
 * Pure. The record and the eval map are read and neither is touched, so no
 * engine number can reach the notebook's ranking through this path (rule 2).
 *
 * A record with no notebook content — or one the engine never reviewed —
 * produces an empty diagnosis rather than throwing. There is nothing wrong
 * with a game the player did not take notes on; it simply has nothing to say.
 */
export function diagnoseGame(
  record: TrainingRecord,
  evals: EngineEvals,
  opts: DiagnoseOptions,
): GameDiagnosis {
  if (!positionQueryAllowed(opts.context)) throw new Error(DIAGNOSIS_REFUSED);

  const decisions: DecisionDiagnosis[] = [];
  for (const d of record.decisions) {
    const got = diagnoseDecision(d, record.player.myColor, evals, opts.bestMoves);
    if (got) decisions.push(got);
  }
  decisions.sort((a, b) => a.ply - b.ply || a.nodeId.localeCompare(b.nodeId));

  // Two folds, kept apart on purpose. `counts` is instances — what happened.
  // `decisionCounts` is POSITIONS that carried the class, which is the unit a
  // cross-game claim has to be made in: a decision that produced a blind spot,
  // a misjudgement and a selection error is one thing that went wrong, not
  // three. Both are sided, because "blind spots" at his decisions and at mine
  // train different skills (spec 226 H).
  const counts = emptyCounts();
  const decisionCounts = emptyCounts();
  for (const d of decisions) {
    const side: FailureSide = d.mine ? "mine" : "his";
    const seen = new Set<FailureClass>();
    for (const f of d.failures) {
      counts[f.class][side]++;
      seen.add(f.class);
    }
    for (const c of seen) decisionCounts[c][side]++;
  }

  return {
    recordId: record.id,
    game: record.game,
    player: record.player,
    decisions,
    scoredDecisions: decisions.length,
    scoredPlayedDecisions: decisions.filter((d) => d.played).length,
    counts,
    decisionCounts,
    note: SINGLE_GAME_NOTE,
  };
}

// ---- across games --------------------------------------------------------

export type SampleVerdict = "insufficient-sample" | "no-clear-pattern" | "pattern";

export interface DiagnosisAggregate {
  games: number;
  scoredDecisions: number;
  /** …of which were played positions. The denominator the floors test. */
  scoredPlayedDecisions: number;
  /** Facts, always reported. Counting what happened is not characterising it. */
  counts: FailureCounts;
  /** Decisions carrying each class, by side — what the pattern ranks on. */
  decisionCounts: FailureCounts;
  /**
   * The claim — and null unless the sample earns it. This is the field that
   * refuses: below the floors, or without a clear leader, there is no leading
   * failure class to name and none is invented.
   *
   * `side` is part of the claim rather than a detail: "blind spots at his
   * decisions" is a failure to enumerate the opponent's replies and "blind
   * spots at mine" is a failure to generate my own candidates, and sending a
   * player to the wrong one of those is worse than sending them nowhere.
   * `games` is how many separate games contributed it.
   */
  pattern: {
    leading: FailureClass;
    side: FailureSide;
    count: number;
    share: number;
    games: number;
  } | null;
  sample: {
    verdict: SampleVerdict;
    /** Why, in the aggregate's own words — thresholds included, so a caller
     *  rendering this never has to restate them and never gets them wrong. */
    reasons: string[];
  };
}

/**
 * Fold per-game diagnoses into a cross-game reading — and refuse to characterise
 * one that is too small (spec 226 H, spec 225's sample gate).
 *
 * The counts are always returned, because counting what happened is a fact. It
 * is the WORD for it — "you have a blind-spot problem" — that has to be earned,
 * and `pattern` stays null until it is.
 */
export function aggregateDiagnoses(games: readonly GameDiagnosis[]): DiagnosisAggregate {
  const counts = emptyCounts();
  const decisionCounts = emptyCounts();
  let scoredDecisions = 0;
  let scoredPlayedDecisions = 0;
  // Games that contributed each (class, side) — the dispersion test. Without
  // it the games floor counts games DIAGNOSED and nothing stops every
  // observation coming from one of them.
  const gamesWith = new Map<string, number>();

  for (const g of games) {
    scoredDecisions += g.scoredDecisions;
    scoredPlayedDecisions += g.scoredPlayedDecisions;
    for (const c of FAILURE_SEVERITY) {
      for (const side of SIDES) {
        counts[c][side] += g.counts[c][side];
        const n = g.decisionCounts[c][side];
        decisionCounts[c][side] += n;
        if (n > 0) gamesWith.set(key(c, side), (gamesWith.get(key(c, side)) ?? 0) + 1);
      }
    }
  }

  // Ranked over the SPLIT: a (class, side) pair is the unit a remedy attaches
  // to, and the unit counted is decisions rather than failure instances.
  const ranked = FAILURE_SEVERITY.flatMap((c) =>
    SIDES.map((side) => ({ c, side, n: decisionCounts[c][side] })),
  ).sort((a, b) => b.n - a.n);
  const top = ranked[0];
  const runnerUp = ranked[1]?.n ?? 0;
  const total = FAILURE_SEVERITY.reduce(
    (n, c) => n + decisionCounts[c].mine + decisionCounts[c].his,
    0,
  );
  const spread = gamesWith.get(key(top.c, top.side)) ?? 0;
  const label = `${top.c} (${SIDE_WORDS[top.side]})`;

  const reasons: string[] = [];
  if (games.length < PATTERN_MIN_GAMES) {
    reasons.push(
      `${games.length} game${games.length === 1 ? "" : "s"} — a pattern needs at least ${PATTERN_MIN_GAMES}.`,
    );
  }
  if (scoredPlayedDecisions < PATTERN_MIN_SCORED_DECISIONS) {
    reasons.push(
      `${scoredPlayedDecisions} reviewed decisions from the games as played — a pattern needs at least ${PATTERN_MIN_SCORED_DECISIONS}.`,
    );
  }
  if (reasons.length > 0) {
    return {
      games: games.length,
      scoredDecisions,
      scoredPlayedDecisions,
      counts,
      decisionCounts,
      pattern: null,
      sample: { verdict: "insufficient-sample", reasons },
    };
  }

  if (top.n < PATTERN_MIN_CLASS_OBSERVATIONS) {
    reasons.push(
      `the most common failure appears at only ${top.n} decision${top.n === 1 ? "" : "s"} — a pattern needs at least ${PATTERN_MIN_CLASS_OBSERVATIONS}.`,
    );
  }
  if (spread < PATTERN_MIN_GAMES_WITH_CLASS) {
    reasons.push(
      `${label} appears in only ${spread} of ${games.length} games — a pattern needs at least ${PATTERN_MIN_GAMES_WITH_CLASS}, or it is one evening rather than a tendency.`,
    );
  }
  if (runnerUp > 0 && top.n < runnerUp * PATTERN_MIN_LEAD_RATIO) {
    reasons.push(
      `${label} (${top.n}) does not lead ${ranked[1].c} (${SIDE_WORDS[ranked[1].side]}, ${runnerUp}) by the ${PATTERN_MIN_LEAD_RATIO}× margin a pattern needs.`,
    );
  }
  if (reasons.length > 0) {
    return {
      games: games.length,
      scoredDecisions,
      scoredPlayedDecisions,
      counts,
      decisionCounts,
      pattern: null,
      sample: { verdict: "no-clear-pattern", reasons },
    };
  }

  return {
    games: games.length,
    scoredDecisions,
    scoredPlayedDecisions,
    counts,
    decisionCounts,
    pattern: {
      leading: top.c,
      side: top.side,
      count: top.n,
      share: total === 0 ? 0 : top.n / total,
      games: spread,
    },
    sample: {
      verdict: "pattern",
      reasons: [
        `${label} at ${top.n} of ${total} flagged decisions, spread across ${spread} of ${games.length} games (${scoredPlayedDecisions} reviewed decisions as played).`,
      ],
    },
  };
}

const SIDES: readonly FailureSide[] = ["mine", "his"];
const SIDE_WORDS: Record<FailureSide, string> = { mine: "my moves", his: "his replies" };

function key(c: FailureClass, side: FailureSide): string {
  return `${c}:${side}`;
}

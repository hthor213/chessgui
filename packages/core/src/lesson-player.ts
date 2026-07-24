// Concept Lessons — the module-player state machine (specs/227, D3).
//
// A PURE, React-free reducer driving the three-beat module player
// (principle → illustrate → practice). The UI component is a dumb renderer over
// this: every branch here is a plain (state, action) → state transition, so the
// interleave pause/grade logic, the practice question progression, and the
// scorecard are all deterministically unit-testable with no DOM.
//
// Fair-play note (spec 227): this file reads NOTHING from the live game — it is
// fed only a lesson `Module` (bundled study content). Move legality is never
// re-implemented here: the interleaved "predict the move" grades through D1's
// 960-safe `gradeChooseMove`, and practice answers through D2's `gradeQuestion`.
//
// Ply convention (matches the fixture): a `FocusNote` at ply P pins its text to
// the position AFTER move P. When that note carries an `ask` and the
// illustration is `interleave`, the board pauses AT ply P and the user predicts
// the NEXT move (the one that produces ply P+1), graded from `fens[P]`.

import { parsePgnToTrees } from "./pgn";
import {
  gradeChooseMove,
  type Module,
  type Question,
  type FocusNote,
  type Illustration,
} from "./lessons";
import {
  gradeQuestion,
  scoreModule,
  type GradeResult,
  type ModuleAnswer,
  type ModuleScore,
  type SelfGrade,
} from "./lesson-grade";

// ── Precomputed illustration line (plain data — no GameTree instance) ────────

/**
 * An illustration flattened to plain data the reducer can step through: the
 * position FEN and SAN at each ply, the focus notes keyed by ply, and the
 * orientation to view it from. Built once at init via `parsePgnToTrees` (pure);
 * the reducer then never touches chessops except through the shared grader.
 */
export interface IllustrationLine {
  title: string;
  source: string;
  interleave: boolean;
  startPly: number;
  /** `fens[ply]` — the position after move `ply`; `fens[0]` is the start. */
  fens: string[];
  /** `sans[ply]` — the SAN of move `ply`; `sans[0]` is `""`. */
  sans: string[];
  /** `ucis[ply]` — the canonical UCI of move `ply` (for last-move highlight). */
  ucis: string[];
  maxPly: number;
  /** Focus notes keyed by the ply they are pinned to. */
  focus: Record<number, FocusNote>;
  /** Board orientation — the side predicting at the first `ask`, else white. */
  orientation: "white" | "black";
}

/** Flatten one illustration's PGN mainline into a `IllustrationLine`. */
export function buildIllustrationLine(ill: Illustration): IllustrationLine {
  const trees = parsePgnToTrees(ill.pgn);
  const tree = trees[0];
  const nodes = tree ? tree.mainlineNodes() : [];
  const fens: string[] = [];
  const sans: string[] = [];
  const ucis: string[] = [];
  for (const n of nodes) {
    fens[n.ply] = n.fen;
    sans[n.ply] = n.san;
    ucis[n.ply] = n.uci;
  }
  const maxPly = nodes.length ? nodes[nodes.length - 1].ply : 0;
  const focus: Record<number, FocusNote> = {};
  for (const f of ill.focus) focus[f.ply] = f;
  let orientation: "white" | "black" = "white";
  const firstAsk = ill.focus.find((f) => f.ask);
  if (firstAsk) {
    const fromFen = fens[firstAsk.ply];
    if (fromFen && / b /.test(fromFen)) orientation = "black";
  }
  return {
    title: ill.title,
    source: ill.source,
    interleave: ill.interleave ?? false,
    startPly: ill.startPly ?? 0,
    fens,
    sans,
    ucis,
    maxPly,
    focus,
    orientation,
  };
}

// ── State ────────────────────────────────────────────────────────────────────

export type Beat = "principle" | "illustrate" | "practice" | "done";

/** Feedback shown after an interleaved prediction. On a wrong move `text` is
 *  the `ask.explain` (names the specific mistake, per the north-star bar). */
export interface InterleaveFeedback {
  correct: boolean;
  text: string;
}

export interface LessonPlayerState {
  module: Module;
  lines: IllustrationLine[];
  beat: Beat;
  // Illustrate beat:
  illIndex: number;
  /** Current ply cursor within the active illustration. */
  ply: number;
  /** Board is paused at a focus ply, waiting for the user to predict a move. */
  awaiting: boolean;
  /** The focus ply the user is predicting FROM (its `ask` grades the move). */
  askPly: number | null;
  feedback: InterleaveFeedback | null;
  // Practice beat:
  qIndex: number;
  /** Collected answers, parallel to `module.questions`, for `scoreModule`. */
  answers: (ModuleAnswer | undefined)[];
  /** The graded result of the current question, or null before answering. */
  revealed: GradeResult | null;
}

/** Build the initial state for a module (principle beat, illustrations flattened). */
export function initLessonPlayer(module: Module): LessonPlayerState {
  const lines = module.illustrations.map(buildIllustrationLine);
  return {
    module,
    lines,
    beat: "principle",
    illIndex: 0,
    ply: lines[0]?.startPly ?? 0,
    awaiting: false,
    askPly: null,
    feedback: null,
    qIndex: 0,
    answers: new Array(module.questions.length).fill(undefined),
    revealed: null,
  };
}

// ── Actions ────────────────────────────────────────────────────────────────

export type LessonAction =
  /** Principle → illustrate (or practice if there are no illustrations). */
  | { type: "START" }
  | { type: "ILLUSTRATE_NEXT" }
  | { type: "ILLUSTRATE_PREV" }
  /** The user played `san` during an interleaved pause. */
  | { type: "PLAY_PREDICTION"; san: string }
  /** Skip the rest of the illustrations and jump to the practice beat. */
  | { type: "GO_TO_PRACTICE" }
  /** Answer the current practice question (index for MC, SAN for choose_move,
   *  ignored for free_text — pass undefined to reveal). */
  | { type: "ANSWER"; answer: number | string | null | undefined }
  /** Record the self-grade for the current free_text question. */
  | { type: "SELF_GRADE"; grade: SelfGrade }
  | { type: "NEXT_QUESTION" }
  | { type: "RESTART" };

// ── Reducer ──────────────────────────────────────────────────────────────────

function toModuleAnswer(
  q: Question,
  answer: number | string | null | undefined,
): ModuleAnswer {
  switch (q.kind) {
    case "multiple_choice":
      return typeof answer === "number" ? { kind: "multiple_choice", choice: answer } : null;
    case "choose_move":
      return typeof answer === "string" ? { kind: "choose_move", san: answer } : null;
    case "free_text":
      return { kind: "free_text", selfGrade: null };
  }
}

/** Finish the current illustration: advance to the next one, or to practice. */
function advanceIllustration(state: LessonPlayerState): LessonPlayerState {
  const nextIll = state.illIndex + 1;
  if (nextIll < state.lines.length) {
    return {
      ...state,
      illIndex: nextIll,
      ply: state.lines[nextIll].startPly,
      awaiting: false,
      askPly: null,
      feedback: null,
    };
  }
  return {
    ...state,
    beat: state.module.questions.length > 0 ? "practice" : "done",
    qIndex: 0,
    revealed: null,
  };
}

export function lessonPlayerReducer(
  state: LessonPlayerState,
  action: LessonAction,
): LessonPlayerState {
  switch (action.type) {
    case "START": {
      if (state.lines.length === 0) {
        return { ...state, beat: state.module.questions.length > 0 ? "practice" : "done" };
      }
      return {
        ...state,
        beat: "illustrate",
        illIndex: 0,
        ply: state.lines[0].startPly,
        awaiting: false,
        askPly: null,
        feedback: null,
      };
    }

    case "ILLUSTRATE_NEXT": {
      if (state.beat !== "illustrate" || state.awaiting) return state;
      const line = state.lines[state.illIndex];
      if (!line) return state;
      const next = state.ply + 1;
      if (next > line.maxPly) return advanceIllustration(state);
      const note = line.focus[next];
      // Pause for a prediction only when there is a move AFTER this focus ply
      // to predict (an `ask` on the final ply has nothing to guess).
      const askable = line.interleave && !!note?.ask && next < line.maxPly;
      return {
        ...state,
        ply: next,
        awaiting: askable,
        askPly: askable ? next : null,
        feedback: null,
      };
    }

    case "ILLUSTRATE_PREV": {
      if (state.beat !== "illustrate") return state;
      const line = state.lines[state.illIndex];
      if (!line) return state;
      const prev = Math.max(line.startPly, state.ply - 1);
      return { ...state, ply: prev, awaiting: false, askPly: null, feedback: null };
    }

    case "PLAY_PREDICTION": {
      if (state.beat !== "illustrate" || !state.awaiting || state.askPly === null) {
        return state;
      }
      const line = state.lines[state.illIndex];
      const ask = line.focus[state.askPly]?.ask;
      if (!ask) return state;
      // Predict the move FROM the focus position; grade via the 960-safe grader.
      const fromFen = line.fens[state.askPly];
      const correct = gradeChooseMove(fromFen, action.san, ask.accept);
      const nextPly = state.askPly + 1;
      const revealedNote = line.focus[nextPly];
      const feedback: InterleaveFeedback = correct
        ? { correct: true, text: revealedNote?.text ?? "Correct — that is the move." }
        : { correct: false, text: ask.explain };
      // Either way the model move is revealed on the board and the game
      // continues (a wrong guess simply carries the explanation with it).
      return {
        ...state,
        ply: nextPly <= line.maxPly ? nextPly : state.askPly,
        awaiting: false,
        askPly: null,
        feedback,
      };
    }

    case "GO_TO_PRACTICE":
      return {
        ...state,
        beat: state.module.questions.length > 0 ? "practice" : "done",
        qIndex: 0,
        revealed: null,
      };

    case "ANSWER": {
      if (state.beat !== "practice") return state;
      const q = state.module.questions[state.qIndex];
      if (!q) return state;
      const result = gradeQuestion(q, action.answer);
      const answers = state.answers.slice();
      answers[state.qIndex] = toModuleAnswer(q, action.answer);
      return { ...state, revealed: result, answers };
    }

    case "SELF_GRADE": {
      if (state.beat !== "practice") return state;
      const q = state.module.questions[state.qIndex];
      if (!q || q.kind !== "free_text") return state;
      const answers = state.answers.slice();
      answers[state.qIndex] = { kind: "free_text", selfGrade: action.grade };
      return { ...state, answers };
    }

    case "NEXT_QUESTION": {
      if (state.beat !== "practice") return state;
      const next = state.qIndex + 1;
      if (next >= state.module.questions.length) {
        return { ...state, beat: "done", revealed: null };
      }
      return { ...state, qIndex: next, revealed: null };
    }

    case "RESTART":
      return initLessonPlayer(state.module);
  }
  return state;
}

// ── Selectors (pure views for the dumb renderer) ─────────────────────────────

/** The FEN to show on the board during the illustrate beat (null otherwise). */
export function boardFen(state: LessonPlayerState): string | null {
  if (state.beat !== "illustrate") return null;
  const line = state.lines[state.illIndex];
  if (!line) return null;
  return line.fens[state.ply] ?? null;
}

/** The focus note to display beside the board right now (null if none). */
export function currentFocusNote(state: LessonPlayerState): FocusNote | null {
  if (state.beat !== "illustrate") return null;
  const line = state.lines[state.illIndex];
  if (!line) return null;
  return line.focus[state.ply] ?? null;
}

/** The active illustration line (null outside the illustrate beat). */
export function currentLine(state: LessonPlayerState): IllustrationLine | null {
  if (state.beat !== "illustrate") return null;
  return state.lines[state.illIndex] ?? null;
}

/** The current practice question (null outside the practice beat / when done). */
export function currentQuestion(state: LessonPlayerState): Question | null {
  if (state.beat !== "practice") return null;
  return state.module.questions[state.qIndex] ?? null;
}

/** The final scorecard, derived from the collected answers via `scoreModule`. */
export function moduleScore(state: LessonPlayerState): ModuleScore {
  return scoreModule(state.module, state.answers);
}

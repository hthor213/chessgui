// Concept Lessons — the question engine (specs/227, D2).
//
// Pure, data-driven graders for the three question kinds, plus a per-module
// scorer. No React, no I/O, no ambient time — everything is a pure function of
// its inputs so the whole layer is deterministically testable.
//
// Fair-play note (spec 227): grading a study question is allowed here because a
// lesson is generic study on public positions, never the live game.
//
// Division of labour: the `choose_move` grader (SAN membership, 960-safe) is
// D1's `gradeChooseMove` — REUSED here, never reimplemented. D2 adds the
// `multiple_choice` (index match) and `free_text` (reveal, no auto-grade)
// graders, a unified discriminated result, and `scoreModule`.

import {
  gradeChooseMove,
  type Module,
  type Question,
  type MultipleChoiceQuestion,
  type ChooseMoveQuestion,
  type FreeTextQuestion,
} from "./lessons";

// ── Grade results (discriminated on `kind`) ─────────────────────────────────

/** MCQ result: `correct` is the index-match verdict; `explanation` is the
 *  question's `explain` (names the mistake, per the north-star bar). */
export interface MultipleChoiceResult {
  kind: "multiple_choice";
  correct: boolean;
  explanation: string;
}

/** choose_move result: `correct` is the SAN-membership verdict (via D1's
 *  `gradeChooseMove`); `explanation` is the question's `explain`. */
export interface ChooseMoveResult {
  kind: "choose_move";
  correct: boolean;
  explanation: string;
}

/** free_text result: there is NO auto-grade in the MVP (spec 227 Tier A —
 *  self-graded), so `correct` is `null`. The reveal carries the model answer +
 *  rubric for the user to grade themselves against. */
export interface FreeTextResult {
  kind: "free_text";
  correct: null;
  modelAnswer: string;
  rubric: string[];
}

/** The typed, discriminated result of grading one question. */
export type GradeResult =
  | MultipleChoiceResult
  | ChooseMoveResult
  | FreeTextResult;

/** A self-grade for a free_text question (spec 227 Tier A). */
export type SelfGrade = "got_it" | "partial" | "missed";

// ── Per-kind graders ────────────────────────────────────────────────────────

/** Grade a multiple_choice answer: correct iff the chosen index equals the
 *  question's `correct` index. A missing / out-of-range choice grades false. */
export function gradeMultipleChoice(
  question: MultipleChoiceQuestion,
  choiceIndex: number | null | undefined,
): MultipleChoiceResult {
  const correct =
    typeof choiceIndex === "number" && choiceIndex === question.correct;
  return {
    kind: "multiple_choice",
    correct,
    explanation: question.explain,
  };
}

/** Grade a choose_move answer by delegating to D1's `gradeChooseMove` (SAN
 *  membership through the repo's parse/make-SAN path; 960-safe; false on a bad
 *  FEN or an illegal / missing played move). */
export function gradeChooseMoveQuestion(
  question: ChooseMoveQuestion,
  san: string | null | undefined,
): ChooseMoveResult {
  const correct =
    typeof san === "string" &&
    gradeChooseMove(question.fen, san, question.accept);
  return {
    kind: "choose_move",
    correct,
    explanation: question.explain,
  };
}

/** "Grade" a free_text answer — i.e. reveal the model answer + rubric. There is
 *  no auto-grade in the MVP, so `correct` is `null` (self-graded). */
export function revealFreeText(question: FreeTextQuestion): FreeTextResult {
  return {
    kind: "free_text",
    correct: null,
    modelAnswer: question.modelAnswer,
    rubric: question.rubric,
  };
}

/** The user's raw answer to a question, by kind:
 *  - multiple_choice → the chosen option index
 *  - choose_move → the SAN of the move played
 *  - free_text → no answer is graded (reveal only); pass `undefined`. */
export type QuestionAnswer = number | string | null | undefined;

/**
 * Dispatch grading over the `Question` union. The `answer` is interpreted per
 * kind (index for multiple_choice, SAN for choose_move, ignored for free_text).
 * A type-mismatched answer simply grades as incorrect (never throws).
 */
export function gradeQuestion(
  question: Question,
  answer: QuestionAnswer,
): GradeResult {
  switch (question.kind) {
    case "multiple_choice":
      return gradeMultipleChoice(
        question,
        typeof answer === "number" ? answer : null,
      );
    case "choose_move":
      return gradeChooseMoveQuestion(
        question,
        typeof answer === "string" ? answer : null,
      );
    case "free_text":
      return revealFreeText(question);
  }
}

// ── Per-module scorer ───────────────────────────────────────────────────────

/**
 * One question's outcome inside a scored module. `result` is always present.
 *
 * `countsTowardScore` is true only for the auto-gradable kinds
 * (multiple_choice, choose_move). free_text is self-graded, so it is EXCLUDED
 * from the automatic `score`/`total` — it is never silently counted wrong — and
 * carries its own `selfGrade` (or `null` until the user grades it).
 */
export interface PerQuestionOutcome {
  index: number;
  kind: Question["kind"];
  result: GradeResult;
  /** Whether the user supplied an answer of the right shape for this kind. */
  answered: boolean;
  /** Auto-gradable (MC / choose_move) → true; free_text → false. */
  countsTowardScore: boolean;
  /** free_text only: the user's self-grade, or null if not yet graded. */
  selfGrade: SelfGrade | null;
}

/** The result of scoring a module. `score`/`total` cover ONLY the auto-gradable
 *  questions; free_text is reported per-question but excluded from the tally. */
export interface ModuleScore {
  score: number;
  total: number;
  outcomes: PerQuestionOutcome[];
}

/** A tagged answer to one module question, parallel to `module.questions`.
 *  `null` means the question was left unanswered. */
export type ModuleAnswer =
  | { kind: "multiple_choice"; choice: number }
  | { kind: "choose_move"; san: string }
  | { kind: "free_text"; selfGrade?: SelfGrade | null }
  | null;

/**
 * Score a module: grade each question, tally the auto-gradable ones, and carry
 * every question's outcome (regardless of kind) in `outcomes`.
 *
 * `answers[i]` is the answer to `module.questions[i]`; a shorter/omitted array
 * or a `null` entry is treated as unanswered. An answer whose `kind` does not
 * match the question's kind is ignored (treated as unanswered) rather than
 * throwing, so a caller can never corrupt the tally with a mismatched payload.
 *
 * Free-text policy (documented, deliberate): free_text is self-graded, so it is
 * NOT counted toward `score`/`total`. Its outcome carries `correct: null` and
 * the user's `selfGrade` (or null). This is why a module with a free_text
 * question can still score a perfect `score === total` — the prose question is
 * simply not part of the automatic denominator.
 */
export function scoreModule(
  module: Module,
  answers: readonly (ModuleAnswer | undefined)[] = [],
): ModuleScore {
  const outcomes: PerQuestionOutcome[] = module.questions.map(
    (question, index) => {
      const raw = answers[index] ?? null;

      switch (question.kind) {
        case "multiple_choice": {
          const answered = raw?.kind === "multiple_choice";
          const choice = answered ? raw.choice : null;
          return {
            index,
            kind: "multiple_choice",
            result: gradeMultipleChoice(question, choice),
            answered,
            countsTowardScore: true,
            selfGrade: null,
          };
        }
        case "choose_move": {
          const answered = raw?.kind === "choose_move";
          const san = answered ? raw.san : null;
          return {
            index,
            kind: "choose_move",
            result: gradeChooseMoveQuestion(question, san),
            answered,
            countsTowardScore: true,
            selfGrade: null,
          };
        }
        case "free_text": {
          const answered = raw?.kind === "free_text";
          const selfGrade = answered ? (raw.selfGrade ?? null) : null;
          return {
            index,
            kind: "free_text",
            result: revealFreeText(question),
            answered,
            countsTowardScore: false,
            selfGrade,
          };
        }
      }
    },
  );

  const gradable = outcomes.filter((o) => o.countsTowardScore);
  const score = gradable.filter((o) => o.result.correct === true).length;
  const total = gradable.length;

  return { score, total, outcomes };
}

import { describe, it, expect } from "vitest";
import { loadCourse, type Module } from "@chessgui/core/lessons";
import {
  gradeMultipleChoice,
  gradeChooseMoveQuestion,
  revealFreeText,
  gradeQuestion,
  scoreModule,
  type ModuleAnswer,
} from "@chessgui/core/lesson-grade";
import fixture from "@chessgui/core/lessons/fixture-course.json";

const module: Module = loadCourse(fixture).modules[0];
const mc = module.questions.find((q) => q.kind === "multiple_choice")!;
const cm = module.questions.find((q) => q.kind === "choose_move")!;
const ft = module.questions.find((q) => q.kind === "free_text")!;

describe("gradeMultipleChoice — index match", () => {
  it("correct when the chosen index matches", () => {
    if (mc.kind !== "multiple_choice") throw new Error("fixture shape");
    const r = gradeMultipleChoice(mc, mc.correct);
    expect(r.kind).toBe("multiple_choice");
    expect(r.correct).toBe(true);
    expect(r.explanation).toBe(mc.explain);
  });

  it("incorrect on a wrong index", () => {
    if (mc.kind !== "multiple_choice") throw new Error("fixture shape");
    const wrong = mc.correct === 0 ? 1 : 0;
    expect(gradeMultipleChoice(mc, wrong).correct).toBe(false);
  });

  it("incorrect on a missing / null choice", () => {
    if (mc.kind !== "multiple_choice") throw new Error("fixture shape");
    expect(gradeMultipleChoice(mc, null).correct).toBe(false);
    expect(gradeMultipleChoice(mc, undefined).correct).toBe(false);
  });
});

describe("gradeChooseMoveQuestion — SAN membership (reuses D1)", () => {
  it("accepts a SAN in the accept set", () => {
    if (cm.kind !== "choose_move") throw new Error("fixture shape");
    const r = gradeChooseMoveQuestion(cm, cm.accept[0]);
    expect(r.kind).toBe("choose_move");
    expect(r.correct).toBe(true);
    expect(r.explanation).toBe(cm.explain);
  });

  it("rejects a legal move not in the accept set", () => {
    if (cm.kind !== "choose_move") throw new Error("fixture shape");
    // In the fixture position (Ruy Lopez after ...a6) Bc4 is legal but not accepted.
    expect(gradeChooseMoveQuestion(cm, "Bc4").correct).toBe(false);
  });

  it("rejects a missing / illegal played move", () => {
    if (cm.kind !== "choose_move") throw new Error("fixture shape");
    expect(gradeChooseMoveQuestion(cm, null).correct).toBe(false);
    expect(gradeChooseMoveQuestion(cm, "not-a-move").correct).toBe(false);
  });
});

describe("revealFreeText — reveal, no auto-grade (MVP)", () => {
  it("returns correct:null with the model answer + rubric", () => {
    if (ft.kind !== "free_text") throw new Error("fixture shape");
    const r = revealFreeText(ft);
    expect(r.kind).toBe("free_text");
    expect(r.correct).toBeNull();
    expect(r.modelAnswer).toBe(ft.modelAnswer);
    expect(r.rubric).toEqual(ft.rubric);
  });
});

describe("gradeQuestion — dispatcher over the Question union", () => {
  it("dispatches each kind and tolerates a mismatched answer type", () => {
    if (mc.kind !== "multiple_choice") throw new Error("fixture shape");
    if (cm.kind !== "choose_move") throw new Error("fixture shape");

    expect(gradeQuestion(mc, mc.correct)).toMatchObject({
      kind: "multiple_choice",
      correct: true,
    });
    expect(gradeQuestion(cm, cm.accept[0])).toMatchObject({
      kind: "choose_move",
      correct: true,
    });
    // free_text ignores the answer and always reveals.
    expect(gradeQuestion(ft, "anything")).toMatchObject({
      kind: "free_text",
      correct: null,
    });
    // A string answer to a multiple_choice → treated as unanswered, not a throw.
    expect(gradeQuestion(mc, "0")).toMatchObject({ correct: false });
    // A number answer to a choose_move → treated as unanswered.
    expect(gradeQuestion(cm, 0 as unknown as string)).toMatchObject({
      correct: false,
    });
  });
});

describe("scoreModule — mixed module including free_text", () => {
  it("all auto-gradable correct → score === total, free_text excluded", () => {
    if (mc.kind !== "multiple_choice") throw new Error("fixture shape");
    if (cm.kind !== "choose_move") throw new Error("fixture shape");

    // Build answers parallel to module.questions, keyed by kind.
    const answers: ModuleAnswer[] = module.questions.map((q) => {
      switch (q.kind) {
        case "multiple_choice":
          return { kind: "multiple_choice", choice: q.correct };
        case "choose_move":
          return { kind: "choose_move", san: q.accept[0] };
        case "free_text":
          return { kind: "free_text", selfGrade: "got_it" };
      }
    });

    const result = scoreModule(module, answers);
    // The module has one MC + one choose_move that are auto-gradable → total 2.
    expect(result.total).toBe(2);
    expect(result.score).toBe(2);
    // Every question carries an outcome, regardless of kind.
    expect(result.outcomes).toHaveLength(module.questions.length);

    const ftOutcome = result.outcomes.find((o) => o.kind === "free_text")!;
    // The free_text question is NEVER counted wrong: excluded from the tally.
    expect(ftOutcome.countsTowardScore).toBe(false);
    expect(ftOutcome.result.correct).toBeNull();
    expect(ftOutcome.selfGrade).toBe("got_it");
  });

  it("a wrong free_text self-grade does NOT lower the score", () => {
    const answers: ModuleAnswer[] = module.questions.map((q) => {
      switch (q.kind) {
        case "multiple_choice":
          return { kind: "multiple_choice", choice: q.correct };
        case "choose_move":
          return { kind: "choose_move", san: q.accept[0] };
        case "free_text":
          return { kind: "free_text", selfGrade: "missed" };
      }
    });
    const result = scoreModule(module, answers);
    // Missed free_text, yet the auto tally is still perfect.
    expect(result.score).toBe(result.total);
    expect(result.total).toBe(2);
  });

  it("unanswered auto-gradable questions count as wrong; free_text stays null", () => {
    const result = scoreModule(module, []); // nothing answered
    expect(result.total).toBe(2);
    expect(result.score).toBe(0);
    const ftOutcome = result.outcomes.find((o) => o.kind === "free_text")!;
    expect(ftOutcome.answered).toBe(false);
    expect(ftOutcome.selfGrade).toBeNull();
    expect(ftOutcome.result.correct).toBeNull();
    // The auto-gradable ones are answered:false but graded false.
    const mcOutcome = result.outcomes.find((o) => o.kind === "multiple_choice")!;
    expect(mcOutcome.answered).toBe(false);
    expect(mcOutcome.result.correct).toBe(false);
  });

  it("a mismatched answer payload is ignored, not counted", () => {
    // Give the choose_move slot a multiple_choice answer — treated unanswered.
    const answers: ModuleAnswer[] = module.questions.map((q) =>
      q.kind === "choose_move"
        ? { kind: "multiple_choice", choice: 0 }
        : q.kind === "multiple_choice"
          ? { kind: "multiple_choice", choice: q.correct }
          : { kind: "free_text", selfGrade: null },
    );
    const result = scoreModule(module, answers);
    const cmOutcome = result.outcomes.find((o) => o.kind === "choose_move")!;
    expect(cmOutcome.answered).toBe(false);
    expect(cmOutcome.result.correct).toBe(false);
    // MC still correct → score 1 of 2.
    expect(result.score).toBe(1);
    expect(result.total).toBe(2);
  });
});

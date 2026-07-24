// Concept Lessons — the module-player reducer (specs/227, D3, the automatable gate).
//
// The React component is a thin shell over `lessonPlayerReducer`, so the whole
// player logic is asserted here with no DOM: the three-beat progression, the
// interleaved predict-the-move pause/grade (correct advances; wrong surfaces the
// bespoke explanation then advances), the question-by-question practice cursor,
// and the final scorecard.

import { describe, it, expect } from "vitest";
import { loadCourse, type Module } from "@chessgui/core/lessons";
import {
  initLessonPlayer,
  lessonPlayerReducer,
  buildIllustrationLine,
  boardFen,
  currentFocusNote,
  currentQuestion,
  moduleScore,
  type LessonPlayerState,
  type LessonAction,
} from "@chessgui/core/lesson-player";
import fixture from "@chessgui/core/lessons/fixture-course.json";

const MODULE: Module = loadCourse(fixture).modules[0];

function reduce(state: LessonPlayerState, ...actions: LessonAction[]): LessonPlayerState {
  return actions.reduce(lessonPlayerReducer, state);
}

// The fixture illustration: 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7 (10 plies),
// interleave:true, an `ask` focus at ply 6 (predict White's reply 4.Ba4 = ply 7),
// and a plain focus note at ply 9.
const ASK_PLY = 6;

describe("buildIllustrationLine — flattens the PGN mainline", () => {
  const line = buildIllustrationLine(MODULE.illustrations[0]);
  it("has one FEN/SAN per ply up to maxPly", () => {
    expect(line.maxPly).toBe(10);
    expect(line.sans[1]).toBe("e4");
    expect(line.sans[ASK_PLY]).toBe("a6");
    expect(line.sans[ASK_PLY + 1]).toBe("Ba4");
    expect(line.fens[ASK_PLY]).toMatch(/ w /); // White to move after ...a6
  });
  it("carries the ask focus note keyed by ply", () => {
    expect(line.focus[ASK_PLY].ask?.accept).toContain("Ba4");
    expect(line.focus[9].ask).toBeUndefined();
    expect(line.interleave).toBe(true);
  });
});

describe("beat progression", () => {
  it("starts on the principle beat, then START enters illustrate", () => {
    const s0 = initLessonPlayer(MODULE);
    expect(s0.beat).toBe("principle");
    const s1 = lessonPlayerReducer(s0, { type: "START" });
    expect(s1.beat).toBe("illustrate");
    expect(s1.ply).toBe(0);
    expect(boardFen(s1)).toBe(line0Fen(0));
  });

  it("GO_TO_PRACTICE skips illustrations into the practice beat", () => {
    const s = reduce(initLessonPlayer(MODULE), { type: "START" }, { type: "GO_TO_PRACTICE" });
    expect(s.beat).toBe("practice");
    expect(currentQuestion(s)?.kind).toBe("multiple_choice");
  });
});

describe("interleave — pause at the ask ply", () => {
  it("stepping onto the ask focus ply pauses and awaits a move", () => {
    let s = reduce(initLessonPlayer(MODULE), { type: "START" });
    // Step to ply 6 (the ask focus).
    for (let i = 0; i < ASK_PLY; i++) s = lessonPlayerReducer(s, { type: "ILLUSTRATE_NEXT" });
    expect(s.ply).toBe(ASK_PLY);
    expect(s.awaiting).toBe(true);
    expect(s.askPly).toBe(ASK_PLY);
    // The focus note (with the ask prompt) is what shows beside the board.
    expect(currentFocusNote(s)?.ask?.prompt).toBeTruthy();
    // ILLUSTRATE_NEXT is inert while awaiting a prediction.
    const blocked = lessonPlayerReducer(s, { type: "ILLUSTRATE_NEXT" });
    expect(blocked).toBe(s);
  });

  it("a correct predicted move advances and continues the game", () => {
    let s = reduce(initLessonPlayer(MODULE), { type: "START" });
    for (let i = 0; i < ASK_PLY; i++) s = lessonPlayerReducer(s, { type: "ILLUSTRATE_NEXT" });
    s = lessonPlayerReducer(s, { type: "PLAY_PREDICTION", san: "Ba4" });
    expect(s.awaiting).toBe(false);
    expect(s.askPly).toBe(null);
    expect(s.ply).toBe(ASK_PLY + 1); // revealed the model move (4.Ba4)
    expect(s.feedback?.correct).toBe(true);
  });

  it("a wrong predicted move surfaces the bespoke explanation, then advances", () => {
    let s = reduce(initLessonPlayer(MODULE), { type: "START" });
    for (let i = 0; i < ASK_PLY; i++) s = lessonPlayerReducer(s, { type: "ILLUSTRATE_NEXT" });
    const ask = MODULE.illustrations[0].focus.find((f) => f.ply === ASK_PLY)!.ask!;
    s = lessonPlayerReducer(s, { type: "PLAY_PREDICTION", san: "h3" }); // legal but not accepted
    expect(s.feedback?.correct).toBe(false);
    expect(s.feedback?.text).toBe(ask.explain); // the SPECIFIC mistake, not just "wrong"
    expect(s.ply).toBe(ASK_PLY + 1); // still continues after showing the explanation
    // …and the game keeps going from there.
    const after = lessonPlayerReducer(s, { type: "ILLUSTRATE_NEXT" });
    expect(after.ply).toBe(ASK_PLY + 2);
  });

  it("stepping past the last ply moves to the practice beat", () => {
    let s = reduce(initLessonPlayer(MODULE), { type: "START" });
    // Walk to the ask, answer it, then walk to the end.
    for (let i = 0; i < ASK_PLY; i++) s = lessonPlayerReducer(s, { type: "ILLUSTRATE_NEXT" });
    s = lessonPlayerReducer(s, { type: "PLAY_PREDICTION", san: "Ba4" });
    let guard = 0;
    while (s.beat === "illustrate" && guard++ < 50) {
      s = lessonPlayerReducer(s, { type: "ILLUSTRATE_NEXT" });
    }
    expect(s.beat).toBe("practice");
    expect(s.qIndex).toBe(0);
  });
});

describe("practice — question-by-question progression", () => {
  function atPractice(): LessonPlayerState {
    return reduce(initLessonPlayer(MODULE), { type: "START" }, { type: "GO_TO_PRACTICE" });
  }

  it("Q1 multiple_choice: reveals the result and records the answer", () => {
    let s = atPractice();
    const mc = MODULE.questions[0];
    if (mc.kind !== "multiple_choice") throw new Error("fixture shape");
    s = lessonPlayerReducer(s, { type: "ANSWER", answer: mc.correct });
    expect(s.revealed?.kind).toBe("multiple_choice");
    expect(s.revealed?.correct).toBe(true);
    s = lessonPlayerReducer(s, { type: "NEXT_QUESTION" });
    expect(s.qIndex).toBe(1);
    expect(s.revealed).toBe(null);
    expect(currentQuestion(s)?.kind).toBe("choose_move");
  });

  it("Q2 choose_move: grades a played SAN through the shared grader", () => {
    let s = atPractice();
    s = reduce(s, { type: "ANSWER", answer: 0 }, { type: "NEXT_QUESTION" });
    expect(currentQuestion(s)?.kind).toBe("choose_move");
    s = lessonPlayerReducer(s, { type: "ANSWER", answer: "Ba4" });
    expect(s.revealed?.correct).toBe(true);
    const wrong = lessonPlayerReducer(atPractice(), { type: "ANSWER", answer: 0 });
    // (sanity: a wrong MC index grades false)
    expect(wrong.revealed?.correct).toBe(MODULE.questions[0].kind === "multiple_choice" && (MODULE.questions[0] as any).correct === 0);
  });

  it("Q3 free_text: reveal has no verdict, self-grade is recorded", () => {
    let s = atPractice();
    s = reduce(
      s,
      { type: "ANSWER", answer: 0 },
      { type: "NEXT_QUESTION" },
      { type: "ANSWER", answer: "Ba4" },
      { type: "NEXT_QUESTION" },
    );
    expect(currentQuestion(s)?.kind).toBe("free_text");
    s = lessonPlayerReducer(s, { type: "ANSWER", answer: undefined }); // reveal
    expect(s.revealed?.kind).toBe("free_text");
    expect(s.revealed?.correct).toBe(null); // self-graded, no auto verdict
    s = lessonPlayerReducer(s, { type: "SELF_GRADE", grade: "got_it" });
    const ft = s.answers[2];
    expect(ft && ft.kind === "free_text" ? ft.selfGrade : null).toBe("got_it");
  });

  it("NEXT_QUESTION past the last question ends the module", () => {
    let s = atPractice();
    s = reduce(
      s,
      { type: "ANSWER", answer: 0 },
      { type: "NEXT_QUESTION" },
      { type: "ANSWER", answer: "Ba4" },
      { type: "NEXT_QUESTION" },
      { type: "ANSWER", answer: undefined },
      { type: "NEXT_QUESTION" },
    );
    expect(s.beat).toBe("done");
  });
});

describe("scorecard — derived from collected answers", () => {
  it("counts the two auto-gradable questions; free_text is excluded", () => {
    let s = reduce(initLessonPlayer(MODULE), { type: "START" }, { type: "GO_TO_PRACTICE" });
    const mc = MODULE.questions[0];
    if (mc.kind !== "multiple_choice") throw new Error("fixture shape");
    s = reduce(
      s,
      { type: "ANSWER", answer: mc.correct }, // MC correct
      { type: "NEXT_QUESTION" },
      { type: "ANSWER", answer: "Ba4" }, // choose_move correct
      { type: "NEXT_QUESTION" },
      { type: "ANSWER", answer: undefined }, // free_text reveal
      { type: "SELF_GRADE", grade: "partial" },
      { type: "NEXT_QUESTION" },
    );
    expect(s.beat).toBe("done");
    const score = moduleScore(s);
    expect(score.total).toBe(2); // free_text not in the denominator
    expect(score.score).toBe(2);
    const ft = score.outcomes.find((o) => o.kind === "free_text");
    expect(ft?.selfGrade).toBe("partial");
    expect(ft?.countsTowardScore).toBe(false);
  });

  it("a wrong MC lowers the score", () => {
    let s = reduce(initLessonPlayer(MODULE), { type: "START" }, { type: "GO_TO_PRACTICE" });
    const mc = MODULE.questions[0];
    if (mc.kind !== "multiple_choice") throw new Error("fixture shape");
    const wrongIdx = mc.correct === 0 ? 1 : 0;
    s = reduce(
      s,
      { type: "ANSWER", answer: wrongIdx },
      { type: "NEXT_QUESTION" },
      { type: "ANSWER", answer: "e4" }, // illegal-in-position → graded false
      { type: "NEXT_QUESTION" },
      { type: "ANSWER", answer: undefined },
      { type: "NEXT_QUESTION" },
    );
    const score = moduleScore(s);
    expect(score.total).toBe(2);
    expect(score.score).toBe(0);
  });
});

// Helper: the start-position FEN of the fixture illustration (ply 0).
function line0Fen(ply: number): string {
  return buildIllustrationLine(MODULE.illustrations[0]).fens[ply];
}

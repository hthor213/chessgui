import { describe, it, expect } from "vitest";
import {
  emptyProgress,
  serializeLessonProgress,
  parseLessonProgress,
  appendProgress,
  resumePoint,
  LessonProgressError,
  LESSON_PROGRESS_VERSION,
  type LessonProgressEntry,
  type LessonProgressStore,
} from "@chessgui/core/lesson-progress";

function entry(
  over: Partial<LessonProgressEntry> & { at: string; courseId: string },
): LessonProgressEntry {
  return {
    moduleId: "m1",
    moduleIndex: 0,
    questionIndex: 0,
    completed: false,
    score: 0,
    total: 0,
    questionScores: [],
    freeTextSelfGrades: [],
    ...over,
  };
}

describe("parseLessonProgress — empty / fresh", () => {
  it("null / undefined / empty string → a fresh empty log", () => {
    for (const raw of [null, undefined, ""]) {
      const store = parseLessonProgress(raw);
      expect(store.version).toBe(LESSON_PROGRESS_VERSION);
      expect(store.entries).toEqual([]);
    }
  });

  it("throws on malformed JSON and on a wrong shape", () => {
    expect(() => parseLessonProgress("{not json")).toThrow(LessonProgressError);
    expect(() => parseLessonProgress('{"version":"x","entries":[]}')).toThrow(
      /version/,
    );
    expect(() => parseLessonProgress('{"version":1,"entries":{}}')).toThrow(
      /entries/,
    );
    expect(() =>
      parseLessonProgress('{"version":1,"entries":[{"courseId":"c"}]}'),
    ).toThrow(LessonProgressError);
  });
});

describe("serialize → parse round-trip identity", () => {
  it("recovers an identical store", () => {
    const store: LessonProgressStore = {
      version: LESSON_PROGRESS_VERSION,
      entries: [
        entry({
          at: "2026-07-24T10:00:00.000Z",
          courseId: "closed-positions",
          moduleId: "m1",
          moduleIndex: 0,
          questionIndex: 2,
          completed: true,
          score: 2,
          total: 2,
          questionScores: [true, false, null],
          freeTextSelfGrades: [null, null, "partial"],
        }),
        entry({
          at: "2026-07-24T10:30:00.000Z",
          courseId: "closed-positions",
          moduleId: "m2",
          moduleIndex: 1,
          questionIndex: 1,
        }),
      ],
    };
    const round = parseLessonProgress(serializeLessonProgress(store));
    expect(round).toEqual(store);
  });
});

describe("appendProgress — append-only", () => {
  it("appends with an injected ISO timestamp and never mutates the input", () => {
    const s0 = emptyProgress();
    const e1 = entry({ at: "2026-07-24T09:00:00.000Z", courseId: "c" });
    const s1 = appendProgress(s0, e1);

    // Original store untouched (append-only, immutable transition).
    expect(s0.entries).toHaveLength(0);
    expect(s1.entries).toHaveLength(1);
    expect(s1.entries[0].at).toBe("2026-07-24T09:00:00.000Z");
    expect(s1).not.toBe(s0);
  });

  it("old entries SURVIVE a new append (none dropped, none mutated)", () => {
    let store = emptyProgress();
    const stamps = [
      "2026-07-24T09:00:00.000Z",
      "2026-07-24T09:05:00.000Z",
      "2026-07-24T09:10:00.000Z",
    ];
    stamps.forEach((at, i) => {
      store = appendProgress(
        store,
        entry({ at, courseId: "c", moduleId: `m${i}`, moduleIndex: i }),
      );
    });
    expect(store.entries.map((e) => e.at)).toEqual(stamps);
    // The first entry is intact after two later appends.
    expect(store.entries[0].moduleId).toBe("m0");
    expect(store.entries[0].at).toBe(stamps[0]);
  });
});

describe("resumePoint — where I left off", () => {
  it("returns the most recent entry's module/question for the course", () => {
    let store = emptyProgress();
    store = appendProgress(
      store,
      entry({
        at: "2026-07-24T09:00:00.000Z",
        courseId: "closed-positions",
        moduleId: "m1",
        moduleIndex: 0,
        questionIndex: 4,
        completed: true,
      }),
    );
    store = appendProgress(
      store,
      entry({
        at: "2026-07-24T09:20:00.000Z",
        courseId: "closed-positions",
        moduleId: "m2",
        moduleIndex: 1,
        questionIndex: 3,
        completed: false,
      }),
    );

    const rp = resumePoint(store, "closed-positions");
    expect(rp).not.toBeNull();
    // Left off at module index 1, question 3 — the latest entry.
    expect(rp!.moduleIndex).toBe(1);
    expect(rp!.moduleId).toBe("m2");
    expect(rp!.questionIndex).toBe(3);
    expect(rp!.completed).toBe(false);
  });

  it("ignores other courses and returns null when the course is absent", () => {
    let store = emptyProgress();
    store = appendProgress(
      store,
      entry({ at: "2026-07-24T09:00:00.000Z", courseId: "other", moduleIndex: 5 }),
    );
    expect(resumePoint(store, "closed-positions")).toBeNull();
    expect(resumePoint(store, "other")!.moduleIndex).toBe(5);
  });

  it("revisiting an earlier module later moves the resume point back to it", () => {
    let store = emptyProgress();
    store = appendProgress(
      store,
      entry({
        at: "2026-07-24T09:00:00.000Z",
        courseId: "c",
        moduleId: "m3",
        moduleIndex: 2,
        questionIndex: 2,
      }),
    );
    // Later, the user goes back to module 1.
    store = appendProgress(
      store,
      entry({
        at: "2026-07-24T11:00:00.000Z",
        courseId: "c",
        moduleId: "m1",
        moduleIndex: 0,
        questionIndex: 1,
      }),
    );
    const rp = resumePoint(store, "c");
    expect(rp!.moduleIndex).toBe(0);
    expect(rp!.questionIndex).toBe(1);
  });
});

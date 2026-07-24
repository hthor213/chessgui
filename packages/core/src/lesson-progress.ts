// Concept Lessons — the local progress store (specs/227, D2).
//
// The append-only, dated `lesson_progress.json` log: per-module completion,
// per-question score, and the self-grade for free_text answers. THIS file owns
// the document shape + its transitions as pure functions; the actual filesystem
// read/append is a D3 shell concern (mirroring active-game.ts / training-
// record.ts — core owns the shape, the shell owns I/O through a provider seam).
//
// Pure TS: no React, no I/O, NO ambient time. Every timestamp is injected as an
// ISO string, so round-trip and resume tests are deterministic.
//
// Append-only invariant: `appendProgress` never mutates or drops a prior entry.
// The log is the history; "resume where I left off" is DERIVED from it, never
// stored as mutable state.

import type { SelfGrade } from "./lesson-grade";

/** The on-disk store version. Bump only on a breaking shape change. */
export const LESSON_PROGRESS_VERSION = 1;

/**
 * One append-only record of a module attempt.
 *
 * `questionScores[i]` is the auto-grade of question i: `true`/`false` for the
 * auto-gradable kinds, `null` for free_text (self-graded, no auto-grade).
 * `freeTextSelfGrades[i]` carries the user's self-grade for a free_text
 * question, or `null` for every non-free_text index / an ungraded one.
 */
export interface LessonProgressEntry {
  /** ISO-8601 timestamp, INJECTED by the caller (never `Date.now()` here). */
  at: string;
  courseId: string;
  moduleId: string;
  /** The module's index within its course (used for resume ordering). */
  moduleIndex: number;
  /** The last question index reached within the module. */
  questionIndex: number;
  /** True when the user finished the module's practice beat. */
  completed: boolean;
  /** Auto-graded correct count (excludes free_text). */
  score: number;
  /** Auto-gradable question count (excludes free_text). */
  total: number;
  /** Per-question auto-grade, parallel to the module's questions. */
  questionScores: (boolean | null)[];
  /** Per-question free_text self-grade, parallel to the module's questions. */
  freeTextSelfGrades: (SelfGrade | null)[];
}

/** The whole append-only log. */
export interface LessonProgressStore {
  version: number;
  entries: LessonProgressEntry[];
}

/** Thrown by `parseLessonProgress` on malformed (non-null) input. */
export class LessonProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LessonProgressError";
  }
}

/** A fresh, empty log at the current version. */
export function emptyProgress(): LessonProgressStore {
  return { version: LESSON_PROGRESS_VERSION, entries: [] };
}

// ── Serialize / parse ───────────────────────────────────────────────────────

/** Serialize the log to pretty JSON (the `lesson_progress.json` payload). */
export function serializeLessonProgress(store: LessonProgressStore): string {
  return JSON.stringify(store, null, 2);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const SELF_GRADES: readonly SelfGrade[] = ["got_it", "partial", "missed"];

function parseEntry(v: unknown, i: number): LessonProgressEntry {
  if (!isObject(v)) {
    throw new LessonProgressError(`entries[${i}]: expected an object`);
  }
  const str = (key: string): string => {
    if (typeof v[key] !== "string") {
      throw new LessonProgressError(`entries[${i}].${key}: expected a string`);
    }
    return v[key] as string;
  };
  const int = (key: string): number => {
    if (typeof v[key] !== "number" || !Number.isInteger(v[key])) {
      throw new LessonProgressError(`entries[${i}].${key}: expected an integer`);
    }
    return v[key] as number;
  };
  const bool = (key: string): boolean => {
    if (typeof v[key] !== "boolean") {
      throw new LessonProgressError(`entries[${i}].${key}: expected a boolean`);
    }
    return v[key] as boolean;
  };
  const scores = (key: string): (boolean | null)[] => {
    if (!Array.isArray(v[key])) {
      throw new LessonProgressError(`entries[${i}].${key}: expected an array`);
    }
    return (v[key] as unknown[]).map((s, j) => {
      if (s === null || typeof s === "boolean") return s as boolean | null;
      throw new LessonProgressError(
        `entries[${i}].${key}[${j}]: expected a boolean or null`,
      );
    });
  };
  const grades = (key: string): (SelfGrade | null)[] => {
    if (!Array.isArray(v[key])) {
      throw new LessonProgressError(`entries[${i}].${key}: expected an array`);
    }
    return (v[key] as unknown[]).map((s, j) => {
      if (s === null) return null;
      if (typeof s === "string" && (SELF_GRADES as string[]).includes(s)) {
        return s as SelfGrade;
      }
      throw new LessonProgressError(
        `entries[${i}].${key}[${j}]: expected a self-grade or null`,
      );
    });
  };
  return {
    at: str("at"),
    courseId: str("courseId"),
    moduleId: str("moduleId"),
    moduleIndex: int("moduleIndex"),
    questionIndex: int("questionIndex"),
    completed: bool("completed"),
    score: int("score"),
    total: int("total"),
    questionScores: scores("questionScores"),
    freeTextSelfGrades: grades("freeTextSelfGrades"),
  };
}

/**
 * Parse a log from JSON (the raw `lesson_progress.json` string) or a
 * pre-parsed object. A `null`/`undefined`/empty input yields a fresh empty log
 * (a first run has no file yet). Malformed non-null input throws
 * `LessonProgressError` — never a silent half-parse.
 */
export function parseLessonProgress(
  raw: string | null | undefined | unknown,
): LessonProgressStore {
  if (raw === null || raw === undefined || raw === "") return emptyProgress();

  let root: unknown = raw;
  if (typeof raw === "string") {
    try {
      root = JSON.parse(raw);
    } catch (e) {
      throw new LessonProgressError(`not valid JSON — ${(e as Error).message}`);
    }
  }
  if (!isObject(root)) {
    throw new LessonProgressError("expected a store object");
  }
  if (typeof root.version !== "number" || !Number.isInteger(root.version)) {
    throw new LessonProgressError("version: expected an integer");
  }
  if (!Array.isArray(root.entries)) {
    throw new LessonProgressError("entries: expected an array");
  }
  return {
    version: root.version,
    entries: root.entries.map((e, i) => parseEntry(e, i)),
  };
}

// ── Append (append-only) ────────────────────────────────────────────────────

/**
 * Return a NEW store with `entry` appended. Never mutates the input store and
 * never drops a prior entry — the log is the full history. The caller injects
 * `entry.at` (an ISO timestamp), so this is a pure, deterministic transition.
 */
export function appendProgress(
  store: LessonProgressStore,
  entry: LessonProgressEntry,
): LessonProgressStore {
  return {
    version: store.version,
    entries: [...store.entries, entry],
  };
}

// ── Resume ("where I left off") ─────────────────────────────────────────────

/** The recovered "resume here" position for a course. */
export interface ResumePoint {
  courseId: string;
  moduleId: string;
  moduleIndex: number;
  questionIndex: number;
  completed: boolean;
}

/**
 * Derive "resume where I left off" for a course: the MOST RECENT entry for
 * `courseId` (last in append order — the log is dated and append-only, so the
 * last matching entry is the latest activity). Returns `null` if the course has
 * no entries yet.
 *
 * This is derived, never stored: the append-only log is the single source of
 * truth, and revisiting an earlier module later correctly moves the resume
 * point back to it.
 */
export function resumePoint(
  store: LessonProgressStore,
  courseId: string,
): ResumePoint | null {
  for (let i = store.entries.length - 1; i >= 0; i--) {
    const e = store.entries[i];
    if (e.courseId === courseId) {
      return {
        courseId: e.courseId,
        moduleId: e.moduleId,
        moduleIndex: e.moduleIndex,
        questionIndex: e.questionIndex,
        completed: e.completed,
      };
    }
  }
  return null;
}

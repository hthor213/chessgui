// Concept Lessons — schema + loader + choose_move grader (specs/227, D1).
//
// The three-beat unit ("principle → illustrate → practice") as a pure,
// data-driven model. Courses/modules ship as bundled JSON; THIS file is the
// contract (the schema), so new courses are added as data with no code change.
//
// Fair-play note (spec 227): a lesson is generic study on canonical master
// games and composed positions — never the live game. Engine eval and answer
// grading are allowed here because the study position is public knowledge.
//
// Pure TS: no React, no I/O. The loader validates and THROWS on a bad course
// (never a silent half-load); the grader mirrors the tree's SAN path so
// disambiguation / check / promotion / Chess960 castling all normalize.

import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { padFen } from "./fen";

// ── Data model (matches the spec's "Data model" block exactly) ──────────────

/** A course is an ordered list of modules; `modules` carries full Modules
 *  inline (the spec's `ModuleRef[]` — a module is embedded, not referenced). */
export interface Course {
  id: string;
  title: string;
  blurb: string;
  level: string;
  modules: Module[];
}

/** The "principle" beat: state the idea, the one sentence to remember, and an
 *  optional single diagram. */
export interface Principle {
  markdown: string;
  /** the one sentence to remember */
  remember: string;
  diagramFen?: string;
}

export interface Module {
  id: string;
  title: string;
  principle: Principle;
  illustrations: Illustration[];
  questions: Question[];
}

/** An interleaved "predict-the-move" training question pinned to a focus ply.
 *  `explain` MUST name the specific mistake, not just reveal the move. */
export interface FocusAsk {
  prompt: string;
  /** accepted answers as SAN */
  accept: string[];
  explain: string;
}

/** A comment pinned to a ply of an illustration. With `interleave` on the
 *  illustration, a note carrying an `ask` pauses the board and quizzes. */
export interface FocusNote {
  ply: number;
  text: string;
  ask?: FocusAsk;
}

export interface Illustration {
  title: string;
  pgn: string;
  /** REQUIRED — public-domain classic or clearly-licensed, cited (clean-room). */
  source: string;
  startPly?: number;
  interleave?: boolean;
  focus: FocusNote[];
}

/** MCQ over an optional board position. `explain` names the mistake. */
export interface MultipleChoiceQuestion {
  kind: "multiple_choice";
  fen?: string;
  prompt: string;
  options: string[];
  correct: number;
  explain: string;
}

/** "Find the move" — the user plays a move, graded against accepted SAN. */
export interface ChooseMoveQuestion {
  kind: "choose_move";
  fen: string;
  prompt: string;
  /** accepted answers as SAN */
  accept: string[];
  explain: string;
}

/** Prose plan; a model answer + rubric are revealed for self-grading (MVP). */
export interface FreeTextQuestion {
  kind: "free_text";
  fen?: string;
  prompt: string;
  modelAnswer: string;
  rubric: string[];
}

export type Question =
  | MultipleChoiceQuestion
  | ChooseMoveQuestion
  | FreeTextQuestion;

// ── Loader / validator (hand-rolled, matches fen.ts style; throws on bad) ────

/** Thrown by `loadCourse` on any schema or content-bar violation. The message
 *  carries a dotted path to the offending field so failures are debuggable. */
export class CourseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CourseValidationError";
  }
}

function fail(path: string, msg: string): never {
  throw new CourseValidationError(`${path}: ${msg}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reqString(v: unknown, path: string): string {
  if (typeof v !== "string") fail(path, `expected a string, got ${describe(v)}`);
  return v;
}

/** A required NON-EMPTY string (empty/whitespace-only fails). This is the
 *  content bar for `explain` / `modelAnswer` / `source`. */
function reqNonEmpty(v: unknown, path: string): string {
  const s = reqString(v, path);
  if (s.trim() === "") fail(path, "must be a non-empty string");
  return s;
}

function optString(v: unknown, path: string): string | undefined {
  if (v === undefined) return undefined;
  return reqString(v, path);
}

function reqArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, `expected an array, got ${describe(v)}`);
  return v;
}

function reqStringArray(v: unknown, path: string): string[] {
  const arr = reqArray(v, path);
  return arr.map((item, i) => reqString(item, `${path}[${i}]`));
}

function reqNonEmptyStringArray(v: unknown, path: string): string[] {
  const arr = reqStringArray(v, path);
  if (arr.length === 0) fail(path, "must have at least one entry");
  return arr;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v;
}

function loadPrinciple(v: unknown, path: string): Principle {
  if (!isObject(v)) fail(path, `expected an object, got ${describe(v)}`);
  return {
    markdown: reqString(v.markdown, `${path}.markdown`),
    remember: reqString(v.remember, `${path}.remember`),
    diagramFen: optString(v.diagramFen, `${path}.diagramFen`),
  };
}

function loadFocusAsk(v: unknown, path: string): FocusAsk {
  if (!isObject(v)) fail(path, `expected an object, got ${describe(v)}`);
  return {
    prompt: reqString(v.prompt, `${path}.prompt`),
    accept: reqNonEmptyStringArray(v.accept, `${path}.accept`),
    // Content bar: an interleaved question must name the mistake on reveal.
    explain: reqNonEmpty(v.explain, `${path}.explain`),
  };
}

function loadFocusNote(v: unknown, path: string): FocusNote {
  if (!isObject(v)) fail(path, `expected an object, got ${describe(v)}`);
  if (typeof v.ply !== "number" || !Number.isInteger(v.ply)) {
    fail(`${path}.ply`, `expected an integer, got ${describe(v.ply)}`);
  }
  const note: FocusNote = {
    ply: v.ply as number,
    text: reqString(v.text, `${path}.text`),
  };
  if (v.ask !== undefined) note.ask = loadFocusAsk(v.ask, `${path}.ask`);
  return note;
}

function loadIllustration(v: unknown, path: string): Illustration {
  if (!isObject(v)) fail(path, `expected an object, got ${describe(v)}`);
  const focusRaw = reqArray(v.focus, `${path}.focus`);
  const illustration: Illustration = {
    title: reqString(v.title, `${path}.title`),
    pgn: reqString(v.pgn, `${path}.pgn`),
    // Content bar: every illustration must carry a cited source.
    source: reqNonEmpty(v.source, `${path}.source`),
    focus: focusRaw.map((f, i) => loadFocusNote(f, `${path}.focus[${i}]`)),
  };
  if (v.startPly !== undefined) {
    if (typeof v.startPly !== "number" || !Number.isInteger(v.startPly)) {
      fail(`${path}.startPly`, `expected an integer, got ${describe(v.startPly)}`);
    }
    illustration.startPly = v.startPly;
  }
  if (v.interleave !== undefined) {
    if (typeof v.interleave !== "boolean") {
      fail(`${path}.interleave`, `expected a boolean, got ${describe(v.interleave)}`);
    }
    illustration.interleave = v.interleave;
  }
  return illustration;
}

function loadQuestion(v: unknown, path: string): Question {
  if (!isObject(v)) fail(path, `expected an object, got ${describe(v)}`);
  const kind = v.kind;
  switch (kind) {
    case "multiple_choice": {
      const options = reqStringArray(v.options, `${path}.options`);
      if (options.length < 2 || options.length > 4) {
        fail(`${path}.options`, `multiple_choice needs 2–4 options, got ${options.length}`);
      }
      if (typeof v.correct !== "number" || !Number.isInteger(v.correct)) {
        fail(`${path}.correct`, `expected an integer index, got ${describe(v.correct)}`);
      }
      if (v.correct < 0 || v.correct >= options.length) {
        fail(`${path}.correct`, `index ${v.correct} is out of range for ${options.length} options`);
      }
      return {
        kind: "multiple_choice",
        fen: optString(v.fen, `${path}.fen`),
        prompt: reqString(v.prompt, `${path}.prompt`),
        options,
        correct: v.correct,
        // Content bar: name the mistake, not just the answer.
        explain: reqNonEmpty(v.explain, `${path}.explain`),
      };
    }
    case "choose_move": {
      return {
        kind: "choose_move",
        fen: reqString(v.fen, `${path}.fen`),
        prompt: reqString(v.prompt, `${path}.prompt`),
        accept: reqNonEmptyStringArray(v.accept, `${path}.accept`),
        explain: reqNonEmpty(v.explain, `${path}.explain`),
      };
    }
    case "free_text": {
      return {
        kind: "free_text",
        fen: optString(v.fen, `${path}.fen`),
        prompt: reqString(v.prompt, `${path}.prompt`),
        // Content bar: the model answer is the reveal — must be present.
        modelAnswer: reqNonEmpty(v.modelAnswer, `${path}.modelAnswer`),
        rubric: reqStringArray(v.rubric, `${path}.rubric`),
      };
    }
    default:
      fail(
        `${path}.kind`,
        `unknown question kind ${JSON.stringify(kind)} ` +
          `(expected "multiple_choice", "choose_move", or "free_text")`,
      );
  }
}

function loadModule(v: unknown, path: string): Module {
  if (!isObject(v)) fail(path, `expected an object, got ${describe(v)}`);
  const illustrationsRaw = reqArray(v.illustrations, `${path}.illustrations`);
  const questionsRaw = reqArray(v.questions, `${path}.questions`);
  return {
    id: reqString(v.id, `${path}.id`),
    title: reqString(v.title, `${path}.title`),
    principle: loadPrinciple(v.principle, `${path}.principle`),
    illustrations: illustrationsRaw.map((it, i) =>
      loadIllustration(it, `${path}.illustrations[${i}]`),
    ),
    questions: questionsRaw.map((q, i) => loadQuestion(q, `${path}.questions[${i}]`)),
  };
}

/**
 * Parse + validate a course from untrusted JSON (a bundled course file or a
 * parsed object). Throws `CourseValidationError` with a dotted field path on
 * the FIRST violation — schema shape OR the content bar (every question and
 * every focus `ask` carries a non-empty `explain`/`modelAnswer`, every
 * illustration carries a non-empty `source`). Never returns a half-loaded
 * course.
 *
 * Accepts either a JSON string or an already-parsed value.
 */
export function loadCourse(json: unknown): Course {
  let root: unknown = json;
  if (typeof json === "string") {
    try {
      root = JSON.parse(json);
    } catch (e) {
      throw new CourseValidationError(
        `course: not valid JSON — ${(e as Error).message}`,
      );
    }
  }
  if (!isObject(root)) {
    fail("course", `expected an object, got ${describe(root)}`);
  }
  const modulesRaw = reqArray(root.modules, "course.modules");
  if (modulesRaw.length === 0) {
    fail("course.modules", "a course needs at least one module");
  }
  return {
    id: reqString(root.id, "course.id"),
    title: reqString(root.title, "course.title"),
    blurb: reqString(root.blurb, "course.blurb"),
    level: reqString(root.level, "course.level"),
    modules: modulesRaw.map((m, i) => loadModule(m, `course.modules[${i}]`)),
  };
}

// ── choose_move grader ──────────────────────────────────────────────────────

function chessFromFen(fen: string): Chess | null {
  const setup = parseFen(padFen(fen));
  if (setup.isErr) return null;
  const pos = Chess.fromSetup(setup.unwrap());
  if (pos.isErr) return null;
  return pos.unwrap();
}

/** Canonical SAN for a SAN string in a position, or null if it doesn't parse
 *  to a legal normal move. Re-rendering through makeSan normalizes
 *  disambiguation, check/mate marks, and promotion suffix. */
function canonicalSan(chess: Chess, san: string): string | null {
  const move = parseSan(chess, san);
  if (!move || !("from" in move)) return null;
  // makeSan clones internally, so the position is not mutated between calls.
  const rendered = makeSan(chess, move);
  if (!rendered || rendered === "--") return null;
  return rendered;
}

/**
 * Grade a `choose_move` answer: true iff `san` (the move the user played) is
 * one of the `accept` moves, compared through the repo's SAN path so that
 * disambiguation ("Nbd2" vs "Nfd2"), check marks, and promotion normalize —
 * never a naive string compare. Chess960-safe (parseSan/makeSan honor the
 * position's castling setup). Returns false on a bad FEN or an unparseable /
 * illegal played move.
 */
export function gradeChooseMove(fen: string, san: string, accept: string[]): boolean {
  const chess = chessFromFen(fen);
  if (!chess) return false;
  const played = canonicalSan(chess, san);
  if (played === null) return false;
  for (const candidate of accept) {
    if (canonicalSan(chess, candidate) === played) return true;
  }
  return false;
}

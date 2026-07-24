import { describe, it, expect } from "vitest";
import {
  loadCourse,
  gradeChooseMove,
  CourseValidationError,
  type Course,
} from "@chessgui/core/lessons";
import { parsePgn, startingPosition } from "chessops/pgn";
import { parseSan } from "chessops/san";
// The bundled fixture course (resolved via the @chessgui/core → src alias).
import fixture from "@chessgui/core/lessons/fixture-course.json";

// A deep clone so each mutation test starts from a pristine, valid course.
function clone(): unknown {
  return structuredClone(fixture);
}

describe("loadCourse — accepts the fixture", () => {
  it("loads the fixture course and preserves structure", () => {
    const course: Course = loadCourse(fixture);
    expect(course.id).toBe("fixture-closed-positions");
    expect(course.modules).toHaveLength(1);
    const m = course.modules[0];
    // one of each question kind is present
    const kinds = m.questions.map((q) => q.kind).sort();
    expect(kinds).toEqual(["choose_move", "free_text", "multiple_choice"]);
    // an interleaved illustration whose focus note carries an ask
    const ill = m.illustrations[0];
    expect(ill.interleave).toBe(true);
    const asked = ill.focus.find((f) => f.ask);
    expect(asked?.ask?.accept.length).toBeGreaterThan(0);
    expect(asked?.ask?.explain.trim()).not.toBe("");
  });

  it("accepts a JSON string as well as a parsed object", () => {
    const course = loadCourse(JSON.stringify(fixture));
    expect(course.id).toBe("fixture-closed-positions");
  });

  it("the fixture illustration PGN is a real, legal line", () => {
    const ill = loadCourse(fixture).modules[0].illustrations[0];
    const game = parsePgn(ill.pgn)[0];
    expect(game).toBeDefined();
    const pos = startingPosition(game.headers).unwrap();
    let plies = 0;
    for (const node of game.moves.mainline()) {
      const move = parseSan(pos, node.san);
      expect(move, `illegal SAN at ply ${plies + 1}: ${node.san}`).not.toBeNull();
      pos.play(move!);
      plies++;
    }
    expect(plies).toBe(10);
  });
});

describe("loadCourse — rejects malformed courses", () => {
  it("rejects a non-object / missing modules", () => {
    expect(() => loadCourse(null)).toThrow(CourseValidationError);
    expect(() => loadCourse({ id: "x", title: "t", blurb: "b", level: "l" })).toThrow(
      /modules/,
    );
    expect(() => loadCourse({ ...(clone() as object), modules: [] })).toThrow(
      /at least one module/,
    );
  });

  it("rejects a bad question discriminant", () => {
    const c = clone() as any;
    c.modules[0].questions[0].kind = "true_false";
    expect(() => loadCourse(c)).toThrow(CourseValidationError);
    expect(() => loadCourse(c)).toThrow(/unknown question kind/);
  });

  it("rejects an out-of-range multiple_choice correct index", () => {
    const c = clone() as any;
    const mc = c.modules[0].questions.find((q: any) => q.kind === "multiple_choice");
    mc.correct = 9;
    expect(() => loadCourse(c)).toThrow(/out of range/);
  });

  it("rejects missing required string fields", () => {
    const c = clone() as any;
    delete c.modules[0].title;
    expect(() => loadCourse(c)).toThrow(/title/);
  });
});

describe("loadCourse — enforces the content bar", () => {
  it("rejects a multiple_choice question with an empty explain", () => {
    const c = clone() as any;
    const mc = c.modules[0].questions.find((q: any) => q.kind === "multiple_choice");
    mc.explain = "   ";
    expect(() => loadCourse(c)).toThrow(/explain/);
    expect(() => loadCourse(c)).toThrow(/non-empty/);
  });

  it("rejects a choose_move question with a missing explain", () => {
    const c = clone() as any;
    const cm = c.modules[0].questions.find((q: any) => q.kind === "choose_move");
    delete cm.explain;
    expect(() => loadCourse(c)).toThrow(/explain/);
  });

  it("rejects a free_text question with a missing modelAnswer", () => {
    const c = clone() as any;
    const ft = c.modules[0].questions.find((q: any) => q.kind === "free_text");
    delete ft.modelAnswer;
    expect(() => loadCourse(c)).toThrow(/modelAnswer/);
  });

  it("rejects a focus-note ask with an empty explain", () => {
    const c = clone() as any;
    const ask = c.modules[0].illustrations[0].focus.find((f: any) => f.ask).ask;
    ask.explain = "";
    expect(() => loadCourse(c)).toThrow(/ask.explain/);
  });

  it("rejects an illustration with a missing source", () => {
    const c = clone() as any;
    delete c.modules[0].illustrations[0].source;
    expect(() => loadCourse(c)).toThrow(/source/);
  });
});

describe("gradeChooseMove", () => {
  const startFen = "r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4";

  it("accepts a SAN in the accept set", () => {
    expect(gradeChooseMove(startFen, "Ba4", ["Ba4", "Bxc6"])).toBe(true);
    expect(gradeChooseMove(startFen, "Bxc6", ["Ba4", "Bxc6"])).toBe(true);
  });

  it("rejects a legal move that is not in the accept set", () => {
    expect(gradeChooseMove(startFen, "Bc4", ["Ba4"])).toBe(false);
    expect(gradeChooseMove(startFen, "d4", ["Ba4"])).toBe(false);
  });

  it("rejects an illegal / unparseable played move", () => {
    expect(gradeChooseMove(startFen, "Ke5", ["Ba4"])).toBe(false);
    expect(gradeChooseMove(startFen, "not-a-move", ["Ba4"])).toBe(false);
  });

  it("returns false on a bad FEN", () => {
    expect(gradeChooseMove("total garbage", "Ba4", ["Ba4"])).toBe(false);
  });

  it("disambiguation: distinguishes Nbd2 from Nfd2 (no naive string compare)", () => {
    // White knights on b1 and f3 both reach d2; d2 is empty.
    const fen = "4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1";
    expect(gradeChooseMove(fen, "Nbd2", ["Nbd2"])).toBe(true);
    expect(gradeChooseMove(fen, "Nfd2", ["Nbd2"])).toBe(false);
    expect(gradeChooseMove(fen, "Nfd2", ["Nfd2"])).toBe(true);
    // accepting both is fine
    expect(gradeChooseMove(fen, "Nfd2", ["Nbd2", "Nfd2"])).toBe(true);
  });

  it("normalizes check marks and non-canonical accept SAN", () => {
    // A capture that gives check: accept written without the '+' still matches.
    // Position: white to deliver Bxf7+ in an Italian-style setup.
    const fen = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4";
    expect(gradeChooseMove(fen, "Bxf7+", ["Bxf7"])).toBe(true);
    expect(gradeChooseMove(fen, "Bxf7", ["Bxf7+"])).toBe(true);
  });
});

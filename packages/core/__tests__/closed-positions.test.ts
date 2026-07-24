import { describe, it, expect } from "vitest";
import { loadCourse, type Course } from "@chessgui/core/lessons";
import { parsePgn, startingPosition } from "chessops/pgn";
import { parseSan } from "chessops/san";
import { parseFen } from "chessops/fen";
import { Chess } from "chessops/chess";
// The shipped course (resolved via the @chessgui/core → src alias).
import closed from "@chessgui/core/lessons/closed-positions.json";

const EXPECTED_MODULE_IDS = [
  "m1-stalling-is-not-a-plan",
  "m2-plan-from-structure",
  "m3-improve-worst-piece",
  "m4-prophylaxis",
  "m5-two-weaknesses",
  "m6-timing-the-break",
  "m7-patience-waiting",
  "m8-space-restriction",
];

describe("closed-positions course — loads and validates", () => {
  it("loadCourse accepts the course and preserves structure", () => {
    const course: Course = loadCourse(closed);
    expect(course.id).toBe("closed-positions");
    expect(course.title).toBe("Playing Closed & Locked Positions");
    expect(course.blurb.trim()).not.toBe("");
    expect(course.modules).toHaveLength(8);
    expect(course.modules.map((m) => m.id)).toEqual(EXPECTED_MODULE_IDS);
  });

  it("accepts a JSON string as well as a parsed object", () => {
    const course = loadCourse(JSON.stringify(closed));
    expect(course.id).toBe("closed-positions");
  });
});

// The load-bearing legality gate: every illustration line must be a real,
// legal game, and every interactive answer (choose_move accept + focus-ask
// accept) must be a legal move in its position.
describe("closed-positions course — every move is legal", () => {
  const course = loadCourse(closed);

  /** Assert a SAN string is a legal move in `pos`; returns nothing on success. */
  function expectLegal(pos: Chess, san: string, where: string) {
    const move = parseSan(pos, san);
    expect(move, `illegal SAN (${san}) at ${where}`).not.toBeNull();
  }

  /** Build a Chess position from a FEN, failing loudly if the FEN is bad. */
  function posFromFen(fen: string, where: string): Chess {
    const setup = parseFen(fen);
    expect(setup.isOk, `bad FEN at ${where}: ${fen}`).toBe(true);
    const pos = Chess.fromSetup(setup.unwrap());
    expect(pos.isOk, `illegal position at ${where}: ${fen}`).toBe(true);
    return pos.unwrap();
  }

  for (const m of course.modules) {
    describe(`module ${m.id}`, () => {
      // 1) Every illustration PGN plays through legally, and every focus-ask
      //    accept SAN is legal in the position reached at its focus ply.
      m.illustrations.forEach((ill, ii) => {
        it(`illustration[${ii}] "${ill.title}" is a legal line with legal asks`, () => {
          const game = parsePgn(ill.pgn)[0];
          expect(game, `no game parsed for ${m.id} illustration[${ii}]`).toBeDefined();
          const pos = startingPosition(game.headers).unwrap();

          // Positions indexed by ply (0 = before any move).
          const posAtPly = new Map<number, Chess>();
          posAtPly.set(0, pos.clone());

          let ply = 0;
          for (const node of game.moves.mainline()) {
            const move = parseSan(pos, node.san);
            expect(
              move,
              `illegal SAN at ply ${ply + 1} in ${m.id} illustration[${ii}]: ${node.san}`,
            ).not.toBeNull();
            pos.play(move!);
            ply++;
            posAtPly.set(ply, pos.clone());
          }

          // Every focus-ask accept must be legal in the position at that ply.
          for (const note of ill.focus) {
            if (!note.ask) continue;
            const at = posAtPly.get(note.ply);
            expect(
              at,
              `focus note ply ${note.ply} out of range in ${m.id} illustration[${ii}]`,
            ).toBeDefined();
            expect(note.ask.accept.length).toBeGreaterThan(0);
            for (const san of note.ask.accept) {
              expectLegal(
                at!,
                san,
                `${m.id} illustration[${ii}] ask @ply ${note.ply}`,
              );
            }
          }
        });
      });

      // 2) Every choose_move accept SAN is legal in its own FEN.
      it("every choose_move accept is legal in its fen", () => {
        const chooseMoves = m.questions.filter((q) => q.kind === "choose_move");
        expect(chooseMoves.length).toBeGreaterThan(0);
        for (const q of chooseMoves) {
          if (q.kind !== "choose_move") continue;
          const pos = posFromFen(q.fen, `${m.id} choose_move`);
          expect(q.accept.length).toBeGreaterThan(0);
          for (const san of q.accept) {
            expectLegal(pos, san, `${m.id} choose_move fen ${q.fen}`);
          }
        }
      });
    });
  }
});

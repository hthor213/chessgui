import { describe, it, expect } from "vitest";
import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { makeSquare } from "chessops";
import { chessgroundDests } from "chessops/compat";
import type { NormalMove } from "chessops";
import { parseEngineUci, makeEngineUci, uciToArrow, uciMovesToSan } from "@chessgui/core/uci-parser";

const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Helper: create a Chess position from FEN
function posFromFen(fen: string): Chess {
  const setup = parseFen(fen).unwrap();
  return Chess.fromSetup(setup).unwrap();
}

// Helper: get chessgroundDests as Map<string, string[]>
function getDests(fen: string): Map<string, string[]> {
  return chessgroundDests(posFromFen(fen));
}

// Helper: play a SAN move and return new FEN
function playSan(chess: Chess, san: string): string {
  const move = parseSan(chess, san);
  if (!move) throw new Error(`Invalid SAN: ${san}`);
  chess.play(move);
  return makeFen(chess.toSetup());
}

// =============================================================================
// Bug 1: Legal moves / dests map completeness
// =============================================================================
describe("Bug 1: All legal moves are present in chessgroundDests", () => {
  it("initial position has correct number of legal moves", () => {
    const dests = getDests(INITIAL_FEN);
    // White has 16 pawn moves (8 pawns * 2 each) + 4 knight moves = 20
    let totalDests = 0;
    for (const [, targets] of dests) {
      totalDests += targets.length;
    }
    expect(totalDests).toBe(20);
  });

  it("all pieces have dests at every point in a 20-move game", () => {
    const chess = posFromFen(INITIAL_FEN);
    // Play a known game (Italian Opening with lots of piece development)
    const moves = [
      "e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6",
      "d4", "exd4", "cxd4", "Bb4+", "Bd2", "Bxd2+", "Nbxd2", "d5",
      "exd5", "Nxd5", "Qb3", "Nce7",
    ];

    for (let i = 0; i < moves.length; i++) {
      const fen = makeFen(chess.toSetup());
      const dests = chessgroundDests(posFromFen(fen));

      // Verify every piece that has legal moves appears in dests
      const freshPos = posFromFen(fen);
      const allDestsFromChessops = freshPos.allDests();

      for (const [sq, squareSet] of allDestsFromChessops) {
        if (squareSet.nonEmpty()) {
          const squareName = makeSquare(sq);
          expect(dests.has(squareName)).toBe(true);
          // chessgroundDests may have MORE dests (castling extras) but never fewer
          const chessopsDests = Array.from(squareSet, makeSquare);
          const cgDests = dests.get(squareName)!;
          for (const dest of chessopsDests) {
            expect(cgDests).toContain(dest);
          }
        }
      }

      playSan(chess, moves[i]);
    }
  });

  it("random 30-move game: dests map always contains all allDests moves", () => {
    // Use a seeded approach: play the first legal move alphabetically for consistency
    const chess = posFromFen(INITIAL_FEN);
    let fen = INITIAL_FEN;

    for (let moveNum = 0; moveNum < 30; moveNum++) {
      const pos = posFromFen(fen);
      const dests = chessgroundDests(pos);
      const allDestsMap = pos.allDests();

      // Verify completeness
      for (const [sq, squareSet] of allDestsMap) {
        if (squareSet.nonEmpty()) {
          const squareName = makeSquare(sq);
          expect(dests.has(squareName)).toBe(true);
          const chessopsDests = Array.from(squareSet, makeSquare);
          const cgDests = dests.get(squareName)!;
          for (const dest of chessopsDests) {
            expect(cgDests).toContain(dest);
          }
        }
      }

      // Pick a deterministic move: first from-square alphabetically, first to-square
      const sortedFroms = Array.from(dests.keys()).sort();
      if (sortedFroms.length === 0) break; // game over

      const from = sortedFroms[0];
      const tos = dests.get(from)!.sort();
      const to = tos[0];

      // Find the actual chessops move
      const fromSq = allDestsMap.keys().next();
      // Use parseSan-compatible approach: build all legal moves and find matching one
      let moved = false;
      for (const [fromSq2, squareSet] of allDestsMap) {
        if (makeSquare(fromSq2) !== from) continue;
        for (const toSq of squareSet) {
          if (makeSquare(toSq) !== to) continue;
          const move: NormalMove = { from: fromSq2, to: toSq };
          // Handle promotion: if pawn reaching back rank, promote to queen
          const piece = pos.board.get(fromSq2);
          if (piece?.role === "pawn" && (toSq >> 3 === 0 || toSq >> 3 === 7)) {
            move.promotion = "queen";
          }
          chess.play(move);
          fen = makeFen(chess.toSetup());
          moved = true;
          break;
        }
        if (moved) break;
      }

      if (!moved) break;
    }

    // If we got through 30 moves without assertion failure, the test passes
    expect(true).toBe(true);
  });

  it("castling: king dests include both rook-square and destination-square", () => {
    // Position where white can castle kingside
    const fen = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
    const dests = getDests(fen);

    const kingDests = dests.get("e1")!;
    expect(kingDests).toBeDefined();
    // Should include h1 (rook square, chessops style) AND g1 (destination, standard style)
    expect(kingDests).toContain("h1");
    expect(kingDests).toContain("g1");
    // f1 is also a legal king move
    expect(kingDests).toContain("f1");
  });

  it("castling: black kingside includes both h8 and g8", () => {
    const fen = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R b KQkq - 0 4";
    const dests = getDests(fen);

    const kingDests = dests.get("e8")!;
    expect(kingDests).toBeDefined();
    expect(kingDests).toContain("h8");
    expect(kingDests).toContain("g8");
  });

  it("knight moves are always present (bug: knight wouldn't move)", () => {
    // After 1.e4 e5 2.Nf3, the knight on f3 should have legal moves
    const fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";
    const dests = getDests(fen);

    // Black knights should have moves
    const b8Dests = dests.get("b8");
    expect(b8Dests).toBeDefined();
    expect(b8Dests!.length).toBeGreaterThan(0);

    const g8Dests = dests.get("g8");
    expect(g8Dests).toBeDefined();
    expect(g8Dests!.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Bug 2: Underpromotion
// =============================================================================
describe("Bug 2: Underpromotion works correctly", () => {
  const UNDERPROMOTION_GAME = [
    "d4", "Nf6", "Nc3", "d5", "Bg5", "c5", "Bxf6", "gxf6",
    "e4", "dxe4", "dxc5", "Qa5", "Qh5", "Bg7", "Bb5+", "Nc6",
    "Ne2", "O-O", "a3", "f5", "O-O", "Qc7", "b4", "Be6",
    "Rad1", "Rad8", "Ba4", "a5", "Nb5", "Qe5", "c3", "axb4",
    "axb4", "Bc4", "Rxd8", "Rxd8", "Nbd4", "Nxd4", "cxd4", "Qf6",
    "Rc1", "Qa6", "Bd1", "Qa2", "h3", "Bd3", "Ng3", "Qd2",
    "Nxf5", "e3", "Nxe7+", "Kh8", "Qh4", "exf2+", "Kh2", "Rxd4",
    "Qg3",
  ];

  it("plays through the full game up to the underpromotion move", () => {
    const chess = posFromFen(INITIAL_FEN);
    for (const san of UNDERPROMOTION_GAME) {
      const move = parseSan(chess, san);
      expect(move).toBeDefined();
      chess.play(move!);
    }

    // Now it's black's turn, pawn on f2 can promote on f1
    const fen = makeFen(chess.toSetup());
    expect(fen).toContain(" b "); // black to move

    // The pawn on f2 should be in black's pieces
    const f2 = 1 * 8 + 5; // rank 1 (idx 1), file f (idx 5) = square 13
    const piece = chess.board.get(f2);
    expect(piece?.role).toBe("pawn");
    expect(piece?.color).toBe("black");
  });

  it("underpromotion to knight works (f1=N+)", () => {
    const chess = posFromFen(INITIAL_FEN);
    for (const san of UNDERPROMOTION_GAME) {
      chess.play(parseSan(chess, san)!);
    }

    // Play f2-f1 with knight promotion
    const move: NormalMove = {
      from: 1 * 8 + 5, // f2 = square 13
      to: 0 * 8 + 5,   // f1 = square 5
      promotion: "knight",
    };

    const san = makeSan(chess, move);
    expect(san).toBe("f1=N+");

    chess.play(move);
    const newFen = makeFen(chess.toSetup());
    // Verify a knight is now on f1
    const f1Piece = chess.board.get(5);
    expect(f1Piece?.role).toBe("knight");
    expect(f1Piece?.color).toBe("black");
  });

  it("underpromotion to rook works", () => {
    const chess = posFromFen(INITIAL_FEN);
    for (const san of UNDERPROMOTION_GAME) {
      chess.play(parseSan(chess, san)!);
    }

    const move: NormalMove = {
      from: 1 * 8 + 5, // f2
      to: 0 * 8 + 5,   // f1
      promotion: "rook",
    };

    const san = makeSan(chess, move);
    expect(san).toBe("f1=R");
  });

  it("underpromotion to bishop works", () => {
    const chess = posFromFen(INITIAL_FEN);
    for (const san of UNDERPROMOTION_GAME) {
      chess.play(parseSan(chess, san)!);
    }

    const move: NormalMove = {
      from: 1 * 8 + 5, // f2
      to: 0 * 8 + 5,   // f1
      promotion: "bishop",
    };

    const san = makeSan(chess, move);
    expect(san).toBe("f1=B");
  });

  it("promotion to queen works", () => {
    const chess = posFromFen(INITIAL_FEN);
    for (const san of UNDERPROMOTION_GAME) {
      chess.play(parseSan(chess, san)!);
    }

    const move: NormalMove = {
      from: 1 * 8 + 5, // f2
      to: 0 * 8 + 5,   // f1
      promotion: "queen",
    };

    const san = makeSan(chess, move);
    expect(san).toBe("f1=Q");
  });

  it("promotion square is in legal dests", () => {
    const chess = posFromFen(INITIAL_FEN);
    for (const san of UNDERPROMOTION_GAME) {
      chess.play(parseSan(chess, san)!);
    }

    const fen = makeFen(chess.toSetup());
    const dests = getDests(fen);

    // f2 pawn should be able to move to f1
    const f2Dests = dests.get("f2");
    expect(f2Dests).toBeDefined();
    expect(f2Dests).toContain("f1");
  });
});

// =============================================================================
// Bug 3: UCI castling notation conversion
// =============================================================================
describe("Bug 3: UCI castling notation normalization", () => {
  // Position where white can castle kingside
  const KS_FEN = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
  // Position where white can castle queenside
  const QS_FEN = "r3kbnr/pppqpppp/2n5/3p1b2/3P1B2/2N5/PPPQPPPP/R3KBNR w KQkq - 6 5";

  it("parses standard castling UCI (e1g1) into king-takes-rook form", () => {
    const chess = posFromFen(KS_FEN);
    const move = parseEngineUci(chess, "e1g1") as NormalMove;
    expect(move).toBeDefined();
    expect(makeSquare(move.from)).toBe("e1");
    expect(makeSquare(move.to)).toBe("h1"); // chessops internal: king takes rook
  });

  it("accepts king-takes-rook UCI (e1h1) unchanged", () => {
    const chess = posFromFen(KS_FEN);
    const move = parseEngineUci(chess, "e1h1") as NormalMove;
    expect(makeSquare(move.to)).toBe("h1");
  });

  it("parses queenside castling e1c1 -> king takes a1 rook", () => {
    const chess = posFromFen(QS_FEN);
    const move = parseEngineUci(chess, "e1c1") as NormalMove;
    expect(makeSquare(move.to)).toBe("a1");
  });

  it("does not treat non-castling moves as castling", () => {
    const chess = posFromFen(INITIAL_FEN);
    const move = parseEngineUci(chess, "e2e4") as NormalMove;
    expect(makeSquare(move.from)).toBe("e2");
    expect(makeSquare(move.to)).toBe("e4");
  });

  it("does not rewrite a king move to g1 when castling rights are gone", () => {
    // King on f1 can step to g1 — that is a normal move, not castling
    const fen = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1K1R w kq - 6 5";
    const chess = posFromFen(fen);
    const move = parseEngineUci(chess, "f1g1") as NormalMove;
    expect(makeSquare(move.to)).toBe("g1");
  });

  it("makeEngineUci renders castling as standard UCI (e1g1)", () => {
    const chess = posFromFen(KS_FEN);
    const move = parseEngineUci(chess, "e1h1")!; // king-takes-rook in
    expect(makeEngineUci(chess, move)).toBe("e1g1"); // standard UCI out
  });

  it("makeEngineUci renders queenside castling as e1c1", () => {
    const chess = posFromFen(QS_FEN);
    const move = parseEngineUci(chess, "e1a1")!;
    expect(makeEngineUci(chess, move)).toBe("e1c1");
  });

  it("makeEngineUci round-trips normal moves and promotions", () => {
    const chess = posFromFen(INITIAL_FEN);
    const move = parseEngineUci(chess, "g1f3")!;
    expect(makeEngineUci(chess, move)).toBe("g1f3");

    const promoFen = "8/4P3/8/8/8/1k6/8/1K6 w - - 0 1";
    const promoPos = posFromFen(promoFen);
    const promo = parseEngineUci(promoPos, "e7e8q")!;
    expect(makeEngineUci(promoPos, promo)).toBe("e7e8q");
  });

  it("Chess960: keeps king-takes-rook UCI for non-classical castling setups", () => {
    // 960-style setup: white king on c1, rook on a1 with castling rights
    // (X-FEN "Q" right). Standard e1c1-style notation cannot express this;
    // the move must stay king-takes-rook (c1a1).
    const fen = "rnbq1bnr/pppkpppp/8/3p4/3P4/8/PPPBPPPP/R1K2BNR w Q - 0 1";
    const setup = parseFen(fen).unwrap();
    const chess = Chess.fromSetup(setup).unwrap();
    const move = parseEngineUci(chess, "c1a1");
    expect(move).toBeDefined();
    expect(makeEngineUci(chess, move!)).toBe("c1a1");
  });

  it("normalized castling UCI produces correct SAN via makeSan", () => {
    const chess = posFromFen(KS_FEN);
    const move = parseEngineUci(chess, "e1g1");
    expect(move).toBeDefined();

    const san = makeSan(chess, move!);
    expect(san).toBe("O-O");
  });

  it("normalized castling UCI + play produces correct position", () => {
    const chess = posFromFen(KS_FEN);
    const move = parseEngineUci(chess, "e1g1")!;
    chess.play(move);

    const newFen = makeFen(chess.toSetup());
    // King should be on g1, rook on f1
    expect(newFen).toContain("RNBQ1RK1");
  });

  it("uciToArrow points castling arrows at the king destination", () => {
    const arrow = uciToArrow(KS_FEN, "e1g1");
    expect(arrow).toEqual({ orig: "e1", dest: "g1" });
    // king-takes-rook input renders the same arrow
    const arrow2 = uciToArrow(KS_FEN, "e1h1");
    expect(arrow2).toEqual({ orig: "e1", dest: "g1" });
  });

  it("uciToArrow rejects illegal/stale moves", () => {
    expect(uciToArrow(INITIAL_FEN, "e1g1")).toBeNull(); // can't castle yet
    expect(uciToArrow(INITIAL_FEN, "e4e5")).toBeNull(); // no piece on e4
    expect(uciToArrow(INITIAL_FEN, "zz99")).toBeNull(); // garbage
  });

  it("uciMovesToSan handles castling in PV lines", () => {
    // Position where Stockfish might return O-O in PV
    const fen = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
    const sanMoves = uciMovesToSan(fen, ["e1g1", "d7d6", "d2d3"]);
    expect(sanMoves[0]).toBe("O-O");
    expect(sanMoves.length).toBe(3);
  });

  it("uciMovesToSan handles queenside castling", () => {
    // Position where white can castle queenside
    const fen = "r3kbnr/pppqpppp/2n5/3p1b2/3P1B2/2N5/PPPQPPPP/R3KBNR w KQkq - 6 5";
    const sanMoves = uciMovesToSan(fen, ["e1c1"]);
    expect(sanMoves[0]).toBe("O-O-O");
  });

  it("playUciMove-style flow: Stockfish castling does not throw", () => {
    const chess = posFromFen(KS_FEN);

    // Simulate what playUciMove does
    const move = parseEngineUci(chess, "e1g1"); // Stockfish notation
    expect(move).toBeDefined();

    // Should not throw
    const san = makeSan(chess, move!);
    expect(san).toBe("O-O");

    chess.play(move!);
    const newFen = makeFen(chess.toSetup());
    expect(newFen).toContain(" b "); // black to move after white castles
  });
});

// =============================================================================
// Integration: play through a full game with dests verification at each move
// =============================================================================
describe("Integration: full game with dests verification", () => {
  it("plays the Immortal Game and verifies dests at each position", () => {
    // Anderssen vs Kieseritzky, 1851 (The Immortal Game)
    const moves = [
      "e4", "e5", "f4", "exf4", "Bc4", "Qh4+", "Kf1", "b5",
      "Bxb5", "Nf6", "Nf3", "Qh6", "d3", "Nh5", "Nh4", "Qg5",
      "Nf5", "c6", "g4", "Nf6", "Rg1", "cxb5", "h4", "Qg6",
      "h5", "Qg5", "Qf3", "Ng8", "Bxf4", "Qf6", "Nc3", "Bc5",
      "Nd5", "Qxb2", "Bd6", "Bxg1", "e5", "Qxa1+", "Ke2", "Na6",
      "Nxg7+", "Kd8", "Qf6+", "Nxf6", "Be7#",
    ];

    const chess = posFromFen(INITIAL_FEN);

    for (let i = 0; i < moves.length; i++) {
      const fen = makeFen(chess.toSetup());
      const pos = posFromFen(fen);
      const dests = chessgroundDests(pos);
      const allDestsMap = pos.allDests();

      // Every move in allDests must appear in chessgroundDests
      for (const [sq, squareSet] of allDestsMap) {
        if (squareSet.nonEmpty()) {
          const squareName = makeSquare(sq);
          expect(dests.has(squareName)).toBe(true);
          for (const toSq of squareSet) {
            expect(dests.get(squareName)).toContain(makeSquare(toSq));
          }
        }
      }

      const move = parseSan(chess, moves[i]);
      expect(move).toBeDefined();
      chess.play(move!);
    }
  });
});

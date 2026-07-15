import { describe, it, expect } from "vitest";
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { chessgroundDests } from "chessops/compat";
import { applyUci, dragToUci, sparStatus, turnOf } from "@/lib/spar";
import {
  pickBookEntry,
  userColorForEntry,
  loadRivalBook,
  type RivalBookEntry,
} from "@/lib/rival-book";
import { maiaMove } from "@/lib/maia";
import { mockMaiaMove } from "@/lib/maia-mock";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("spar chess helpers", () => {
  it("applies a legal UCI move, returning FEN + SAN", () => {
    const ply = applyUci(START, "e2e4");
    expect(ply).not.toBeNull();
    expect(ply!.san).toBe("e4");
    expect(turnOf(ply!.fen)).toBe("black");
  });

  it("rejects an illegal move", () => {
    expect(applyUci(START, "e2e5")).toBeNull();
    expect(applyUci(START, "garbage")).toBeNull();
  });

  it("auto-queens a pawn reaching the last rank", () => {
    const fen = "4k3/4P3/8/8/8/8/8/4K3 w - - 0 1";
    expect(dragToUci(fen, "e7", "e8")).toBe("e7e8q");
    // A non-promoting move gets no suffix.
    expect(dragToUci(START, "e2", "e4")).toBe("e2e4");
  });

  it("detects checkmate with the winning side", () => {
    // Fool's mate: White to move is checkmated by ...Qh4#.
    const mated = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    const s = sparStatus(mated);
    expect(s.over).toBe(true);
    expect(s.label).toBe("Checkmate — Black wins");
  });

  it("reports an ongoing position as not over", () => {
    expect(sparStatus(START).over).toBe(false);
  });
});

describe("rival book sampler", () => {
  const book: RivalBookEntry[] = [
    // user Black, ply 1
    { fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", line: "1.e4", ply: 1, rival_color: "white", weight: 10 },
    // user Black, ply 3
    { fen: "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2", line: "1.e4 c5 2.Nf3", ply: 3, rival_color: "white", weight: 5 },
    // user White, ply 2
    { fen: "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", line: "1.e4 c5", ply: 2, rival_color: "black", weight: 5 },
  ];

  it("derives the user's colour as the side to move", () => {
    expect(userColorForEntry(book[0])).toBe("black");
    expect(userColorForEntry(book[2])).toBe("white");
  });

  it("samples by cumulative weight (deterministic rng)", () => {
    // preferMinPly 1 so all three are in the pool; total weight = 20.
    const opts = { preferMinPly: 1 };
    expect(pickBookEntry(book, () => 0.0, opts)!.line).toBe("1.e4"); // target 0 -> first
    expect(pickBookEntry(book, () => 0.9, opts)!.line).toBe("1.e4 c5"); // target 18 -> third
    expect(pickBookEntry(book, () => 0.6, opts)!.line).toBe("1.e4 c5 2.Nf3"); // target 12 -> second
  });

  it("filters by requested user colour", () => {
    const white = pickBookEntry(book, () => 0.5, { userColor: "white" });
    expect(userColorForEntry(white!)).toBe("white");
    const black = pickBookEntry(book, () => 0.5, { userColor: "black" });
    expect(userColorForEntry(black!)).toBe("black");
  });

  it("prefers deeper lines but relaxes when the pool would be empty", () => {
    // Default preferMinPly 3: for user White only the ply-2 line exists, so the
    // depth filter empties and it relaxes to the colour pool rather than failing.
    const white = pickBookEntry(book, () => 0.5, { userColor: "white" });
    expect(white!.ply).toBe(2);
  });

  it("returns null for an empty book", () => {
    expect(pickBookEntry([], () => 0.5)).toBeNull();
  });
});

describe("maia_move mock (headless)", () => {
  it("returns a legal move that advances the position", async () => {
    const mv = await mockMaiaMove(START, 1700);
    expect(mv.uci).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
    const ply = applyUci(START, mv.uci);
    expect(ply).not.toBeNull();
    expect(ply!.san).toBe(mv.san);
  });

  it("routes through the maiaMove seam outside Tauri", async () => {
    // No window.__TAURI_INTERNALS__ in the test env -> the mock is used.
    const mv = await maiaMove(START, 1700);
    expect(applyUci(START, mv.uci)).not.toBeNull();
  });
});

describe("rival book loader (headless)", () => {
  it("loads the mock book outside Tauri with legal, playable entries", async () => {
    const b = await loadRivalBook();
    expect(b.entries.length).toBeGreaterThan(0);
    // Every entry's FEN is parseable and the user (side to move) can move.
    for (const e of b.entries) {
      expect(["white", "black"]).toContain(userColorForEntry(e));
      expect(turnOf(e.fen)).toBe(userColorForEntry(e));
    }
  });
});

/** A legal move for the side to move (mimics the user picking a board move). */
function firstLegalUci(fen: string): string {
  const setup = parseFen(fen);
  const pos = Chess.fromSetup(setup.unwrap()).unwrap();
  const dests = chessgroundDests(pos) as Map<string, string[]>;
  for (const [from, tos] of dests) {
    if (tos.length > 0) return dragToUci(fen, from, tos[0]);
  }
  throw new Error("no legal move");
}

describe("spar game loop (headless mock path)", () => {
  // Drives the same exchange the SparTab component runs: from a weighted book
  // start (user to move), the user plays a legal move and the rival replies via
  // the maia_move mock, alternating. Proves a spar game exchanges >= 2 moves per
  // side entirely outside Tauri.
  it("exchanges at least two moves per side from a book start", async () => {
    const book = await loadRivalBook();
    const entry = pickBookEntry(book.entries, () => 0.0, { preferMinPly: 1 })!;
    const userColor = userColorForEntry(entry);
    const rivalColor = userColor === "white" ? "black" : "white";

    // The book start always has the user to move.
    expect(turnOf(entry.fen)).toBe(userColor);

    let fen = entry.fen;
    let userMoves = 0;
    let rivalMoves = 0;
    const sans: string[] = [];

    for (let i = 0; i < 8 && !sparStatus(fen).over; i++) {
      if (turnOf(fen) === userColor) {
        const ply = applyUci(fen, firstLegalUci(fen))!;
        expect(ply.san).not.toBe("");
        fen = ply.fen;
        sans.push(ply.san);
        userMoves++;
      } else {
        const mv = await maiaMove(fen, 1700); // rival via the mock
        expect(turnOf(fen)).toBe(rivalColor);
        const ply = applyUci(fen, mv.uci)!;
        expect(ply.san).toBe(mv.san);
        fen = ply.fen;
        sans.push(ply.san);
        rivalMoves++;
      }
    }

    expect(userMoves).toBeGreaterThanOrEqual(2);
    expect(rivalMoves).toBeGreaterThanOrEqual(2);
    // The running position stayed legal the whole way (every applyUci returned).
    expect(applyUci(fen, firstLegalUci(fen))).not.toBeNull();
  });
});

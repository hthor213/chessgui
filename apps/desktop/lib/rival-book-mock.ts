// Headless mock for the rival opening book (spec 214, Tier 0). A handful of real,
// legal book lines drawn from dad's actual book output, covering both user
// colours and a range of depths so the picker and spar flow are exercisable
// outside Tauri. Dynamically imported so it never ships in the Tauri bundle.

import type { RivalBook } from "@/lib/rival-book";

export async function mockRivalBook(): Promise<RivalBook> {
  return {
    version: 1,
    max_ply: 8,
    rival: "dad",
    stats: { positions: 5 },
    entries: [
      // Dad as White -> user plays Black.
      {
        fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        line: "1.e4",
        ply: 1,
        rival_color: "white",
        weight: 22,
      },
      {
        fen: "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
        line: "1.e4 c5 2.Nf3",
        ply: 3,
        rival_color: "white",
        weight: 7,
      },
      {
        fen: "rnbqkbnr/pppp1ppp/4p3/8/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
        line: "1.e4 e6 2.Nf3",
        ply: 3,
        rival_color: "white",
        weight: 5,
      },
      // Dad as Black -> user plays White.
      {
        fen: "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
        line: "1.e4 c5",
        ply: 2,
        rival_color: "black",
        weight: 4,
      },
      {
        fen: "rnbqk1nr/ppp2ppp/3p4/2b1p3/2P5/2N2N2/PP1PPPPP/R1BQKB1R w KQkq - 0 4",
        line: "1.c4 e5 2.Nc3 Bc5 3.Nf3 d6",
        ply: 6,
        rival_color: "black",
        weight: 2,
      },
    ],
  };
}

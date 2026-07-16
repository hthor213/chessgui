// Cerebellum Light opening book (10.9M engine-analyzed positions)
// All moves calculated by Stockfish, scores made consistent via graph algorithm.

let polyglotInstance: any = null;

/**
 * Query the local Cerebellum Polyglot book for the best move in this position.
 * Returns a UCI move string (e.g. "e2e4") or null if out of book.
 */
export async function getOpeningBookMove(fen: string): Promise<string | null> {
  try {
    if (typeof window === "undefined") return null;

    if (!polyglotInstance) {
      // @ts-ignore - cm-polyglot lacks TypeScript declaration files
      const { Polyglot } = await import("cm-polyglot/src/Polyglot.js");
      polyglotInstance = new Polyglot("/book.bin");
    }

    const moves = await polyglotInstance.getMovesFromFen(fen);
    if (moves && moves.length > 0) {
      // Cerebellum sorts by weight — highest weight = best engine-evaluated move
      const best = moves[0];
      const uci = best.from + best.to + (best.promotion || "");
      console.log(`[opening-book] Cerebellum book move: ${uci} (weight: ${best.weight}, ${moves.length} moves available)`);
      return uci;
    }
  } catch (err) {
    console.warn("[opening-book] Failed to query Cerebellum book:", err);
  }
  return null;
}

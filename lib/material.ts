// Captured-piece and material-point accounting (pure, no dependencies).
//
// Everything is derived by comparing the piece multiset of the START position
// against the CURRENT position, so custom start positions from the position
// editor are handled for free. Promotions make the diff asymmetric (a white
// pawn "disappears" and a white queen "appears"); per-role counts are clamped
// at zero, and the point balance is computed from board totals — a promoted
// queen counts as +8 material gain, never as a phantom capture credit for the
// opponent.

export type CapturedRole = "pawn" | "knight" | "bishop" | "rook" | "queen";

export type CapturedCounts = Partial<Record<CapturedRole, number>>;

export interface MaterialSummary {
  /** Black pieces missing from the board (i.e. what White has captured). */
  capturedByWhite: CapturedCounts;
  /** White pieces missing from the board (i.e. what Black has captured). */
  capturedByBlack: CapturedCounts;
  /** Side ahead on points relative to the start position, or null on ties. */
  advantage: "white" | "black" | null;
  /** Net point difference in favor of `advantage` (0 when tied). */
  points: number;
}

export const PIECE_POINTS: Record<CapturedRole, number> = {
  pawn: 1,
  knight: 3,
  bishop: 3,
  rook: 5,
  queen: 9,
};

// Kings are deliberately absent: they are never captured and carry no points.
const CHAR_TO_ROLE: Record<string, CapturedRole> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
};

interface SideCounts {
  white: Record<CapturedRole, number>;
  black: Record<CapturedRole, number>;
}

function emptyCounts(): Record<CapturedRole, number> {
  return { pawn: 0, knight: 0, bishop: 0, rook: 0, queen: 0 };
}

// A FEN board field: 8 rank groups of piece letters / digits. Anything that
// doesn't match is treated as empty rather than miscounted (e.g. the "n" in
// arbitrary text must not register as a knight).
const BOARD_FIELD = /^[pnbrqkPNBRQK1-8]+(\/[pnbrqkPNBRQK1-8]+){7}$/;

/** Count non-king pieces per side from a FEN's board field. Malformed input
 *  yields empty counts rather than throwing. */
function countPieces(fen: string): SideCounts {
  const counts: SideCounts = { white: emptyCounts(), black: emptyCounts() };
  const board = (fen ?? "").trim().split(/\s+/)[0] ?? "";
  if (!BOARD_FIELD.test(board)) return counts;
  for (const ch of board) {
    const role = CHAR_TO_ROLE[ch.toLowerCase()];
    if (!role) continue; // digits, '/', kings, junk
    counts[ch === ch.toLowerCase() ? "black" : "white"][role] += 1;
  }
  return counts;
}

function pointsOf(counts: Record<CapturedRole, number>): number {
  let total = 0;
  for (const role of Object.keys(PIECE_POINTS) as CapturedRole[]) {
    total += counts[role] * PIECE_POINTS[role];
  }
  return total;
}

/** Per-role missing pieces (start minus current), clamped at zero so a
 *  promotion's "appearing" queen never produces a negative capture count. */
function missing(
  start: Record<CapturedRole, number>,
  current: Record<CapturedRole, number>,
): CapturedCounts {
  const out: CapturedCounts = {};
  for (const role of Object.keys(PIECE_POINTS) as CapturedRole[]) {
    const n = start[role] - current[role];
    if (n > 0) out[role] = n;
  }
  return out;
}

/**
 * Compare the start position against the current one and report, per side,
 * which enemy pieces have been captured plus the net material-point balance.
 * The balance is relative to the start position (a pre-existing imbalance in
 * a custom start counts as zero), so the +x badge reflects what happened in
 * the game, promotions included.
 */
export function computeMaterial(startFen: string, currentFen: string): MaterialSummary {
  const start = countPieces(startFen);
  const current = countPieces(currentFen);

  const capturedByWhite = missing(start.black, current.black);
  const capturedByBlack = missing(start.white, current.white);

  const net =
    pointsOf(current.white) -
    pointsOf(start.white) -
    (pointsOf(current.black) - pointsOf(start.black));

  return {
    capturedByWhite,
    capturedByBlack,
    advantage: net > 0 ? "white" : net < 0 ? "black" : null,
    points: Math.abs(net),
  };
}

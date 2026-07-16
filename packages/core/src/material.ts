// Captured-piece and material-point accounting (pure, no dependencies).
//
// Everything is read from the CURRENT board alone — the start position is
// irrelevant. Each player's tray is the opponent's pieces missing from a full
// standard set (8P 2N 2B 2R 1Q), and the +x badge is the direct material-point
// difference between the two sides on the board. This means a custom start
// (e.g. one fewer white pawn) shows that missing pawn from move one, and a
// capture that only restores balance shows no badge. Per-role missing counts
// are clamped at zero, so a promotion (an extra queen) never renders a negative
// "capture"; the points stay honest because they're a direct board sum.

export type CapturedRole = "pawn" | "knight" | "bishop" | "rook" | "queen";

export type CapturedCounts = Partial<Record<CapturedRole, number>>;

export interface MaterialSummary {
  /** Black pieces missing from the board (i.e. what White has captured). */
  capturedByWhite: CapturedCounts;
  /** White pieces missing from the board (i.e. what Black has captured). */
  capturedByBlack: CapturedCounts;
  /** Side ahead on board material points, or null on ties. */
  advantage: "white" | "black" | null;
  /** Net point difference in favor of `advantage` (0 when tied). */
  points: number;
}

/** A full standard army per side — the reference each tray is measured against. */
const FULL_SET: Record<CapturedRole, number> = {
  pawn: 8,
  knight: 2,
  bishop: 2,
  rook: 2,
  queen: 1,
};

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
 *  yields null (so the caller can show an empty summary instead of reading a
 *  blank board as a full army missing). */
function countPieces(fen: string): SideCounts | null {
  const counts: SideCounts = { white: emptyCounts(), black: emptyCounts() };
  const board = (fen ?? "").trim().split(/\s+/)[0] ?? "";
  if (!BOARD_FIELD.test(board)) return null;
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

/** Per-role pieces missing from a full set (reference minus current), clamped
 *  at zero so an extra promoted piece never produces a negative "capture". */
function missing(
  reference: Record<CapturedRole, number>,
  current: Record<CapturedRole, number>,
): CapturedCounts {
  const out: CapturedCounts = {};
  for (const role of Object.keys(PIECE_POINTS) as CapturedRole[]) {
    const n = reference[role] - current[role];
    if (n > 0) out[role] = n;
  }
  return out;
}

/**
 * Report, from the current board alone, each side's tray (the opponent's
 * pieces missing from a full standard set) and the direct material-point
 * difference. The start position is irrelevant: a custom start's imbalance
 * shows immediately, and a capture that merely restores balance shows no badge.
 */
export function computeMaterial(currentFen: string): MaterialSummary {
  const current = countPieces(currentFen);
  if (!current) {
    return { capturedByWhite: {}, capturedByBlack: {}, advantage: null, points: 0 };
  }

  // White's tray = Black's pieces missing from a full set (and vice versa).
  const capturedByWhite = missing(FULL_SET, current.black);
  const capturedByBlack = missing(FULL_SET, current.white);

  const net = pointsOf(current.white) - pointsOf(current.black);

  return {
    capturedByWhite,
    capturedByBlack,
    advantage: net > 0 ? "white" : net < 0 ? "black" : null,
    points: Math.abs(net),
  };
}

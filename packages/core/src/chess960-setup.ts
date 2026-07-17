// Pure logic for the position editor's Chess960 quick setup (spec 014).
// The editor lets the user place only White's eight rank-1 pieces; these
// helpers validate that placement, complete it into a full Shredder-castling
// FEN (mirrored Black rank, pawns, White to move), and draw a uniformly random
// legal back rank. No React, no DOM — unit-tested in isolation.

import { FILE_NAMES } from "chessops";
import type { Role } from "chessops";

// The eight back-rank pieces are the non-pawn, non-king... actually exactly one
// of each of these, so the multiset is K,Q,R,R,B,B,N,N.
const REQUIRED: Record<string, number> = {
  king: 1,
  queen: 1,
  rook: 2,
  bishop: 2,
  knight: 2,
};

export interface BackRankValidation {
  valid: boolean;
  problem?: string;
}

// A rank-1 back rank as placed by the user: index 0..7 == files a..h, each a
// piece Role or null (not yet placed / erased).
export type BackRankSlots = (Role | null)[];

// Square color of a file on rank 1 (a1 is dark). Bishops must differ.
function isLightSquareFile(fileIndex: number): boolean {
  // a1 (file 0) is dark; light squares are the odd files b,d,f,h.
  return fileIndex % 2 === 1;
}

/**
 * Validate a candidate White back rank. Reports the FIRST unmet rule so the
 * editor can tell the user exactly what to fix, in the order: piece count,
 * bishop square colors, king strictly between the rooks.
 */
export function validate960BackRank(pieces: BackRankSlots): BackRankValidation {
  const counts: Record<string, number> = {};
  for (const role of pieces) {
    if (role === null) continue;
    counts[role] = (counts[role] ?? 0) + 1;
  }
  const countOk =
    pieces.length === 8 &&
    pieces.every((p) => p !== null) &&
    Object.keys(REQUIRED).every((role) => counts[role] === REQUIRED[role]) &&
    Object.keys(counts).every((role) => REQUIRED[role] !== undefined);
  if (!countOk) {
    return {
      valid: false,
      problem:
        "Place exactly one king, one queen, two rooks, two bishops, and two knights on rank 1.",
    };
  }

  const bishopFiles: number[] = [];
  const rookFiles: number[] = [];
  let kingFile = -1;
  pieces.forEach((role, file) => {
    if (role === "bishop") bishopFiles.push(file);
    else if (role === "rook") rookFiles.push(file);
    else if (role === "king") kingFile = file;
  });

  if (isLightSquareFile(bishopFiles[0]) === isLightSquareFile(bishopFiles[1])) {
    return { valid: false, problem: "The two bishops must be on opposite-colored squares." };
  }

  const [r1, r2] = rookFiles;
  if (!(kingFile > Math.min(r1, r2) && kingFile < Math.max(r1, r2))) {
    return { valid: false, problem: "The king must be between the two rooks." };
  }

  return { valid: true };
}

// Shredder castling field for a back rank: the two rook files, White uppercase
// then Black lowercase, higher file first within each color — matching
// game-tree's shredderCastlingFen emit order so create() round-trips it.
function shredderCastling(backRank: Role[]): string {
  const rookFiles: number[] = [];
  backRank.forEach((role, file) => {
    if (role === "rook") rookFiles.push(file);
  });
  rookFiles.sort((a, b) => b - a); // higher file first
  const white = rookFiles.map((f) => FILE_NAMES[f].toUpperCase()).join("");
  const black = rookFiles.map((f) => FILE_NAMES[f]).join("");
  return white + black;
}

const ROLE_LETTER: Record<string, string> = {
  king: "k",
  queen: "q",
  rook: "r",
  bishop: "b",
  knight: "n",
  pawn: "p",
};

/**
 * Complete a valid White back rank into a full Chess960 start FEN: Black's
 * mirrored (same-file) back rank on rank 8, pawns on ranks 2 and 7, empty
 * middle, White to move, Shredder castling letters from the rook files. The
 * caller is expected to pass a back rank that already passed validate960BackRank.
 */
export function complete960Fen(backRank: Role[]): string {
  const whiteRank = backRank.map((r) => ROLE_LETTER[r].toUpperCase()).join("");
  const blackRank = backRank.map((r) => ROLE_LETTER[r]).join("");
  const board = [
    blackRank, // rank 8
    "pppppppp", // rank 7
    "8",
    "8",
    "8",
    "8",
    "PPPPPPPP", // rank 2
    whiteRank, // rank 1
  ].join("/");
  return `${board} w ${shredderCastling(backRank)} - 0 1`;
}

// Draw a uniformly random index in [0, n).
function pick<T>(items: T[], rng: () => number): number {
  return Math.floor(rng() * items.length);
}

/**
 * A uniformly random legal Chess960 back rank, via the standard derivation:
 * a bishop on a random light square, a bishop on a random dark square, the
 * queen on a random remaining square, the knights on a random two of the rest,
 * and King-Rook-... in the leftover three squares (king in the middle, rooks
 * on the ends) — which guarantees the king sits between the rooks. `rng`
 * returns a float in [0, 1) (pass a seeded generator for reproducible draws).
 */
export function random960BackRank(rng: () => number): Role[] {
  const slots: (Role | null)[] = new Array(8).fill(null);

  const lightFiles = [1, 3, 5, 7];
  const darkFiles = [0, 2, 4, 6];
  slots[lightFiles[pick(lightFiles, rng)]] = "bishop";
  slots[darkFiles[pick(darkFiles, rng)]] = "bishop";

  const empty = () => slots.map((s, i) => (s === null ? i : -1)).filter((i) => i >= 0);

  let free = empty();
  slots[free[pick(free, rng)]] = "queen";

  free = empty();
  slots[free[pick(free, rng)]] = "knight";
  free = empty();
  slots[free[pick(free, rng)]] = "knight";

  // Three squares remain: king in the middle, rooks on the ends.
  const [a, b, c] = empty();
  slots[a] = "rook";
  slots[b] = "king";
  slots[c] = "rook";

  return slots as Role[];
}

/**
 * Pure helpers for consensus-based board recognition: parse model replies,
 * diff two placement readings square by square, build a targeted
 * adjudication prompt for the disputed squares, and apply the verdicts.
 * No Tauri imports — unit-testable in Node.
 */

/** Piece placement, optionally followed by the side to move. */
const FEN_RE =
  /\b([rnbqkpRNBQKP1-8]{1,8}(?:\/[rnbqkpRNBQKP1-8]{1,8}){7})(?:\s+([wb])\b)?/g;

export interface Reading {
  placement: string;
  side: "w" | "b" | null;
}

export interface SquareDispute {
  square: string; // e.g. "g7"
  a: string; // FEN letter or "." for empty
  b: string;
}

/** Expand a FEN rank ("2p5") into 8 characters ("..p....."). */
export function expandRank(row: string): string {
  return row.replace(/\d/g, (d) => ".".repeat(Number(d)));
}

/**
 * Expand a FEN rank and force exactly 8 squares. A malformed model rank
 * (digits summing to the wrong count) gets "?" placeholders so the square
 * lands in the dispute list instead of crashing the diff.
 */
function expandTo8(row: string): string {
  return expandRank(row).padEnd(8, "?").slice(0, 8);
}

/** Compress an expanded 8-char rank back to FEN form. */
export function compressRank(row: string): string {
  return row.replace(/\.+/g, (dots) => String(dots.length));
}

function describe(letter: string): string {
  if (letter === ".") return "empty";
  const names: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
  const name = names[letter.toLowerCase()];
  if (!name) return "unreadable";
  const color = letter === letter.toUpperCase() ? "white" : "black";
  return `${color} ${name}`;
}

/**
 * Extract the model's reading from its reply. The reply contains
 * rank-by-rank working notes and possibly corrected intermediate FENs —
 * the final "FEN: ..." line comes last, so take the LAST placement.
 */
export function parseReading(text: string): Reading | null {
  const fenLines = text.split("\n").filter((l) => l.trim().startsWith("FEN:"));
  const source = fenLines.length > 0 ? fenLines[fenLines.length - 1] : text;
  const matches = Array.from(source.matchAll(FEN_RE));
  const m = matches[matches.length - 1];
  if (!m) return null;
  return { placement: m[1], side: (m[2] as "w" | "b" | undefined) ?? null };
}

/** Squares where two placements disagree. */
export function diffSquares(a: string, b: string): SquareDispute[] {
  const ra = a.split("/").map(expandTo8);
  const rb = b.split("/").map(expandTo8);
  const out: SquareDispute[] = [];
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const la = ra[rank][file];
      const lb = rb[rank][file];
      if (la !== lb) {
        out.push({ square: `${"abcdefgh"[file]}${8 - rank}`, a: la, b: lb });
      }
    }
  }
  return out;
}

/** Prompt asking the model to look at ONLY the disputed squares. */
export function buildTiebreakPrompt(disputes: SquareDispute[], askTurn: boolean): string {
  const lines = disputes
    .map((d) => `- ${d.square}: reading A says ${describe(d.a)}, reading B says ${describe(d.b)}`)
    .join("\n");
  const squares = disputes.map((d) => d.square).join(", ");
  return (
    "This image is a screenshot of a chess position. Two independent transcriptions of it " +
    "disagree about a few squares:\n" +
    `${lines}\n` +
    `Look very carefully at ONLY those squares in the image (${squares}), one at a time, and ` +
    "say what is actually on each. Anchor each file and rank against the board coordinates " +
    "and neighboring pieces before deciding." +
    (askTurn
      ? " The transcriptions also disagree about whose turn it is — if a last move is highlighted, use it; otherwise assume white to move."
      : "") +
    "\nThen give the verdict as a single last line, using the FEN letter of the piece " +
    "(K Q R B N P for white, k q r b n p for black) or the word empty:\n" +
    "SQUARES: " +
    disputes.map((d) => `${d.square}=<letter or empty>`).join(", ") +
    (askTurn ? "; TURN: <w or b>" : "")
  );
}

/** Apply adjudicated square contents onto a base placement. */
export function applyVerdicts(base: string, disputes: SquareDispute[], verdictText: string): string {
  const ranks = base.split("/").map((r) => expandTo8(r).split(""));
  for (const d of disputes) {
    const re = new RegExp(`${d.square}\\s*=\\s*([pnbrqkPNBRQK]|empty)`, "g");
    const ms = Array.from(verdictText.matchAll(re));
    if (ms.length === 0) continue; // no verdict — keep reading A's value
    const v = ms[ms.length - 1][1];
    const letter = v === "empty" ? "." : v;
    const file = d.square.charCodeAt(0) - 97;
    const rank = 8 - Number(d.square[1]);
    ranks[rank][file] = letter;
  }
  // Any leftover unreadable squares become empty; validation catches the rest.
  return ranks.map((r) => compressRank(r.join("").replace(/\?/g, "."))).join("/");
}

/** Extract the TURN verdict from an adjudication reply, if present. */
export function parseTurnVerdict(text: string): "w" | "b" | null {
  const ms = Array.from(text.matchAll(/TURN:\s*([wb])\b/g));
  return ms.length > 0 ? (ms[ms.length - 1][1] as "w" | "b") : null;
}

/**
 * Castling rights derived from the placement alone: granted only when king
 * and rook stand on their standard home squares. Chess960 castling isn't
 * supported by the app, so unusual setups simply get "-".
 */
export function homeSquareCastling(placement: string): string {
  const ranks = placement.split("/");
  const r1 = expandRank(ranks[7]);
  const r8 = expandRank(ranks[0]);
  let rights = "";
  if (r1[4] === "K") {
    if (r1[7] === "R") rights += "K";
    if (r1[0] === "R") rights += "Q";
  }
  if (r8[4] === "k") {
    if (r8[7] === "r") rights += "k";
    if (r8[0] === "r") rights += "q";
  }
  return rights || "-";
}

// Material-signature search keys (spec 200) — the TS mirror of the Rust
// helpers in src-tauri/src/db.rs. A signature is per side "K" then
// "Q"/"R"/"B"/"N"/"P" repeated per piece on the board, White's half first —
// e.g. a rook-and-pawn-vs-rook ending is "KRPKR". Pure, no dependencies;
// shared by the database mock, the filter-bar hint, and unit tests.

const ORDER = "KQRBNP";

/** A FEN board field: 8 rank groups of piece letters / digits (same guard as
 *  material.ts — junk must not miscount as pieces). */
const BOARD_FIELD = /^[pnbrqkPNBRQK1-8]+(\/[pnbrqkPNBRQK1-8]+){7}$/;

function emit(counts: number[]): string {
  let out = "";
  for (let i = 0; i < ORDER.length; i++) out += ORDER[i].repeat(counts[i]);
  return out;
}

/**
 * Material signature of a FEN's board, or null when the board field is
 * malformed. Matches the Rust `material_signature` byte for byte.
 */
export function materialSignatureFromFen(fen: string): string | null {
  const board = (fen ?? "").trim().split(/\s+/)[0] ?? "";
  if (!BOARD_FIELD.test(board)) return null;
  const white = [0, 0, 0, 0, 0, 0];
  const black = [0, 0, 0, 0, 0, 0];
  for (const ch of board) {
    const i = ORDER.indexOf(ch.toUpperCase());
    if (i < 0) continue; // digits, '/'
    (ch === ch.toUpperCase() ? white : black)[i] += 1;
  }
  return emit(white) + emit(black);
}

/** Canonicalize one side's piece run; null on non-piece chars or >1 king. */
function canonSide(side: string): string | null {
  const counts = [0, 0, 0, 0, 0, 0];
  for (const ch of side) {
    const i = ORDER.indexOf(ch);
    if (i < 0) return null;
    counts[i] += 1;
  }
  if (counts[0] === 0) counts[0] = 1; // "RP v R" means "KRP vs KR"
  if (counts[0] !== 1) return null;
  return emit(counts);
}

/**
 * Parse a material-search query into its canonical signature plus the
 * colour-flipped one. Accepts "KRP vs KR", "krp-kr", "RP v R", "KRPKR"…:
 * case-insensitive, any piece order, kings implied when omitted, sides split
 * by any non-piece characters (or at the second king when written as one
 * token). Null when the input isn't a material description. Mirrors the Rust
 * `parse_material_query`.
 */
export function parseMaterialQuery(
  input: string,
): { signature: string; flipped: string } | null {
  const upper = (input ?? "").trim().toUpperCase();
  // Piece letters never include the separators ("VS", "-", "/", space…), so
  // splitting on any non-piece character isolates the two sides.
  const sides = upper.split(/[^KQRBNP]+/).filter((s) => s.length > 0);
  let a: string;
  let b: string;
  if (sides.length === 1) {
    // One run like "KRPKR": unambiguous only with exactly two kings.
    const t = sides[0];
    const ks = [...t].flatMap((c, i) => (c === "K" ? [i] : []));
    if (ks.length !== 2) return null;
    a = t.slice(0, ks[1]);
    b = t.slice(ks[1]);
  } else if (sides.length === 2) {
    [a, b] = sides;
  } else {
    return null;
  }
  const ca = canonSide(a);
  const cb = canonSide(b);
  if (ca === null || cb === null) return null;
  return { signature: ca + cb, flipped: cb + ca };
}

// ECO → opening-name lookup (spec 200: "opening-name lookup … needs an
// ECO→name table") and FEN → ECO classification (spec 212: the seed/opening
// breakdown's "ECO where known" arm).
//
// Compact range table instead of 500 individual rows: each entry names the
// opening family starting at that code, and a code resolves to the nearest
// entry at or below it (binary search). Granularity follows common usage —
// famous variations (Najdorf, Dragon, Marshall, …) get their own row; thin
// sub-splits share the family name. Sources: standard ECO classification
// (Encyclopaedia of Chess Openings volumes A–E).

import { Chess } from "chessops/chess"
import { makeFen } from "chessops/fen"
import { parseSan } from "chessops/san"

/** [first code of range, opening name] — MUST stay sorted by code. */
const ECO_RANGES: ReadonlyArray<readonly [string, string]> = [
  ["A00", "Irregular Openings"],
  ["A01", "Nimzo-Larsen Attack"],
  ["A02", "Bird's Opening"],
  ["A04", "Réti Opening"],
  ["A07", "King's Indian Attack"],
  ["A09", "Réti Opening"],
  ["A10", "English Opening"],
  ["A16", "English Opening, Anglo-Indian"],
  ["A20", "English Opening, King's English"],
  ["A30", "English Opening, Symmetrical"],
  ["A40", "Queen's Pawn Game"],
  ["A43", "Old Benoni"],
  ["A45", "Indian Defence"],
  ["A47", "Queen's Indian Defence (without c4)"],
  ["A48", "East Indian / London System"],
  ["A50", "Indian Defence, Atypical"],
  ["A51", "Budapest Gambit"],
  ["A53", "Old Indian Defence"],
  ["A56", "Benoni Defence"],
  ["A57", "Benko Gambit"],
  ["A60", "Modern Benoni"],
  ["A80", "Dutch Defence"],
  ["A87", "Dutch Defence, Leningrad"],
  ["A90", "Dutch Defence, Classical"],
  ["B00", "King's Pawn, Uncommon Defences"],
  ["B01", "Scandinavian Defence"],
  ["B02", "Alekhine's Defence"],
  ["B06", "Modern Defence"],
  ["B07", "Pirc Defence"],
  ["B10", "Caro-Kann Defence"],
  ["B12", "Caro-Kann, Advance"],
  ["B13", "Caro-Kann, Exchange"],
  ["B14", "Caro-Kann, Panov-Botvinnik"],
  ["B15", "Caro-Kann, Main Line"],
  ["B20", "Sicilian Defence"],
  ["B22", "Sicilian, Alapin"],
  ["B23", "Sicilian, Closed"],
  ["B27", "Sicilian Defence"],
  ["B30", "Sicilian, Old Sicilian"],
  ["B31", "Sicilian, Rossolimo"],
  ["B32", "Sicilian Defence"],
  ["B33", "Sicilian, Sveshnikov"],
  ["B34", "Sicilian, Accelerated Dragon"],
  ["B40", "Sicilian Defence"],
  ["B41", "Sicilian, Kan"],
  ["B44", "Sicilian, Taimanov"],
  ["B50", "Sicilian Defence"],
  ["B51", "Sicilian, Moscow (Bb5+)"],
  ["B52", "Sicilian, Moscow (Bb5+)"],
  ["B53", "Sicilian Defence"],
  ["B60", "Sicilian, Richter-Rauzer"],
  ["B70", "Sicilian, Dragon"],
  ["B80", "Sicilian, Scheveningen"],
  ["B90", "Sicilian, Najdorf"],
  ["C00", "French Defence"],
  ["C02", "French, Advance"],
  ["C03", "French, Tarrasch"],
  ["C10", "French, Classical"],
  ["C15", "French, Winawer"],
  ["C20", "King's Pawn Game"],
  ["C21", "Centre Game"],
  ["C23", "Bishop's Opening"],
  ["C25", "Vienna Game"],
  ["C30", "King's Gambit"],
  ["C40", "King's Knight Opening"],
  ["C41", "Philidor Defence"],
  ["C42", "Petrov's Defence"],
  ["C44", "King's Pawn Game"],
  ["C45", "Scotch Game"],
  ["C46", "Three Knights Game"],
  ["C47", "Four Knights Game"],
  ["C50", "Italian Game"],
  ["C51", "Evans Gambit"],
  ["C53", "Giuoco Piano"],
  ["C55", "Two Knights Defence"],
  ["C60", "Ruy Lopez"],
  ["C63", "Ruy Lopez, Schliemann"],
  ["C64", "Ruy Lopez, Classical"],
  ["C65", "Ruy Lopez, Berlin"],
  ["C68", "Ruy Lopez, Exchange"],
  ["C70", "Ruy Lopez"],
  ["C77", "Ruy Lopez, Morphy Defence"],
  ["C80", "Ruy Lopez, Open"],
  ["C84", "Ruy Lopez, Closed"],
  ["C89", "Ruy Lopez, Marshall Attack"],
  ["C90", "Ruy Lopez, Closed"],
  ["C96", "Ruy Lopez, Closed, Chigorin"],
  ["D00", "Queen's Pawn Game"],
  ["D02", "London System"],
  ["D04", "Colle System"],
  ["D06", "Queen's Gambit Declined"],
  ["D07", "QGD, Chigorin Defence"],
  ["D08", "Albin Countergambit"],
  ["D10", "Slav Defence"],
  ["D16", "Slav Defence, Main Line"],
  ["D20", "Queen's Gambit Accepted"],
  ["D30", "Queen's Gambit Declined"],
  ["D35", "QGD, Exchange"],
  ["D37", "Queen's Gambit Declined"],
  ["D43", "Semi-Slav Defence"],
  ["D47", "Semi-Slav, Meran"],
  ["D50", "QGD, Classical"],
  ["D53", "QGD, Orthodox"],
  ["D60", "QGD, Orthodox Defence"],
  ["D70", "Grünfeld Defence"],
  ["D80", "Grünfeld Defence"],
  ["D85", "Grünfeld, Exchange"],
  ["D90", "Grünfeld Defence"],
  ["E00", "Catalan Opening"],
  ["E10", "Blumenfeld / Anti-Indian"],
  ["E11", "Bogo-Indian Defence"],
  ["E12", "Queen's Indian Defence"],
  ["E20", "Nimzo-Indian Defence"],
  ["E32", "Nimzo-Indian, Classical"],
  ["E40", "Nimzo-Indian, Rubinstein"],
  ["E60", "King's Indian Defence"],
  ["E70", "King's Indian Defence"],
  ["E80", "King's Indian, Sämisch"],
  ["E90", "King's Indian, Classical"],
  ["E97", "King's Indian, Mar del Plata"],
] as const

/** True for the "A00".."E99" shape (case-insensitive; trims whitespace). */
function normalize(code: string): string | null {
  const c = code.trim().toUpperCase()
  return /^[A-E][0-9]{2}$/.test(c) ? c : null
}

/**
 * Opening-family name for an ECO code ("B90" → "Sicilian, Najdorf").
 * Returns null for malformed codes; unmatched valid codes resolve to the
 * nearest family at or below them, so every A00–E99 code gets a name.
 */
export function ecoName(code: string): string | null {
  const c = normalize(code)
  if (!c) return null
  // Binary search: greatest range start <= c (table is sorted).
  let lo = 0
  let hi = ECO_RANGES.length - 1
  if (c < ECO_RANGES[0][0]) return null
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ECO_RANGES[mid][0] <= c) lo = mid
    else hi = mid - 1
  }
  return ECO_RANGES[lo][1]
}

/** "B90 · Sicilian, Najdorf" or just the code when unknown/malformed. */
export function ecoLabel(code: string): string {
  const name = ecoName(code)
  return name ? `${code.trim().toUpperCase()} · ${name}` : code
}

/**
 * Whether an ECO code matches a user filter query (spec 210 Phase 6 "filter
 * by ECO code, opening family"). Two query shapes:
 *
 * - A code prefix — "B", "B9", "B90" — matches codes starting with it.
 * - Anything else is an opening-NAME substring, matched (case-insensitively)
 *   against the code's family name from [`ecoName`] — "najdorf", "sicilian".
 *
 * An empty/whitespace query matches everything (no filter). A missing or
 * malformed code matches nothing once a query is set — untagged positions
 * are excluded rather than silently passed through.
 */
export function matchesEcoQuery(code: string | null | undefined, query: string): boolean {
  const q = query.trim()
  if (q === "") return true
  const c = code == null ? null : normalize(code)
  if (!c) return false
  const upper = q.toUpperCase()
  if (/^[A-E][0-9]{0,2}$/.test(upper)) return c.startsWith(upper)
  const name = ecoName(c)
  return name !== null && name.toLowerCase().includes(q.toLowerCase())
}

// ---------------------------------------------------------------------------
// FEN → ECO classification (spec 212 seed/opening breakdown "ECO where known")
// ---------------------------------------------------------------------------

/**
 * [ECO code, defining move sequence in SAN]. One entry per coded line the
 * table covers — every ECO_RANGES family gets its defining line, plus finer
 * codes (they resolve to the family name via ecoName). The lookup keys the
 * RESULTING position, not the move order, so transpositions classify
 * correctly. SANs are replayed through chessops at first use (buildEcoTable),
 * so a typo here breaks loudly in the unit test, never as a wrong FEN.
 */
export const ECO_LINES: ReadonlyArray<readonly [string, string]> = [
  // A: flank + queen's pawn without 2.c4 e6/g6 complexes
  ["A00", "g4"],
  ["A00", "b4"],
  ["A00", "Nc3"],
  ["A01", "b3"],
  ["A02", "f4"],
  ["A03", "f4 d5"],
  ["A04", "Nf3"],
  ["A05", "Nf3 Nf6"],
  ["A07", "Nf3 d5 g3"],
  ["A09", "Nf3 d5 c4"],
  ["A10", "c4"],
  ["A13", "c4 e6"],
  ["A15", "c4 Nf6"],
  ["A16", "c4 Nf6 Nc3"],
  ["A20", "c4 e5"],
  ["A22", "c4 e5 Nc3 Nf6"],
  ["A30", "c4 c5"],
  ["A34", "c4 c5 Nc3"],
  ["A40", "d4"],
  ["A41", "d4 d6"],
  ["A43", "d4 c5"],
  ["A45", "d4 Nf6"],
  ["A45", "d4 Nf6 Bg5"],
  ["A46", "d4 Nf6 Nf3"],
  ["A47", "d4 Nf6 Nf3 b6"],
  ["A48", "d4 Nf6 Nf3 g6"],
  ["A50", "d4 Nf6 c4"],
  ["A51", "d4 Nf6 c4 e5"],
  ["A52", "d4 Nf6 c4 e5 dxe5 Ng4"],
  ["A53", "d4 Nf6 c4 d6"],
  ["A56", "d4 Nf6 c4 c5"],
  ["A57", "d4 Nf6 c4 c5 d5 b5"],
  ["A58", "d4 Nf6 c4 c5 d5 b5 cxb5 a6 bxa6"],
  ["A60", "d4 Nf6 c4 c5 d5 e6"],
  ["A61", "d4 Nf6 c4 c5 d5 e6 Nc3 exd5 cxd5 d6"],
  ["A80", "d4 f5"],
  ["A84", "d4 f5 c4"],
  ["A87", "d4 f5 c4 Nf6 g3 g6 Bg2 Bg7 Nf3"],
  ["A90", "d4 f5 c4 Nf6 g3 e6 Bg2 Be7"],
  // B: 1.e4 minus 1...e5 / 1...e6
  ["B00", "e4"],
  ["B00", "e4 Nc6"],
  ["B00", "e4 b6"],
  ["B01", "e4 d5"],
  ["B01", "e4 d5 exd5 Qxd5 Nc3 Qa5"],
  ["B02", "e4 Nf6"],
  ["B03", "e4 Nf6 e5 Nd5 d4 d6"],
  ["B06", "e4 g6"],
  ["B06", "e4 g6 d4 Bg7"],
  ["B07", "e4 d6"],
  ["B07", "e4 d6 d4 Nf6 Nc3"],
  ["B10", "e4 c6"],
  ["B12", "e4 c6 d4 d5 e5"],
  ["B13", "e4 c6 d4 d5 exd5 cxd5"],
  ["B14", "e4 c6 d4 d5 exd5 cxd5 c4 Nf6 Nc3 e6"],
  ["B15", "e4 c6 d4 d5 Nc3"],
  ["B18", "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5"],
  ["B20", "e4 c5"],
  ["B22", "e4 c5 c3"],
  ["B23", "e4 c5 Nc3"],
  ["B27", "e4 c5 Nf3"],
  ["B30", "e4 c5 Nf3 Nc6"],
  ["B31", "e4 c5 Nf3 Nc6 Bb5 g6"],
  ["B32", "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4"],
  ["B33", "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5"],
  ["B34", "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6"],
  ["B40", "e4 c5 Nf3 e6"],
  ["B41", "e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6"],
  ["B44", "e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6"],
  ["B50", "e4 c5 Nf3 d6"],
  ["B51", "e4 c5 Nf3 d6 Bb5+"],
  ["B52", "e4 c5 Nf3 d6 Bb5+ Bd7"],
  ["B53", "e4 c5 Nf3 d6 d4 cxd4 Qxd4"],
  ["B54", "e4 c5 Nf3 d6 d4 cxd4 Nxd4"],
  ["B56", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3"],
  ["B60", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6 Bg5"],
  ["B70", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6"],
  ["B80", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 e6"],
  ["B90", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6"],
  // C: French + 1.e4 e5
  ["C00", "e4 e6"],
  ["C01", "e4 e6 d4 d5 exd5 exd5"],
  ["C02", "e4 e6 d4 d5 e5"],
  ["C03", "e4 e6 d4 d5 Nd2"],
  ["C05", "e4 e6 d4 d5 Nd2 Nf6"],
  ["C10", "e4 e6 d4 d5 Nc3"],
  ["C11", "e4 e6 d4 d5 Nc3 Nf6"],
  ["C15", "e4 e6 d4 d5 Nc3 Bb4"],
  ["C18", "e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3"],
  ["C20", "e4 e5"],
  ["C21", "e4 e5 d4 exd4"],
  ["C23", "e4 e5 Bc4"],
  ["C25", "e4 e5 Nc3"],
  ["C30", "e4 e5 f4"],
  ["C33", "e4 e5 f4 exf4"],
  ["C40", "e4 e5 Nf3"],
  ["C41", "e4 e5 Nf3 d6"],
  ["C42", "e4 e5 Nf3 Nf6"],
  ["C44", "e4 e5 Nf3 Nc6"],
  ["C45", "e4 e5 Nf3 Nc6 d4 exd4 Nxd4"],
  ["C46", "e4 e5 Nf3 Nc6 Nc3"],
  ["C47", "e4 e5 Nf3 Nc6 Nc3 Nf6"],
  ["C50", "e4 e5 Nf3 Nc6 Bc4"],
  ["C50", "e4 e5 Nf3 Nc6 Bc4 Bc5"],
  ["C51", "e4 e5 Nf3 Nc6 Bc4 Bc5 b4"],
  ["C53", "e4 e5 Nf3 Nc6 Bc4 Bc5 c3"],
  ["C55", "e4 e5 Nf3 Nc6 Bc4 Nf6"],
  ["C57", "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5"],
  ["C60", "e4 e5 Nf3 Nc6 Bb5"],
  ["C63", "e4 e5 Nf3 Nc6 Bb5 f5"],
  ["C64", "e4 e5 Nf3 Nc6 Bb5 Bc5"],
  ["C65", "e4 e5 Nf3 Nc6 Bb5 Nf6"],
  ["C67", "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4"],
  ["C68", "e4 e5 Nf3 Nc6 Bb5 a6 Bxc6"],
  ["C70", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4"],
  ["C77", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6"],
  ["C78", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O"],
  ["C80", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Nxe4"],
  ["C84", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7"],
  ["C88", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 O-O"],
  ["C89", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 O-O c3 d5"],
  ["C90", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O"],
  ["C92", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3"],
  ["C96", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5"],
  // D: 1.d4 d5 + Grünfeld
  ["D00", "d4 d5"],
  ["D02", "d4 d5 Nf3"],
  ["D02", "d4 d5 Nf3 Nf6 Bf4"],
  ["D04", "d4 d5 Nf3 Nf6 e3"],
  ["D06", "d4 d5 c4"],
  ["D07", "d4 d5 c4 Nc6"],
  ["D08", "d4 d5 c4 e5"],
  ["D10", "d4 d5 c4 c6"],
  ["D11", "d4 d5 c4 c6 Nf3"],
  ["D15", "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4"],
  ["D16", "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4"],
  ["D17", "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5"],
  ["D20", "d4 d5 c4 dxc4"],
  ["D30", "d4 d5 c4 e6"],
  ["D31", "d4 d5 c4 e6 Nc3"],
  ["D32", "d4 d5 c4 e6 Nc3 c5"],
  ["D35", "d4 d5 c4 e6 Nc3 Nf6 cxd5 exd5"],
  ["D37", "d4 d5 c4 e6 Nc3 Nf6 Nf3 Be7"],
  ["D43", "d4 d5 c4 e6 Nc3 Nf6 Nf3 c6"],
  ["D45", "d4 d5 c4 e6 Nc3 Nf6 Nf3 c6 e3"],
  ["D47", "d4 d5 c4 e6 Nc3 Nf6 Nf3 c6 e3 Nbd7 Bd3 dxc4 Bxc4 b5"],
  ["D50", "d4 d5 c4 e6 Nc3 Nf6 Bg5"],
  ["D53", "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7"],
  ["D60", "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 Nbd7"],
  ["D80", "d4 Nf6 c4 g6 Nc3 d5"],
  ["D85", "d4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7"],
  ["D90", "d4 Nf6 c4 g6 Nc3 d5 Nf3 Bg7"],
  // E: 1.d4 Nf6 2.c4 e6/g6
  ["E00", "d4 Nf6 c4 e6"],
  ["E00", "d4 Nf6 c4 e6 g3"],
  ["E01", "d4 Nf6 c4 e6 g3 d5 Bg2"],
  ["E04", "d4 Nf6 c4 e6 g3 d5 Bg2 dxc4 Nf3"],
  ["E06", "d4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3"],
  ["E10", "d4 Nf6 c4 e6 Nf3"],
  ["E11", "d4 Nf6 c4 e6 Nf3 Bb4+"],
  ["E12", "d4 Nf6 c4 e6 Nf3 b6"],
  ["E15", "d4 Nf6 c4 e6 Nf3 b6 g3"],
  ["E20", "d4 Nf6 c4 e6 Nc3 Bb4"],
  ["E32", "d4 Nf6 c4 e6 Nc3 Bb4 Qc2"],
  ["E40", "d4 Nf6 c4 e6 Nc3 Bb4 e3"],
  ["E60", "d4 Nf6 c4 g6"],
  ["E61", "d4 Nf6 c4 g6 Nc3"],
  ["E70", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6"],
  ["E80", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f3"],
  ["E90", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3"],
  ["E92", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5"],
  ["E97", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7"],
] as const

/**
 * Position key for the ECO lookup: board + side-to-move + castling rights.
 * The en-passant field and both counters are dropped — different sources
 * disagree on whether a double push writes the ep square when no capture is
 * possible, move numbers differ under transposition, and no two coded lines
 * are distinguished by en passant alone.
 */
function fenEcoKey(fen: string): string | null {
  const parts = fen.trim().split(/\s+/)
  if (parts.length < 2 || parts[0].split("/").length !== 8) return null
  return `${parts[0]} ${parts[1]} ${parts[2] ?? "-"}`
}

// Built lazily on first classification: ~150 short SAN replays (<10ms), paid
// only by callers that actually classify. Deeper lines win a shared key.
let ecoTable: Map<string, { code: string; ply: number }> | null = null

function buildEcoTable(): Map<string, { code: string; ply: number }> {
  const table = new Map<string, { code: string; ply: number }>()
  for (const [code, sans] of ECO_LINES) {
    const chess = Chess.default()
    let ply = 0
    let legal = true
    for (const san of sans.split(" ")) {
      const move = parseSan(chess, san)
      if (!move) {
        legal = false
        break
      }
      chess.play(move)
      ply++
    }
    // An illegal SAN is a table typo; skip the entry here (the eco unit test
    // replays every line and fails loudly on exactly this).
    if (!legal) continue
    const key = fenEcoKey(makeFen(chess.toSetup()))
    if (!key) continue
    const prev = table.get(key)
    if (!prev || ply > prev.ply) table.set(key, { code, ply })
  }
  return table
}

/**
 * ECO code for a position ("B90" for the Najdorf tabiya), or null when the
 * position is not one of the coded lines. Move-order independent: any legal
 * sequence reaching a coded position classifies.
 */
export function ecoForFen(fen: string): string | null {
  const key = fenEcoKey(fen)
  if (!key) return null
  ecoTable ??= buildEcoTable()
  return ecoTable.get(key)?.code ?? null
}

/**
 * ECO code for a game given its position sequence (root first): the DEEPEST
 * position that matches a coded line — the standard "last book position"
 * classification. Null when no position matches (e.g. a non-standard start).
 */
export function ecoForFens(fens: readonly string[]): string | null {
  ecoTable ??= buildEcoTable()
  for (let i = fens.length - 1; i >= 0; i--) {
    const key = fenEcoKey(fens[i])
    const hit = key ? ecoTable.get(key) : undefined
    if (hit) return hit.code
  }
  return null
}

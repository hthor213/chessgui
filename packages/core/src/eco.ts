// ECO → opening-name lookup (spec 200: "opening-name lookup … needs an
// ECO→name table").
//
// Compact range table instead of 500 individual rows: each entry names the
// opening family starting at that code, and a code resolves to the nearest
// entry at or below it (binary search). Granularity follows common usage —
// famous variations (Najdorf, Dragon, Marshall, …) get their own row; thin
// sub-splits share the family name. Sources: standard ECO classification
// (Encyclopaedia of Chess Openings volumes A–E).

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

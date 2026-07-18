// Player identity (spec 225 follow-on): the small list of names/aliases that
// are "me" — full name, chess.com username, whatever a game's White/Black
// header might carry. Its one job is orientation: when a loaded game names the
// user on exactly one side, the board flips so the user's pieces sit at the
// bottom. Pure half only — the names persist through the StorageProvider KV
// (apps/desktop/lib/identity.ts), the same seam every setting uses.

/** The persisted document shape (one tiny JSON blob under a storage key). */
export interface IdentityStore {
  v: 1
  names: string[]
}

export function emptyIdentityStore(): IdentityStore {
  return { v: 1, names: [] }
}

/** Case/space-insensitive comparison key for a player name. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/** De-duplicate (by normalized key) and drop blanks, preserving order and the
 *  first-seen display casing. */
export function cleanNames(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names) {
    const display = raw.trim()
    const key = normalizeName(display)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(display)
  }
  return out
}

/** Rebuild the name list from raw JSON. Corrupt or missing data yields an
 *  empty list — identity must never wedge a load path. */
export function parseIdentityStore(raw: string | null | undefined): IdentityStore {
  if (!raw) return emptyIdentityStore()
  try {
    const parsed = JSON.parse(raw)
    if (parsed && parsed.v === 1 && Array.isArray(parsed.names)) {
      return { v: 1, names: cleanNames(parsed.names.filter((n: unknown) => typeof n === "string")) }
    }
  } catch {
    /* corrupt store — start fresh */
  }
  return emptyIdentityStore()
}

/** Whether a header value names a real player — not blank, not the "?"
 *  placeholder the PGN standard uses for an unknown name. */
export function isNamedPlayer(value: string | undefined): boolean {
  const trimmed = (value ?? "").trim()
  return trimmed !== "" && trimmed !== "?"
}

/** True when the PGN's very first non-space content is a bracketed tag pair
 *  (`[Tag "value"]`) — used to decide the separator when prepending headers.
 *  Deliberately narrow so a bracketed move comment like `{[%clk ...]}` never
 *  looks like a header. */
function startsWithTagLine(pgn: string): boolean {
  return /^\s*\[[A-Za-z][A-Za-z0-9_]*\s+"[^"]*"\]/.test(pgn)
}

/**
 * Fill in a PGN's White/Black headers from known player names when they are
 * missing or placeholder ("?"), leaving real values untouched. Used when
 * archiving a fair-play game (spec 219 D) so a later load can orient the board
 * to the user's side by identity — a fetched chess.com PGN already carries the
 * real usernames, so this only rescues a header-less pasted game.
 *
 * The header regexes are line-anchored so a bracketed move comment
 * (`{[%clk ...]}`) can never be mistaken for a tag, missing tags are prepended
 * at the very top (never spliced at the first "["), and the replacement is a
 * function so `$&`/`$'` inside a name can't expand as a replacement pattern.
 */
export function ensurePlayerHeaders(
  pgn: string,
  players: { white?: string; black?: string },
): string {
  let out = pgn
  const inserts: string[] = []
  for (const tag of ["White", "Black"] as const) {
    const desired = (tag === "White" ? players.white : players.black)?.trim()
    if (!desired) continue
    const tagLine = `[${tag} "${desired.replace(/"/g, "'")}"]`
    const re = new RegExp(`^\\[${tag}\\s+"([^"]*)"\\]`, "m")
    const match = out.match(re)
    if (match) {
      if (!isNamedPlayer(match[1])) out = out.replace(re, () => tagLine)
    } else {
      inserts.push(tagLine)
    }
  }
  if (inserts.length > 0) {
    const separator = startsWithTagLine(out) ? "\n" : "\n\n"
    out = inserts.join("\n") + separator + out.replace(/^\s+/, "")
  }
  return out
}

/**
 * Which side the user is on for a game with these headers, or null when it
 * can't be told. Returns a side ONLY when exactly one of White/Black matches
 * an identity name (case-insensitively) — a match on both (or neither) is
 * ambiguous and leaves orientation untouched, so the app never fights a
 * deliberate flip.
 */
export function matchMyColor(
  headers: { White?: string; Black?: string } | Record<string, string>,
  names: string[],
): "white" | "black" | null {
  const keys = new Set(names.map(normalizeName).filter(Boolean))
  if (keys.size === 0) return null
  const white = normalizeName(headers.White ?? "")
  const black = normalizeName(headers.Black ?? "")
  const whiteIsMe = white !== "" && keys.has(white)
  const blackIsMe = black !== "" && keys.has(black)
  if (whiteIsMe && !blackIsMe) return "white"
  if (blackIsMe && !whiteIsMe) return "black"
  return null
}

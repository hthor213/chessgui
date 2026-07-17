// chess.com Published-Data API client (spec 219 "Game finished").
//
// Read-only, no auth. Etiquette per the chess.com Help Center: requests are
// SERIAL (parallel fetches may 429) and carry a descriptive User-Agent.
// Server-side data is cached 12–24h, so a game that just ended may not be in
// the archive yet — callers must treat "not-found" as "retry later", never
// as license to lift the engine lockout.
//
// Pure module: the fetch implementation is injectable so shells can route it
// (and tests can mock it). Field names follow the official announcement page
// and were not hand-verified by a live call when this was written — smoke-
// test against a real account before trusting the parser (spec 219 How).

export const CHESSCOM_API_BASE = "https://api.chess.com/pub"

/** Descriptive User-Agent per chess.com API etiquette. Browsers strip the
 *  header (it's a forbidden name); shells that can set it, do. */
export const CHESSCOM_USER_AGENT =
  "ChessGUI/0.1 (open-source chess GUI; fair-play active-game archiving; +https://github.com/hthor213/chessgui)"

/** One side of a finished game as the month archive reports it. */
export interface ChesscomPlayer {
  username: string
  rating?: number
  result?: string
}

/** A finished game from `/player/{user}/games/{YYYY}/{MM}`. Only the fields
 *  this feature reads; extra fields pass through untyped. */
export interface ChesscomGame {
  url: string
  pgn?: string
  /** Epoch seconds. */
  end_time?: number
  time_class?: string
  /** chess.com variant: "chess", "chess960", "kingofthehill", … The app's
   *  database and board replay only support standard chess today, so import
   *  callers MUST branch on this — a Chess960 game imports as 0 plies /
   *  errors silently otherwise (user-reported 2026-07-17). */
  rules?: string
  white: ChesscomPlayer
  black: ChesscomPlayer
}

/** The canonical game URL when `text` is (only) a chess.com game link —
 *  tolerates whitespace and share-link query params; null when the text is
 *  anything else (i.e. plausibly actual PGN). Lets paste boxes catch a URL
 *  before handing it to the PGN parser (user-reported 2026-07-17: a pasted
 *  share URL produced a bare "failed to load game"). */
export function chesscomGameUrl(text: string): string | null {
  const m = text
    .trim()
    .match(/^https?:\/\/(?:www\.)?chess\.com\/game\/(daily|live)\/(\d+)(?:[?#]\S*)?$/i)
  if (!m) return null
  return `https://www.chess.com/game/${m[1].toLowerCase()}/${m[2]}`
}

interface ArchivesResponse {
  archives: string[]
}

interface MonthResponse {
  games: ChesscomGame[]
}

/** Minimal structural fetch so tests inject a mock and shells can reroute. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface FinishedGameQuery {
  /** The chess.com account the user played the game on (per active game). */
  username: string
  /** Exact-match key when the user stored the game URL at setup time. */
  gameUrl?: string | null
  /** Opponent username/name for the heuristic match when no URL is stored. */
  opponent?: string | null
  /** Epoch ms lower bound (typically the flaggedAt timestamp) — heuristic
   *  candidates must have ended at or after this. */
  since?: number | null
  /** How many months to scan, newest first (default 3 — daily games run
   *  long, but the finished game lands in its end month). */
  maxMonths?: number
  fetchFn?: FetchLike
  userAgent?: string
}

export type FinishedGameFetchResult =
  /** Unambiguous match (stored game URL) — safe to archive directly. */
  | { status: "matched"; game: ChesscomGame; pgn: string }
  /** Heuristic (opponent/date) candidates — the user must confirm one
   *  before anything is archived (spec 219 How). */
  | { status: "needs-confirmation"; candidates: ChesscomGame[] }
  /** Nothing matched — likely the 12–24h archive cache; retry later or
   *  paste the PGN manually. The game stays active and locked. */
  | { status: "not-found" }
  /** Network / HTTP failure. The game stays active and locked. */
  | { status: "error"; message: string }

/** Trailing-slash- and case-insensitive URL comparison key. */
function urlKey(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase()
}

function isFinishedGame(value: unknown): value is ChesscomGame {
  const g = value as ChesscomGame
  return (
    typeof g === "object" &&
    g !== null &&
    typeof g.url === "string" &&
    typeof g.white?.username === "string" &&
    typeof g.black?.username === "string"
  )
}

/** Cap on heuristic candidates surfaced for confirmation. */
const MAX_CANDIDATES = 10

/**
 * Find a finished game in the player's public archives: newest months first,
 * one request at a time. With a stored `gameUrl` the match is exact; without
 * one, opponent/date candidates are returned for user confirmation. Never
 * throws — every failure mode is a result variant so the caller's "stays
 * locked" handling is uniform.
 */
export async function fetchFinishedGame(
  query: FinishedGameQuery,
): Promise<FinishedGameFetchResult> {
  const {
    username,
    gameUrl = null,
    opponent = null,
    since = null,
    maxMonths = 3,
    userAgent = CHESSCOM_USER_AGENT,
  } = query
  const fetchFn: FetchLike =
    query.fetchFn ?? (globalThis.fetch as unknown as FetchLike)
  if (!fetchFn) return { status: "error", message: "no fetch implementation available" }
  if (!username.trim()) return { status: "error", message: "no chess.com username stored" }

  const headers = { "User-Agent": userAgent, Accept: "application/json" }

  const getJson = async (url: string): Promise<unknown> => {
    const res = await fetchFn(url, { headers })
    if (!res.ok) {
      const hint = res.status === 429 ? " (rate limited — requests must stay serial; retry later)" : ""
      throw new Error(`chess.com responded ${res.status} for ${url}${hint}`)
    }
    return res.json()
  }

  try {
    const user = encodeURIComponent(username.trim().toLowerCase())
    const archivesRaw = (await getJson(
      `${CHESSCOM_API_BASE}/player/${user}/games/archives`,
    )) as ArchivesResponse
    const archives = Array.isArray(archivesRaw?.archives) ? archivesRaw.archives : []
    // The API lists months oldest → newest; scan newest first.
    const months = archives.slice(-Math.max(1, maxMonths)).reverse()

    const wantedUrl = gameUrl ? urlKey(gameUrl) : null
    const wantedOpponent = opponent?.trim().toLowerCase() || null
    const candidates: ChesscomGame[] = []

    for (const monthUrl of months) {
      // Strictly serial: each month is awaited before the next request.
      const month = (await getJson(monthUrl)) as MonthResponse
      const games = Array.isArray(month?.games) ? month.games.filter(isFinishedGame) : []

      if (wantedUrl) {
        const hit = games.find((g) => urlKey(g.url) === wantedUrl)
        if (hit) {
          if (!hit.pgn) {
            return {
              status: "error",
              message: `matched ${hit.url} but the archive entry has no PGN`,
            }
          }
          return { status: "matched", game: hit, pgn: hit.pgn }
        }
        continue // URL stored: exact match only, keep scanning older months
      }

      for (const g of games) {
        if (!g.pgn) continue
        if (since != null && (g.end_time ?? 0) * 1000 < since) continue
        if (wantedOpponent) {
          const w = g.white.username.toLowerCase()
          const b = g.black.username.toLowerCase()
          if (w !== wantedOpponent && b !== wantedOpponent) continue
        }
        candidates.push(g)
      }
    }

    if (wantedUrl || candidates.length === 0) return { status: "not-found" }

    candidates.sort((a, b) => (b.end_time ?? 0) - (a.end_time ?? 0))
    return {
      status: "needs-confirmation",
      candidates: candidates.slice(0, MAX_CANDIDATES),
    }
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) }
  }
}

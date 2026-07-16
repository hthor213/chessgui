// Lichess opening-explorer fallback (spec 200: "Lichess API fallback when
// local database is empty").
//
// Queries https://explorer.lichess.ovh/lichess for the current position when
// the local database has no games there. Results map into the same MoveGroup
// shape the local explorer aggregates into, flagged clearly as online data.
// Failures (offline, rate-limit, bad response) reject with a short message
// the UI shows instead of the move list — never a crash.

import type { MoveGroup } from "@/lib/explorer-stats"

const EXPLORER_URL = "https://explorer.lichess.ovh/lichess"
const SPEEDS = "blitz,rapid,classical"
// Small in-memory cache: repeated navigation through the same opening lines
// shouldn't hammer the API. FIFO eviction is fine at this size.
const CACHE_CAP = 64
const cache = new Map<string, LichessExplorerResult>()

/** One move row from the Lichess explorer response (fields we consume). */
type LichessMove = {
  uci: string
  san: string
  white: number
  draws: number
  black: number
  averageRating?: number
}

export type LichessExplorerResult = {
  /** Total games reaching the position (white + draws + black). */
  total: number
  moves: MoveGroup[]
}

function toMoveGroups(moves: LichessMove[]): MoveGroup[] {
  return moves.map((m) => ({
    san: m.san,
    uci: m.uci,
    total: m.white + m.draws + m.black,
    whiteWins: m.white,
    draws: m.draws,
    blackWins: m.black,
    avgElo: m.averageRating ?? null,
    // Lichess aggregates don't expose per-game opponent ratings, so a true
    // performance rating can't be computed for online rows.
    performance: null,
  }))
}

/** Exposed for tests: clear the module cache. */
export function clearLichessExplorerCache(): void {
  cache.clear()
}

/**
 * Fetch the Lichess explorer stats for `fen`. Cached per FEN (up to
 * {@link CACHE_CAP} positions). Rejects with a human-readable message on any
 * network/HTTP/parse failure.
 */
export async function fetchLichessExplorer(fen: string): Promise<LichessExplorerResult> {
  const hit = cache.get(fen)
  if (hit) return hit

  let res: Response
  try {
    res = await fetch(`${EXPLORER_URL}?fen=${encodeURIComponent(fen)}&speeds=${SPEEDS}`)
  } catch {
    throw new Error("Lichess explorer unreachable — are you offline?")
  }
  if (!res.ok) {
    throw new Error(`Lichess explorer error (HTTP ${res.status})`)
  }
  let body: { white?: number; draws?: number; black?: number; moves?: LichessMove[] }
  try {
    body = await res.json()
  } catch {
    throw new Error("Lichess explorer returned an unreadable response")
  }
  const result: LichessExplorerResult = {
    total: (body.white ?? 0) + (body.draws ?? 0) + (body.black ?? 0),
    moves: toMoveGroups(body.moves ?? []),
  }
  if (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(fen, result)
  return result
}

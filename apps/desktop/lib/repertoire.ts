// Opening repertoire builder (spec 900 backlog: "User builds repertoire
// lines, spaced repetition drilling") — v1: extraction + drill deck.
//
// The repertoire is EXTRACTED from the user's own games rather than authored
// move by move — the same source-of-truth idea as the rival books
// (data/rivals/hjaltth.pgn, built by scripts/persona/build_rival_book.py),
// but done here in TS from any PGN the user loads, because the user's file
// may live anywhere and the browser shell has no data/rivals.
//
// One card per position the user reached at least `minReached` times with
// the move being theirs, inside the opening window (`maxPly`). The card's
// expected move is the one they played MOST OFTEN there — the drill trains
// consistency with your own most-practiced line, not engine approval.
// Position identity merges transpositions (normalizeFenKey, the rival-book
// convention: placement + turn + castling + ep, no move counters).
//
// Scheduling lives in lib/repertoire-results.ts (the spaced-repetition
// store); buildRepertoireDeck below draws due reviews first, then new cards
// shallowest-first, so the repertoire is learned from move 1 outward.

import { parsePgn, startingPosition } from "chessops/pgn"
import { makeFen } from "chessops/fen"
import { parseSan } from "chessops/san"
import { getProviders } from "@/lib/platform"
import {
  normalizeFenKey,
  replySanToUci,
  START_FEN,
} from "@/lib/rival-book-lookup"
import { cardSchedules, dueReviews, type RepertoireResultEntry } from "@/lib/repertoire-results"
import type { SparColor } from "@/lib/spar"

/** Default opening window: the user's first 10 moves (20 plies) — the same
 *  "opening" horizon as the avoidance decks' OPENING_MAX_PLY. */
export const REPERTOIRE_MAX_PLY = 20

/** A position seen once is a game, not a repertoire — require repeats. */
export const REPERTOIRE_MIN_REACHED = 2

export const DEFAULT_REPERTOIRE_DECK_SIZE = 10

export interface RepertoireCard {
  /** Stable identity: "rep:<color>:<normalized fen>" — survives rebuilds. */
  id: string
  /** The colour the USER plays in this position (== side to move). */
  color: SparColor
  /** Full FEN of the first game that reached the position (board display). */
  fen: string
  /** Ply of the position (0 = before White's first move). */
  ply: number
  /** The user's most-played move here. */
  expectedSan: string
  expectedUci: string
  /** How often the expected move was chosen / the position was reached. */
  timesPlayed: number
  timesReached: number
}

export interface Repertoire {
  /** ISO datetime of extraction. */
  builtAt: string
  username: string
  /** Source label for the setup screen (file name); null when pasted. */
  source: string | null
  /** Games in the PGN where the user was one of the players. */
  gamesUsed: number
  cards: RepertoireCard[]
}

export function repertoireCardId(color: SparColor, fen: string): string {
  return `rep:${color}:${normalizeFenKey(fen)}`
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Most frequent player name across the White/Black headers — in an export
 *  of one account's games that IS the account (the rival-PGN precedent:
 *  hjaltth.pgn has hjaltth in every game). Header-regex only, so guessing
 *  stays cheap on multi-thousand-game files; null when nothing matches. */
export function guessUsername(pgnText: string): string | null {
  const counts = new Map<string, number>()
  const re = /^\[(?:White|Black)\s+"(.+)"\]\s*$/gm
  for (let m = re.exec(pgnText); m; m = re.exec(pgnText)) {
    const name = m[1].trim()
    if (!name || name === "?") continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name
      bestCount = count
    }
  }
  return best
}

export interface ExtractOptions {
  /** Only positions strictly before this ply become cards. */
  maxPly?: number
  /** Minimum times a position must be reached to become a card. */
  minReached?: number
}

/**
 * Extract the user's repertoire from PGN text. Walks each game's MAINLINE
 * (played games have no variations worth trusting) and, at every position
 * inside the opening window where it was the user's turn, counts which move
 * they chose. Games are skipped when the user isn't a player, when both
 * players are the user (ambiguous), or when the game starts from a set-up
 * position (a non-standard start would pollute the transposition trie).
 * Malformed movetext stops that game's walk at the bad token, keeping what
 * was already counted — better a shallow game than a lost one.
 */
export function extractRepertoire(
  pgnText: string,
  username: string,
  opts: ExtractOptions = {},
): Repertoire {
  const maxPly = opts.maxPly ?? REPERTOIRE_MAX_PLY
  const minReached = opts.minReached ?? REPERTOIRE_MIN_REACHED
  const wanted = username.trim().toLowerCase()

  interface Node {
    fen: string
    ply: number
    color: SparColor
    moves: Map<string, number>
    reached: number
  }
  const nodes = new Map<string, Node>()
  let gamesUsed = 0

  for (const game of parsePgn(pgnText)) {
    const white = (game.headers.get("White") ?? "").trim().toLowerCase()
    const black = (game.headers.get("Black") ?? "").trim().toLowerCase()
    const isWhite = white === wanted
    const isBlack = black === wanted
    if (isWhite === isBlack) continue // not the user's game, or self-play
    const userColor: SparColor = isWhite ? "white" : "black"

    const posR = startingPosition(game.headers)
    if (posR.isErr) continue
    const pos = posR.unwrap()
    if (makeFen(pos.toSetup()) !== START_FEN) continue // set-up position

    gamesUsed++
    let ply = 0
    let node = game.moves.children[0]
    while (node && ply < maxPly) {
      const move = parseSan(pos, node.data.san)
      if (!move) break
      if ((ply % 2 === 0 ? "white" : "black") === userColor) {
        const fen = makeFen(pos.toSetup())
        const key = repertoireCardId(userColor, fen)
        let n = nodes.get(key)
        if (!n) {
          n = { fen, ply, color: userColor, moves: new Map(), reached: 0 }
          nodes.set(key, n)
        }
        n.reached++
        n.moves.set(node.data.san, (n.moves.get(node.data.san) ?? 0) + 1)
      }
      pos.play(move)
      ply++
      node = node.children[0]
    }
  }

  const cards: RepertoireCard[] = []
  for (const [id, n] of nodes) {
    if (n.reached < minReached) continue
    let expectedSan = ""
    let timesPlayed = 0
    for (const [san, count] of n.moves) {
      // Ties break to the first-recorded move — the earliest game's choice.
      if (count > timesPlayed) {
        expectedSan = san
        timesPlayed = count
      }
    }
    const expectedUci = replySanToUci(n.fen, expectedSan)
    if (!expectedUci) continue // defensive: unreplayable SAN never counted
    cards.push({
      id,
      color: n.color,
      fen: n.fen,
      ply: n.ply,
      expectedSan,
      expectedUci,
      timesPlayed,
      timesReached: n.reached,
    })
  }
  // Shallow → deep, then most-reached first: the natural study order, and
  // the order the deck builder draws new cards in.
  cards.sort((a, b) => a.ply - b.ply || b.timesReached - a.timesReached)

  return {
    builtAt: new Date().toISOString(),
    username: username.trim(),
    source: null,
    gamesUsed,
    cards,
  }
}

// ---------------------------------------------------------------------------
// Drill deck (due-queue first, then new cards)
// ---------------------------------------------------------------------------

export interface RepertoireDeckOptions {
  count?: number
  /** Restrict the deck to one colour's repertoire (null = both). */
  color?: SparColor | null
  now?: number
}

export interface RepertoireDeckItem {
  card: RepertoireCard
  /** True when the card is a due review (vs a never-drilled new card). */
  review: boolean
}

/**
 * Build a drill deck: due reviews first (longest-overdue leading — that
 * order is the priority, same convention as the avoidance decks), then new
 * cards in the repertoire's shallow-first order. No shuffle: every card asks
 * the same question ("what does your repertoire play here?"), so order leaks
 * nothing — unlike the avoidance decks' anchor-leak concern.
 */
export function buildRepertoireDeck(
  cards: readonly RepertoireCard[],
  entries: readonly RepertoireResultEntry[],
  opts: RepertoireDeckOptions = {},
): RepertoireDeckItem[] {
  const count = opts.count ?? DEFAULT_REPERTOIRE_DECK_SIZE
  const now = opts.now ?? Date.now()
  const inColor = (c: RepertoireCard) => opts.color == null || c.color === opts.color

  const byId = new Map(cards.filter(inColor).map((c) => [c.id, c]))
  const deck: RepertoireDeckItem[] = []
  for (const due of dueReviews(entries, now)) {
    if (deck.length >= count) break
    const card = byId.get(due.key)
    if (!card) continue // schedule for a card the rebuild dropped
    deck.push({ card, review: true })
    byId.delete(due.key)
  }
  const scheduled = cardSchedules(entries)
  for (const card of byId.values()) {
    if (deck.length >= count) break
    if (scheduled.has(card.id)) continue // attempted but not yet due
    deck.push({ card, review: false })
  }
  return deck
}

/** Due / new / scheduled-later counts for the setup screen. */
export function repertoireQueueCounts(
  cards: readonly RepertoireCard[],
  entries: readonly RepertoireResultEntry[],
  now: number = Date.now(),
): { due: number; fresh: number; later: number } {
  const ids = new Set(cards.map((c) => c.id))
  const schedules = cardSchedules(entries)
  let due = 0
  let later = 0
  for (const s of schedules.values()) {
    if (!ids.has(s.key)) continue
    if (s.dueAt <= now) due++
    else later++
  }
  let fresh = 0
  for (const id of ids) if (!schedules.has(id)) fresh++
  return { due, fresh, later }
}

// ---------------------------------------------------------------------------
// StorageProvider glue (client-only; the provider absorbs unavailability)
// ---------------------------------------------------------------------------

export const REPERTOIRE_STORAGE_KEY = "chessgui:repertoire"

export function loadRepertoire(): Repertoire | null {
  try {
    const raw = getProviders().storage.get(REPERTOIRE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Repertoire
    return Array.isArray(parsed?.cards) ? parsed : null
  } catch {
    return null
  }
}

export function persistRepertoire(rep: Repertoire): void {
  // Storage unavailable — the repertoire stays in memory only.
  getProviders().storage.set(REPERTOIRE_STORAGE_KEY, JSON.stringify(rep))
}

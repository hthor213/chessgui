// In-memory mock of the Persona Arena REST API (spec 217 Tier 0), matching
// the REAL contract in lib/arena-api.ts (which mirrors the actual backend at
// server/arena/app/main.py — a parallel agent's build target found already in
// this repo). Used to drive the whole login -> disclosure -> lobby -> game ->
// history flow in a plain browser and in headless Playwright without a
// running backend. Mirrors the established lib/*-mock.ts pattern
// (lib/database-mock.ts, lib/calibration-mock.ts, lib/rival-book-mock.ts,
// lib/maia-mock.ts, lib/persona-mock.ts) — same idea, new surface.
//
// The persona "engine" here is a uniformly-random legal move with a fixed
// artificial delay. It exists ONLY to exercise the UI (thinking indicator,
// move list, resign, resume, replay, delete) — it is not a strength
// approximation of anything and must never be mistaken for the real
// backend's move quality (persona.py's book + BT3-search arms).

import { Chess } from "chessops/chess"
import { parseFen, INITIAL_FEN } from "chessops/fen"
import { chessgroundDests } from "chessops/compat"
import { replayFens, sansFromUci } from "@chessgui/core/game-replay"
import { buildArenaRoster } from "@/lib/arena-roster"
import {
  ArenaApiError,
  type ArenaApiClient,
  type ArenaColor,
  type ArenaGameState,
  type ArenaGameStatus,
  type ArenaGameSummary,
  type ArenaMove,
  type ArenaPersonaRecord,
  type ArenaResult,
  type ArenaUser,
} from "@chessgui/core/arena-api"
import { arenaResultBadge } from "@/lib/arena-moves"
import { ARENA_DISCLOSURE_TEXT } from "@/lib/arena-disclosure"

const MOCK_THINKING_MS = 350

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function positionOf(fen: string): Chess | null {
  const setup = parseFen(fen)
  if (setup.isErr) return null
  const pos = Chess.fromSetup(setup.unwrap())
  return pos.isErr ? null : pos.unwrap()
}

function squareIndex(sq: string): number {
  const file = sq.charCodeAt(0) - 97
  const rank = sq.charCodeAt(1) - 49
  return rank * 8 + file
}

/** A uniformly random legal move at `fen`, auto-queening a pawn that reaches
 *  the last rank (same Tier-0 convention as lib/spar.ts's `dragToUci` — no
 *  underpromotion picker). Null only at a terminal position. */
function randomReply(fen: string): string | null {
  const pos = positionOf(fen)
  if (!pos) return null
  const dests = chessgroundDests(pos) as Map<string, string[]>
  const froms = [...dests.keys()].filter((k) => (dests.get(k) ?? []).length > 0)
  if (froms.length === 0) return null
  const from = froms[Math.floor(Math.random() * froms.length)]
  const tos = dests.get(from)!
  const to = tos[Math.floor(Math.random() * tos.length)]
  const piece = pos.board.get(squareIndex(from))
  const toRank = to.charCodeAt(1) - 49
  const promo = piece?.role === "pawn" && (toRank === 0 || toRank === 7) ? "q" : ""
  return `${from}${to}${promo}`
}

/** Legal at `fen`? Reuses lib/game-replay.ts's own replay/legality logic
 *  (sansFromUci stops early, returning fewer SANs than moves, at the first
 *  illegal move) instead of re-implementing chessops legality here. */
function isLegalUci(fen: string, uci: string): boolean {
  return sansFromUci(fen, [uci]).length === 1
}

function terminalStatus(fen: string): { result: ArenaResult; reason: string } | null {
  const pos = positionOf(fen)
  if (!pos || !pos.isEnd()) return null
  if (pos.isCheckmate()) {
    // The side to move is checkmated, so the other side won.
    return { result: pos.turn === "white" ? "0-1" : "1-0", reason: "checkmate" }
  }
  if (pos.isStalemate()) return { result: "1/2-1/2", reason: "stalemate" }
  return { result: "1/2-1/2", reason: "insufficient_material" }
}

interface MockGame {
  id: number
  persona: string
  personaDisplayName: string
  playerColor: ArenaColor
  moves: ArenaMove[]
  status: ArenaGameStatus
  result: ArenaResult
  resultReason: string | null
  createdAt: string
  updatedAt: string
}

function currentFenOf(g: MockGame): string {
  const fens = replayFens(INITIAL_FEN, g.moves.map((m) => m.uci))
  return fens[fens.length - 1]
}

function toGameState(g: MockGame): ArenaGameState {
  return {
    id: g.id,
    persona: g.persona,
    playerColor: g.playerColor,
    status: g.status,
    result: g.result,
    resultReason: g.resultReason,
    fen: currentFenOf(g),
    disclosure: ARENA_DISCLOSURE_TEXT,
    // A fresh array copy, not `g.moves` itself: `g.moves` is mutated in place
    // (push) as the mock game progresses, so handing back the SAME reference
    // on every call would break React's reference-equality memoization
    // downstream (components/arena/game-screen.tsx's `useMemo([game?.moves])`)
    // — the UI would see `game.moves.length` grow but never recompute the
    // move list. A real HTTP response never has this problem (every
    // `res.json()` call already deserializes a brand-new array); this is a
    // mock-only correctness fix, not a contract concern.
    moves: [...g.moves],
  }
}

function toSummary(g: MockGame): ArenaGameSummary {
  return {
    id: g.id,
    persona: g.persona,
    playerColor: g.playerColor,
    status: g.status,
    result: g.result,
    resultReason: g.resultReason,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    movesCount: g.moves.length,
  }
}

export function createMockArenaApiClient(): ArenaApiClient {
  const games = new Map<number, MockGame>()
  // Spec 217 Promise 2 mock store — in-memory only, mirrors the server's
  // validation (ply must name a persona move) so the UI's error path is
  // drivable headlessly too.
  const feedback: { gameId: number; ply: number; uci: string; san: string; persona: string; note: string }[] = []
  const rosterBySlug = new Map(buildArenaRoster().map((p) => [p.slug, p]))
  let nextId = 1

  function requireGame(gameId: number): MockGame {
    const g = games.get(gameId)
    if (!g) throw new ArenaApiError(404, "Game not found")
    return g
  }

  /** Push the persona's reply onto `g` if the game isn't already over —
   *  shared by createGame (Black-side opening) and submitMove. */
  async function personaReplyIfNeeded(g: MockGame): Promise<void> {
    if (g.status !== "active") return
    const term = terminalStatus(currentFenOf(g))
    if (term) {
      g.status = "finished"
      g.result = term.result
      g.resultReason = term.reason
      return
    }
    await delay(MOCK_THINKING_MS)
    const fen = currentFenOf(g)
    const reply = randomReply(fen)
    if (!reply) return
    g.moves.push({ ply: g.moves.length, uci: reply, san: "", mover: "persona", arm: "search" })
    // Backfill SAN via the shared reconstruction path now that the move is applied.
    const sansAfter = sansFromUci(INITIAL_FEN, g.moves.map((m) => m.uci))
    g.moves[g.moves.length - 1].san = sansAfter[sansAfter.length - 1] ?? ""
    const term2 = terminalStatus(currentFenOf(g))
    if (term2) {
      g.status = "finished"
      g.result = term2.result
      g.resultReason = term2.reason
    }
  }

  return {
    async googleLogin(idToken: string): Promise<{ token: string; user: ArenaUser }> {
      await delay(50)
      return {
        token: `mock-jwt-${idToken}`,
        user: { id: 1, email: "mock@example.com", name: "Mock Player", avatarUrl: "" },
      }
    },

    async listPersonas() {
      await delay(50)
      return {
        disclosure: ARENA_DISCLOSURE_TEXT,
        personas: [
          // A mock private persona (spec 217 Promise 1) so the lobby's
          // merge + "Only in your lobby" badge are drivable headlessly.
          // The real backend only ever returns the LOGGED-IN user's own
          // persona; this stands in for that, it names nobody.
          {
            slug: "yourself",
            displayName: "Yourself",
            bio: "",
            isPrivate: true,
            strengthLabel: "own book + Maia 1400, unmeasured",
          },
          ...buildArenaRoster()
            .filter((p) => p.available)
            .map((p) => ({
              slug: p.slug,
              displayName: p.displayName,
              bio: p.strengthLabel,
              isPrivate: false,
              strengthLabel: null,
            })),
        ],
      }
    },

    async createGame(persona: string, playerColor: ArenaColor): Promise<ArenaGameState> {
      await delay(150)
      const entry = rosterBySlug.get(persona)
      const g: MockGame = {
        id: nextId++,
        persona,
        personaDisplayName: entry?.displayName ?? persona,
        playerColor,
        moves: [],
        status: "active",
        result: null,
        resultReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      games.set(g.id, g)
      if (playerColor === "black") await personaReplyIfNeeded(g)
      return toGameState(g)
    },

    async getGame(gameId: number): Promise<ArenaGameState> {
      await delay(50)
      return toGameState(requireGame(gameId))
    },

    async listGames(): Promise<ArenaGameSummary[]> {
      await delay(80)
      return [...games.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(toSummary)
    },

    async listPersonaRecords(): Promise<ArenaPersonaRecord[]> {
      // Spec 217 Tier 1 W/D/L parity: same aggregation the server does in
      // SQL (db.wdl_by_persona) — finished games only, one row per persona,
      // sorted by slug. Outcome classification reuses arenaResultBadge so
      // the mock can never disagree with the history row badges it sits
      // beside.
      await delay(80)
      const byPersona = new Map<string, ArenaPersonaRecord>()
      for (const g of games.values()) {
        if (g.status !== "finished") continue
        let rec = byPersona.get(g.persona)
        if (!rec) {
          rec = { persona: g.persona, wins: 0, draws: 0, losses: 0 }
          byPersona.set(g.persona, rec)
        }
        const badge = arenaResultBadge(g.status, g.result, g.playerColor)
        if (badge === "Win") rec.wins++
        else if (badge === "Draw") rec.draws++
        else rec.losses++
      }
      return [...byPersona.values()].sort((a, b) => a.persona.localeCompare(b.persona))
    },

    async submitMove(gameId: number, uci: string): Promise<ArenaGameState> {
      const g = requireGame(gameId)
      if (g.status !== "active") throw new ArenaApiError(409, "Game is finished")
      const fenBefore = currentFenOf(g)
      if (!isLegalUci(fenBefore, uci)) throw new ArenaApiError(400, "Illegal move")

      g.moves.push({ ply: g.moves.length, uci, san: "", mover: "player", arm: null })
      const sansAfter = sansFromUci(INITIAL_FEN, g.moves.map((m) => m.uci))
      g.moves[g.moves.length - 1].san = sansAfter[sansAfter.length - 1] ?? ""

      const term = terminalStatus(currentFenOf(g))
      if (term) {
        g.status = "finished"
        g.result = term.result
        g.resultReason = term.reason
      } else {
        await personaReplyIfNeeded(g)
      }
      g.updatedAt = new Date().toISOString()
      return toGameState(g)
    },

    async resign(gameId: number): Promise<ArenaGameState> {
      await delay(80)
      const g = requireGame(gameId)
      if (g.status !== "active") throw new ArenaApiError(409, "Game is finished")
      g.status = "finished"
      g.result = g.playerColor === "white" ? "0-1" : "1-0"
      g.resultReason = "player resigned"
      g.updatedAt = new Date().toISOString()
      return toGameState(g)
    },

    async submitMoveFeedback(gameId: number, ply: number, note?: string): Promise<void> {
      await delay(50)
      const g = requireGame(gameId)
      const target = g.moves.find((m) => m.ply === ply)
      if (!target) throw new ArenaApiError(400, `No move at ply ${ply}`)
      if (target.mover !== "persona") throw new ArenaApiError(400, "Feedback targets a persona move")
      feedback.push({ gameId, ply, uci: target.uci, san: target.san, persona: g.persona, note: (note ?? "").trim() })
    },

    async deleteGame(gameId: number): Promise<void> {
      await delay(50)
      requireGame(gameId)
      games.delete(gameId)
    },
  }
}

/** Install the mock at `window.__ARENA_API__` so `getArenaApi()` (lib/arena-
 *  api.ts) picks it up. Called only from app/arena/page.tsx, gated on a
 *  `?mock=1` URL param — never in a normal deployment. */
export function installArenaApiMock(): void {
  if (typeof window === "undefined") return
  ;(window as unknown as { __ARENA_API__?: ArenaApiClient }).__ARENA_API__ = createMockArenaApiClient()
}

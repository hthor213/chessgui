// Persona Arena client contract (spec 217 Tier 0 / spec 218 "Persona Arena"
// surface). This file matches the REAL backend build target that landed in
// this repo (server/arena/app/main.py, a parallel agent's work found already
// in the working tree — server/arena/app/{main,auth,db,config,persona}.py)
// rather than a speculative contract, so this frontend is actually wired up,
// not merely contract-compatible on paper. See this feature's return value
// for the earlier speculative-vs-real reconciliation notes.
//
// No Tauri IPC anywhere on this path (spec 217: "the existing Next.js board
// UI already runs Tauri-free in a browser") — every call here is a plain
// `fetch`.
//
// Endpoints (server/arena/app/main.py, all under NEXT_PUBLIC_ARENA_API_BASE,
// default same-origin ""; the Tier-0 docker-compose binds the real service to
// 127.0.0.1:8017, loopback-only until a reverse proxy fronts it):
//
//   POST /api/auth/google-login  {id_token}         -> 200 {jwt, user} | 401 | 403 (not on allowlist)
//   GET  /api/personas                              -> 200 {disclosure, personas: [...]} | 401
//   POST /api/game  {persona, player_color}         -> 200 ArenaGameState | 400 | 401 | 503 (engine stall)
//   GET  /api/games                                 -> 200 {games: ArenaGameSummary[]} | 401
//   GET  /api/game/{id}                              -> 200 ArenaGameState | 401 | 404 | 503
//        (a plain GET can trigger a pending persona reply server-side — the
//        "resume" path IS this endpoint, no separate resume call exists)
//   POST /api/game/{id}/move  {uci}                 -> 200 ArenaGameState | 400 | 401 | 404 | 409 | 503
//   POST /api/game/{id}/resign                       -> 200 ArenaGameState | 401 | 404 | 409
//   DELETE /api/game/{id}                            -> 200 {deleted: id} | 401 | 404
//
// NOT a server capability in Tier 0 (checked against persona.py's own
// "honest inventory" docstring: "step 7 draw/resign model... NOT
// implemented... a human opponent adjudicates their own games"): there is no
// draw-offer endpoint. Automatic rule-based draws (stalemate, insufficient
// material, threefold repetition, 50-move) still happen on their own —
// python-chess's `board.outcome(claim_draw=True)` is checked after every
// move — so a game CAN still end in a draw, just never via a client-clicked
// "offer draw" button. The game screen only offers Resign for Tier 0; this
// is a deliberate scope cut, not an oversight (see this feature's open
// items).
//
// Auth is a JWT bearer token (Authorization: Bearer <jwt>), NOT a session
// cookie — the real backend ports the golf app's Google-Identity-Services
// pattern (client-side Google Sign-In button -> id_token -> POST
// /api/auth/google-login -> JWT stored client-side). This differs from this
// task's original brief ("assume a session cookie... 401 -> login
// redirect"); the brief predated discovering the real backend already in
// the tree. A 401 here clears the stored token and calls whatever handler
// app/arena/page.tsx registered via `setUnauthorizedHandler` (there is no
// separate login PAGE to redirect to — login is a client-rendered screen,
// components/arena/login-screen.tsx).

import { getProviders } from "@/lib/platform"

export type ArenaColor = "white" | "black"
/** UI-only side choice; "random" never reaches the wire — the client
 *  resolves it to a concrete color before calling `createGame` because the
 *  real backend's CreateGameRequest requires `player_color` to already be
 *  'white' or 'black' (server/arena/app/main.py — no random resolution
 *  server-side). */
export type ArenaSideChoice = ArenaColor | "random"

/** The real backend's status vocabulary (server/arena/app/db.py schema CHECK
 *  constraint) — just two states, not a per-outcome enum. Read `result` +
 *  `resultReason` for the human-readable ending. */
export type ArenaGameStatus = "active" | "finished"
export type ArenaResult = "1-0" | "0-1" | "1/2-1/2" | null

export interface ArenaUser {
  id: number
  email: string
  name: string
  avatarUrl: string
}

export interface ArenaPersonaInfo {
  slug: string
  displayName: string
  bio: string
  /** Spec 217 Promise 1 ("play against yourself"): true for the logged-in
   *  player's OWN persona. Server-gated per user — the backend only ever
   *  returns YOUR private persona, never anyone else's. */
  isPrivate: boolean
  /** The backend's honest label for private personas ("own book + Maia
   *  1400, unmeasured" — build_rival_configs.py format). Null for GM
   *  personas, whose measured label the client derives from
   *  lib/persona-manifest.ts instead. */
  strengthLabel: string | null
}

export interface ArenaMove {
  ply: number
  uci: string
  san: string
  mover: "player" | "persona"
  /** Which persona arm produced this move — book lookup or lc0 search
   *  (persona.py). Present on persona moves only. */
  arm: "book" | "search" | null
}

export interface ArenaGameState {
  id: number
  persona: string
  playerColor: ArenaColor
  status: ArenaGameStatus
  result: ArenaResult
  /** python-chess Termination name, lowercased ("checkmate", "stalemate",
   *  "insufficient_material", "fivefold_repetition", "seventyfive_moves"),
   *  or the literal "player resigned" — free text from the backend, shown
   *  as-is with light humanizing (components/arena/game-screen.tsx). */
  resultReason: string | null
  fen: string
  disclosure: string
  moves: ArenaMove[]
}

/** One row of "my games" (GET /api/games) — server/arena/app/db.py
 *  `list_games`'s exact row shape, camelCased. */
export interface ArenaGameSummary {
  id: number
  persona: string
  playerColor: ArenaColor
  status: ArenaGameStatus
  result: ArenaResult
  resultReason: string | null
  createdAt: string
  updatedAt: string
  movesCount: number
}

export class ArenaApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "ArenaApiError"
    this.status = status
  }
}

export interface ArenaApiClient {
  /** POST /api/auth/google-login. Stores nothing itself — the caller
   *  persists the returned token (see setStoredToken) so every later call
   *  in this client instance attaches it automatically. */
  googleLogin(idToken: string): Promise<{ token: string; user: ArenaUser }>
  listPersonas(): Promise<{ disclosure: string; personas: ArenaPersonaInfo[] }>
  createGame(persona: string, playerColor: ArenaColor): Promise<ArenaGameState>
  getGame(gameId: number): Promise<ArenaGameState>
  listGames(): Promise<ArenaGameSummary[]>
  submitMove(gameId: number, uci: string): Promise<ArenaGameState>
  resign(gameId: number): Promise<ArenaGameState>
  deleteGame(gameId: number): Promise<void>
}

// ---------------------------------------------------------------------------
// Token storage (JWT bearer, not a cookie — see file header)
// ---------------------------------------------------------------------------

const TOKEN_KEY = "arena-jwt"

export function getStoredToken(): string | null {
  // StorageProvider absorbs SSR/unavailable (returns null) — spec 220 step 3.
  return getProviders().storage.get(TOKEN_KEY)
}

export function setStoredToken(token: string | null): void {
  if (token) getProviders().storage.set(TOKEN_KEY, token)
  else getProviders().storage.remove(TOKEN_KEY)
}

type UnauthorizedHandler = () => void
let unauthorizedHandler: UnauthorizedHandler | null = null

/** Registered once by app/arena/page.tsx: flips the app to the login screen
 *  whenever any call comes back 401 (expired/missing/invalid token). */
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  unauthorizedHandler = fn
}

// ---------------------------------------------------------------------------
// Real (fetch) implementation
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_ARENA_API_BASE ?? ""

async function request<T>(path: string, init?: RequestInit, auth = true): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (auth) {
    const token = getStoredToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
  })
  if (res.status === 401) {
    setStoredToken(null)
    unauthorizedHandler?.()
    throw new ArenaApiError(401, "Not signed in")
  }
  if (!res.ok) {
    // FastAPI's HTTPException default error body is {"detail": "..."}, not
    // {"error": "..."} — matched exactly against server/arena/app/main.py.
    let message = res.statusText || `Request failed (${res.status})`
    try {
      const body = await res.json()
      if (body && typeof body.detail === "string") message = body.detail
    } catch {
      // non-JSON error body — keep the statusText fallback
    }
    throw new ArenaApiError(res.status, message)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

function userFromWire(u: {
  id: number
  email: string
  name?: string
  avatar_url?: string
}): ArenaUser {
  return { id: u.id, email: u.email, name: u.name ?? "", avatarUrl: u.avatar_url ?? "" }
}

function gameStateFromWire(g: {
  id: number
  persona: string
  player_color: ArenaColor
  status: ArenaGameStatus
  result: ArenaResult
  result_reason: string | null
  fen: string
  disclosure: string
  moves: { ply: number; uci: string; san: string; mover: "player" | "persona"; arm: "book" | "search" | null }[]
}): ArenaGameState {
  return {
    id: g.id,
    persona: g.persona,
    playerColor: g.player_color,
    status: g.status,
    result: g.result,
    resultReason: g.result_reason,
    fen: g.fen,
    disclosure: g.disclosure,
    moves: g.moves,
  }
}

function gameSummaryFromWire(g: {
  id: number
  persona: string
  player_color: ArenaColor
  status: ArenaGameStatus
  result: ArenaResult
  result_reason: string | null
  created_at: string
  updated_at: string
  n_moves: number
}): ArenaGameSummary {
  return {
    id: g.id,
    persona: g.persona,
    playerColor: g.player_color,
    status: g.status,
    result: g.result,
    resultReason: g.result_reason,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
    movesCount: g.n_moves,
  }
}

function createFetchArenaApiClient(): ArenaApiClient {
  return {
    async googleLogin(idToken) {
      const res = await request<{ jwt: string; user: Parameters<typeof userFromWire>[0] }>(
        "/api/auth/google-login",
        { method: "POST", body: JSON.stringify({ id_token: idToken }) },
        false, // no token to attach yet — this call establishes one
      )
      return { token: res.jwt, user: userFromWire(res.user) }
    },

    async listPersonas() {
      const res = await request<{
        disclosure: string
        personas: { slug: string; display_name: string; bio: string; private?: boolean; strength_label?: string | null }[]
      }>("/api/personas")
      return {
        disclosure: res.disclosure,
        personas: res.personas.map((p) => ({
          slug: p.slug,
          displayName: p.display_name,
          bio: p.bio,
          isPrivate: p.private ?? false,
          strengthLabel: p.strength_label ?? null,
        })),
      }
    },

    async createGame(persona, playerColor) {
      const g = await request<Parameters<typeof gameStateFromWire>[0]>("/api/game", {
        method: "POST",
        body: JSON.stringify({ persona, player_color: playerColor }),
      })
      return gameStateFromWire(g)
    },

    async getGame(gameId) {
      const g = await request<Parameters<typeof gameStateFromWire>[0]>(`/api/game/${gameId}`)
      return gameStateFromWire(g)
    },

    async listGames() {
      const res = await request<{ games: Parameters<typeof gameSummaryFromWire>[0][] }>("/api/games")
      return res.games.map(gameSummaryFromWire)
    },

    async submitMove(gameId, uci) {
      const g = await request<Parameters<typeof gameStateFromWire>[0]>(`/api/game/${gameId}/move`, {
        method: "POST",
        body: JSON.stringify({ uci }),
      })
      return gameStateFromWire(g)
    },

    async resign(gameId) {
      const g = await request<Parameters<typeof gameStateFromWire>[0]>(`/api/game/${gameId}/resign`, {
        method: "POST",
      })
      return gameStateFromWire(g)
    },

    async deleteGame(gameId) {
      await request<{ deleted: number }>(`/api/game/${gameId}`, { method: "DELETE" })
    },
  }
}

// ---------------------------------------------------------------------------
// Client seam (headless-verification hook, mirrors app/page.tsx's
// window.__enterThinkingMode pattern documented in .claude/skills/verify)
// ---------------------------------------------------------------------------

let cachedRealClient: ArenaApiClient | null = null

/**
 * The client every arena component calls through. In production this is
 * always the real fetch client — `getArenaApi()` never reads any dev/test
 * flag itself. `app/arena/page.tsx` may install a mock at
 * `window.__ARENA_API__` (via lib/arena-api-mock.ts's `installArenaApiMock`,
 * gated on a `?mock=1` URL param) BEFORE any component mounts; when present,
 * this function returns it instead of constructing the real client. Nothing
 * in a normal deployment ever sets that global.
 */
export function getArenaApi(): ArenaApiClient {
  if (typeof window !== "undefined") {
    const injected = (window as unknown as { __ARENA_API__?: ArenaApiClient }).__ARENA_API__
    if (injected) return injected
  }
  if (!cachedRealClient) cachedRealClient = createFetchArenaApiClient()
  return cachedRealClient
}

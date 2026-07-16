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
//   POST /api/game  {persona, player_color,
//                    clock_initial_s?, clock_increment_s?}
//                                                    -> 200 ArenaGameState | 400 | 401 | 503 (engine stall)
//        (spec 217 Tier 1 "clocks with increment": both clock fields omitted
//        = no clock, the Tier-0 behavior. The server validates the range —
//        30s..3h initial, 0..180s increment.)
//   GET  /api/games                                 -> 200 {games: ArenaGameSummary[]} | 401
//   GET  /api/stats                                  -> 200 {records: ArenaPersonaRecord[]} | 401
//        (spec 217 Tier 1: per-opponent W/D/L history — finished games only,
//        aggregated server-side per persona faced, scoped to the caller)
//   GET  /api/game/{id}                              -> 200 ArenaGameState | 401 | 404 | 503
//        (a plain GET can trigger a pending persona reply server-side — the
//        "resume" path IS this endpoint, no separate resume call exists)
//   POST /api/game/{id}/move  {uci}                 -> 200 ArenaGameState | 400 | 401 | 404 | 409 | 503
//   POST /api/game/{id}/resign                       -> 200 ArenaGameState | 401 | 404 | 409
//   POST /api/game/{id}/feedback  {ply, note?}       -> 200 {id, game_id, ply} | 400 | 401 | 404
//        (spec 217 Promise 2: "I would never do this" on a persona move —
//        the spec-214 realism-feedback capture ported to the arena; the
//        server reads move + persona back from its own DB, the client only
//        names the ply. Valid on active AND finished games.)
//   POST /api/game/{id}/realism  {verdict, note?}    -> 200 {game_id, verdict} | 400 | 401 | 404 | 409
//        (spec 217 Tier 2: post-game "felt like him" / "didn't feel like him"
//        verdict — whole-game realism, distinct from the per-move feedback
//        above. Finished games only (409 while active); one verdict per game,
//        re-submitting updates it.)
//   POST /api/game/{id}/share                        -> 200 {token} | 401 | 404 | 409
//        (spec 217 Tier 2: mint the read-only family replay token for a
//        finished game. Idempotent — the same token comes back every time
//        until revoked.)
//   DELETE /api/game/{id}/share                      -> 200 {revoked: id} | 401 | 404
//   GET  /api/replay/{token}                         -> 200 shared replay | 404
//        (NO auth — the unguessable token IS the capability, so a family
//        member without a login can open the link. 404 covers unknown,
//        revoked, and deleted alike.)
//   DELETE /api/game/{id}                            -> 200 {deleted: id} | 401 | 404
//   POST /api/exhibition {white_persona, black_persona}
//                                                    -> 200 ArenaExhibitionState | 400 | 401 | 409
//        (spec 217 Promise 3: the server plays both personas on a background
//        thread. 409 = an exhibition is already running — one at a time per
//        the resource policy. Public roster only: private personas never
//        appear in a family-spectatable game.)
//   GET  /api/exhibitions                            -> 200 {exhibitions: [...]} | 401
//        (family-shared: everyone sees the same exhibit hall, newest first)
//   GET  /api/exhibition/{id}                        -> 200 ArenaExhibitionState | 401 | 404
//        (the spectate poll AND the replay fetch — poll while status is
//        'active', stop when it flips to 'finished')
//   POST /api/exhibition/{id}/stop                   -> 200 ArenaExhibitionState | 401 | 404 | 409
//        (any family member may stop a running exhibition — shared compute)
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

import { getProviders } from "./platform"

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

/** Per-game clock state (spec 217 Tier 1 "clocks with increment"). The
 *  server is authoritative: `whiteMs`/`blackMs` are the remaining times
 *  already adjusted to the moment the response was built, so the client
 *  only counts the `running` side down locally — no turn-timestamp or
 *  clock-skew arithmetic client-side. Flag = loss is adjudicated lazily
 *  server-side on the next request that looks at the game (a move, or a
 *  plain GET when the client sees a clock hit zero). */
export interface ArenaClock {
  initialS: number
  incrementS: number
  whiteMs: number
  blackMs: number
  /** Whose clock is burning — null when the game is finished. */
  running: ArenaColor | null
}

/** Client-side time-control choice for createGame. */
export interface ArenaClockChoice {
  initialS: number
  incrementS: number
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
  /** Null for clockless games (every pre-clock game, and games created
   *  without a time control). */
  clock: ArenaClock | null
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

/** One row of the player's per-opponent record (GET /api/stats) — spec 217
 *  Tier 1 W/D/L history. Counts are from the PLAYER's side (wins = games the
 *  player won against this persona) and cover finished games only; wire shape
 *  is already camel-safe (single-word keys), so no mapping layer exists. */
export interface ArenaPersonaRecord {
  persona: string
  wins: number
  draws: number
  losses: number
}

/** Post-game whole-game realism verdict (spec 217 Tier 2) — the spar's
 *  vocabulary (packages/ui/src/spar-tab.tsx FeedbackVerdict), reused verbatim
 *  so the Tier-2 retune reads one verdict language across both surfaces. */
export type ArenaRealismVerdict = "felt_like" | "did_not_feel_like"

/** A shared read-only replay (GET /api/replay/{token}, spec 217 Tier 2) —
 *  fetched WITHOUT auth: the recipient of a family replay link has no login.
 *  Deliberately smaller than ArenaGameState: no game id, no clock, no
 *  disclosure — just the game record a spectator needs. */
export interface ArenaSharedReplay {
  persona: string
  playerColor: ArenaColor
  /** The sharing player's display name; may be empty (client shows a
   *  neutral fallback). Never their email. */
  playerName: string
  result: ArenaResult
  resultReason: string | null
  createdAt: string
  moves: ArenaMove[]
}

/** One move of a persona-vs-persona exhibition (spec 217 Promise 3). Both
 *  sides are personas, so unlike ArenaMove there is no `mover` — the side is
 *  the ply's parity (even = White). `arm` is which persona arm produced it. */
export interface ArenaExhibitionMove {
  ply: number
  uci: string
  san: string
  arm: "book" | "search" | null
}

/** Full exhibition state (GET /api/exhibition/{id}) — the spectate poll and
 *  the replay fetch share this shape. `result` is null with a `resultReason`
 *  of "stopped" / "engine stall" / "interrupted" when the run ended without
 *  a chess result; "move_cap" is an adjudicated draw (result "1/2-1/2"). */
export interface ArenaExhibitionState {
  id: number
  whitePersona: string
  blackPersona: string
  /** Roster display names, resolved server-side (slug fallback). */
  whiteName: string
  blackName: string
  status: ArenaGameStatus
  result: ArenaResult
  resultReason: string | null
  fen: string
  createdAt: string
  updatedAt: string
  moves: ArenaExhibitionMove[]
}

/** One row of the exhibit hall (GET /api/exhibitions). */
export interface ArenaExhibitionSummary {
  id: number
  whitePersona: string
  blackPersona: string
  whiteName: string
  blackName: string
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
  /** `clock` omitted/null = no clock (Tier-0 behavior, unchanged). */
  createGame(
    persona: string,
    playerColor: ArenaColor,
    clock?: ArenaClockChoice | null,
  ): Promise<ArenaGameState>
  getGame(gameId: number): Promise<ArenaGameState>
  listGames(): Promise<ArenaGameSummary[]>
  /** GET /api/stats — the player's W/D/L record per persona faced (spec 217
   *  Tier 1). One row per persona with at least one finished game. */
  listPersonaRecords(): Promise<ArenaPersonaRecord[]>
  submitMove(gameId: number, uci: string): Promise<ArenaGameState>
  resign(gameId: number): Promise<ArenaGameState>
  /** POST /api/game/{id}/feedback — "I would never do this" on a persona
   *  move (spec 217 Promise 2). `ply` must name a persona move of this game;
   *  the note is optional free text. */
  submitMoveFeedback(gameId: number, ply: number, note?: string): Promise<void>
  /** POST /api/game/{id}/realism — post-game "felt like him" verdict (spec
   *  217 Tier 2). Finished games only; re-submitting updates the verdict. */
  submitGameRealism(gameId: number, verdict: ArenaRealismVerdict, note?: string): Promise<void>
  /** POST /api/game/{id}/share — mint (or fetch) the read-only family replay
   *  token for a finished game (spec 217 Tier 2). Idempotent. */
  shareGame(gameId: number): Promise<{ token: string }>
  /** DELETE /api/game/{id}/share — revoke the replay link. */
  revokeShare(gameId: number): Promise<void>
  /** GET /api/replay/{token} — read-only replay, no auth attached (the
   *  recipient has no login; the token is the capability). */
  getSharedReplay(token: string): Promise<ArenaSharedReplay>
  deleteGame(gameId: number): Promise<void>
  /** POST /api/exhibition — start a persona-vs-persona exhibition (spec 217
   *  Promise 3). Throws 409 when one is already running (one at a time). */
  createExhibition(whitePersona: string, blackPersona: string): Promise<ArenaExhibitionState>
  /** GET /api/exhibitions — every exhibition, family-shared, newest first. */
  listExhibitions(): Promise<ArenaExhibitionSummary[]>
  /** GET /api/exhibition/{id} — spectate poll (while active) and replay
   *  fetch (once finished), one endpoint. */
  getExhibition(exhibitionId: number): Promise<ArenaExhibitionState>
  /** POST /api/exhibition/{id}/stop — stop a running exhibition. */
  stopExhibition(exhibitionId: number): Promise<ArenaExhibitionState>
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
  clock: {
    initial_s: number
    increment_s: number
    white_ms: number
    black_ms: number
    running: ArenaColor | null
  } | null
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
    clock: g.clock
      ? {
          initialS: g.clock.initial_s,
          incrementS: g.clock.increment_s,
          whiteMs: g.clock.white_ms,
          blackMs: g.clock.black_ms,
          running: g.clock.running,
        }
      : null,
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

function exhibitionStateFromWire(e: {
  id: number
  white_persona: string
  black_persona: string
  white_name: string
  black_name: string
  status: ArenaGameStatus
  result: ArenaResult
  result_reason: string | null
  fen: string
  created_at: string
  updated_at: string
  moves: { ply: number; uci: string; san: string; arm: "book" | "search" | null }[]
}): ArenaExhibitionState {
  return {
    id: e.id,
    whitePersona: e.white_persona,
    blackPersona: e.black_persona,
    whiteName: e.white_name,
    blackName: e.black_name,
    status: e.status,
    result: e.result,
    resultReason: e.result_reason,
    fen: e.fen,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
    moves: e.moves,
  }
}

function exhibitionSummaryFromWire(e: {
  id: number
  white_persona: string
  black_persona: string
  white_name: string
  black_name: string
  status: ArenaGameStatus
  result: ArenaResult
  result_reason: string | null
  created_at: string
  updated_at: string
  n_moves: number
}): ArenaExhibitionSummary {
  return {
    id: e.id,
    whitePersona: e.white_persona,
    blackPersona: e.black_persona,
    whiteName: e.white_name,
    blackName: e.black_name,
    status: e.status,
    result: e.result,
    resultReason: e.result_reason,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
    movesCount: e.n_moves,
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

    async createGame(persona, playerColor, clock) {
      const g = await request<Parameters<typeof gameStateFromWire>[0]>("/api/game", {
        method: "POST",
        body: JSON.stringify({
          persona,
          player_color: playerColor,
          ...(clock
            ? { clock_initial_s: clock.initialS, clock_increment_s: clock.incrementS }
            : {}),
        }),
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

    async listPersonaRecords() {
      const res = await request<{ records: ArenaPersonaRecord[] }>("/api/stats")
      return res.records
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

    async submitMoveFeedback(gameId, ply, note) {
      await request<{ id: number; game_id: number; ply: number }>(`/api/game/${gameId}/feedback`, {
        method: "POST",
        body: JSON.stringify({ ply, note: note ?? "" }),
      })
    },

    async submitGameRealism(gameId, verdict, note) {
      await request<{ game_id: number; verdict: string }>(`/api/game/${gameId}/realism`, {
        method: "POST",
        body: JSON.stringify({ verdict, note: note ?? "" }),
      })
    },

    async shareGame(gameId) {
      return await request<{ token: string }>(`/api/game/${gameId}/share`, { method: "POST" })
    },

    async revokeShare(gameId) {
      await request<{ revoked: number }>(`/api/game/${gameId}/share`, { method: "DELETE" })
    },

    async getSharedReplay(token) {
      // auth=false: the whole point is that this works without a login — and
      // it also keeps a stale stored JWT from ever being attached to (or
      // cleared by) a public replay fetch.
      const r = await request<{
        persona: string
        player_color: ArenaColor
        player_name: string
        result: ArenaResult
        result_reason: string | null
        created_at: string
        moves: ArenaMove[]
      }>(`/api/replay/${encodeURIComponent(token)}`, undefined, false)
      return {
        persona: r.persona,
        playerColor: r.player_color,
        playerName: r.player_name,
        result: r.result,
        resultReason: r.result_reason,
        createdAt: r.created_at,
        moves: r.moves,
      }
    },

    async deleteGame(gameId) {
      await request<{ deleted: number }>(`/api/game/${gameId}`, { method: "DELETE" })
    },

    async createExhibition(whitePersona, blackPersona) {
      const e = await request<Parameters<typeof exhibitionStateFromWire>[0]>("/api/exhibition", {
        method: "POST",
        body: JSON.stringify({ white_persona: whitePersona, black_persona: blackPersona }),
      })
      return exhibitionStateFromWire(e)
    },

    async listExhibitions() {
      const res = await request<{ exhibitions: Parameters<typeof exhibitionSummaryFromWire>[0][] }>(
        "/api/exhibitions",
      )
      return res.exhibitions.map(exhibitionSummaryFromWire)
    },

    async getExhibition(exhibitionId) {
      const e = await request<Parameters<typeof exhibitionStateFromWire>[0]>(
        `/api/exhibition/${exhibitionId}`,
      )
      return exhibitionStateFromWire(e)
    },

    async stopExhibition(exhibitionId) {
      const e = await request<Parameters<typeof exhibitionStateFromWire>[0]>(
        `/api/exhibition/${exhibitionId}/stop`,
        { method: "POST" },
      )
      return exhibitionStateFromWire(e)
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

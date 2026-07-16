"use client"

// Persona Arena (spec 217 Tier 0) — a separate build entry from the main
// board app: login -> disclosure -> lobby -> game -> history, no Tauri-only
// tabs, no Tauri IPC anywhere on this path. `output: 'export'`
// (next.config.js) prerenders this route as its own static
// dist/arena/index.html alongside the main dist/index.html, so one
// `pnpm build` produces both entries.
//
// State is a small view machine, the same pattern app/page.tsx already uses
// for its own tab switching — no client router needed for a Tier-0
// single-session flow. Login comes before disclosure in the state machine
// but the disclosure-ack check itself needs no auth (pure localStorage), so
// a returning user who's still logged in skips straight to the lobby.

import { useCallback, useEffect, useState } from "react"
import { TooltipProvider } from "@chessgui/ui/ui/tooltip"
import { ErrorBoundary } from "@chessgui/ui/error-boundary"
import { LoginScreen } from "@chessgui/ui/arena/login-screen"
import { DisclosureScreen } from "@chessgui/ui/arena/disclosure-screen"
import { LobbyScreen } from "@chessgui/ui/arena/lobby-screen"
import { GameScreen } from "@chessgui/ui/arena/game-screen"
import { HistoryScreen } from "@chessgui/ui/arena/history-screen"
import { SharedReplayScreen } from "@chessgui/ui/arena/shared-replay-screen"
import { ExhibitionsScreen } from "@chessgui/ui/arena/exhibitions-screen"
import { ExhibitionScreen } from "@chessgui/ui/arena/exhibition-screen"
import { ackDisclosure, hasAckedDisclosure } from "@/lib/arena-disclosure"
import {
  ArenaApiError,
  getArenaApi,
  getStoredToken,
  setStoredToken,
  setUnauthorizedHandler,
  type ArenaUser,
} from "@chessgui/core/arena-api"
import { installArenaApiMock } from "@/lib/arena-api-mock"

// Headless-verification seam (mirrors app/page.tsx's window.__enterThinkingMode
// hook, documented in .claude/skills/verify): visiting /arena?mock=1 swaps the
// real fetch client (lib/arena-api.ts) for an in-memory mock BEFORE any
// component mounts, so the whole login -> disclosure -> lobby -> game ->
// history flow is drivable without a running homeserver backend. This runs
// at module scope (not inside an effect) so it lands before any child
// component's own mount effect could call the real API. Never set in a
// normal deployment.
if (typeof window !== "undefined") {
  const params = new URLSearchParams(window.location.search)
  if (params.get("mock") === "1") installArenaApiMock()
}

type ArenaView =
  | "login"
  | "disclosure"
  | "lobby"
  | "game"
  | "history"
  | "shared-replay"
  | "exhibitions"
  | "exhibition"

export default function ArenaPage() {
  // null until the mount effect resolves auth + disclosure-ack — avoids a
  // flash of the wrong screen before we know either (both are client-only:
  // a JWT in localStorage and a disclosure-ack flag in localStorage).
  const [view, setView] = useState<ArenaView | null>(null)
  const [user, setUser] = useState<ArenaUser | null>(null)
  const [activeGameId, setActiveGameId] = useState<number | null>(null)
  const [replayToken, setReplayToken] = useState<string | null>(null)
  // Spec 217 Promise 3: which persona-vs-persona exhibition is open (spectate
  // while active, replay once finished — one screen serves both).
  const [exhibitionId, setExhibitionId] = useState<number | null>(null)

  const afterAuthView = useCallback((): ArenaView => (hasAckedDisclosure() ? "lobby" : "disclosure"), [])

  useEffect(() => {
    // Family replay link (spec 217 Tier 2): ?replay=<token> opens the
    // read-only replay view and skips auth ENTIRELY — the recipient has no
    // login, and the token (checked server-side, no JWT) is the whole
    // capability. Checked before the token/login flow so a shared link never
    // bounces a logged-out family member to the Google sign-in screen.
    const replay = new URLSearchParams(window.location.search).get("replay")
    if (replay) {
      setReplayToken(replay)
      setView("shared-replay")
      return
    }

    setUnauthorizedHandler(() => {
      setUser(null)
      setActiveGameId(null)
      setExhibitionId(null)
      setView("login")
    })

    const token = getStoredToken()
    if (!token) {
      setView("login")
      return () => setUnauthorizedHandler(null)
    }
    // A stored token might be stale/expired — validate it with a lightweight
    // authed call before trusting it. A 401 here is handled by the
    // unauthorized handler above (bounces to "login"); any OTHER failure
    // (backend unreachable, network error) doesn't trap the user on a blank
    // screen — the lobby/game screens surface their own per-action errors.
    getArenaApi()
      .listPersonas()
      .then(() => setView(afterAuthView()))
      .catch((e) => {
        if (!(e instanceof ArenaApiError) || e.status !== 401) setView(afterAuthView())
      })

    return () => setUnauthorizedHandler(null)
  }, [afterAuthView])

  const onSignedIn = useCallback(
    (signedInUser: ArenaUser) => {
      setUser(signedInUser)
      setView(afterAuthView())
    },
    [afterAuthView],
  )

  const onAck = useCallback(() => {
    ackDisclosure()
    setView("lobby")
  }, [])

  const onGameStarted = useCallback((gameId: number) => {
    setActiveGameId(gameId)
    setView("game")
  }, [])

  const onOpenExhibition = useCallback((id: number) => {
    setExhibitionId(id)
    setView("exhibition")
  }, [])

  const signOut = useCallback(() => {
    setStoredToken(null)
    setUser(null)
    setActiveGameId(null)
    setExhibitionId(null)
    setView("login")
  }, [])

  if (view === null) {
    return (
      <div className="h-dvh flex items-center justify-center bg-[#0a0a0a] text-muted-foreground">
        Loading…
      </div>
    )
  }

  return (
    <ErrorBoundary>
      <TooltipProvider>
        {/* h-dvh, not h-screen (spec 223): mobile Safari's 100vh includes
            the collapsed URL bar, which would push the move list under it;
            dvh tracks the visible height. Identical on desktop. */}
        <div className="h-dvh flex flex-col bg-[#0a0a0a]" data-testid="arena-root">
          <header className="flex items-center justify-between px-6 py-3 border-b border-white/10">
            <span className="text-lg font-bold tracking-tight text-foreground">Persona Arena</span>
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-muted-foreground font-mono" title="version · commit · build date">
                v{process.env.NEXT_PUBLIC_APP_VERSION} · {process.env.NEXT_PUBLIC_BUILD_INFO}
              </span>
              {user && view !== "login" && (
                <button
                  onClick={signOut}
                  className="text-xs text-muted-foreground hover:text-foreground"
                  data-testid="arena-sign-out"
                >
                  Sign out ({user.email})
                </button>
              )}
            </div>
          </header>

          {view === "login" && <LoginScreen onSignedIn={onSignedIn} />}

          {view === "disclosure" && <DisclosureScreen onAck={onAck} />}

          {view === "lobby" && (
            <LobbyScreen
              onGameStarted={onGameStarted}
              onOpenHistory={() => setView("history")}
              onOpenExhibitions={() => setView("exhibitions")}
            />
          )}

          {view === "game" && activeGameId !== null && (
            <GameScreen gameId={activeGameId} onExit={() => setView("lobby")} />
          )}

          {view === "history" && <HistoryScreen onResume={onGameStarted} onBack={() => setView("lobby")} />}

          {view === "shared-replay" && replayToken !== null && (
            <SharedReplayScreen token={replayToken} />
          )}

          {view === "exhibitions" && (
            <ExhibitionsScreen
              onOpenExhibition={onOpenExhibition}
              onBack={() => setView("lobby")}
            />
          )}

          {view === "exhibition" && exhibitionId !== null && (
            <ExhibitionScreen exhibitionId={exhibitionId} onBack={() => setView("exhibitions")} />
          )}
        </div>
      </TooltipProvider>
    </ErrorBoundary>
  )
}

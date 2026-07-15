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
import { TooltipProvider } from "@/components/ui/tooltip"
import { ErrorBoundary } from "@/components/error-boundary"
import { LoginScreen } from "@/components/arena/login-screen"
import { DisclosureScreen } from "@/components/arena/disclosure-screen"
import { LobbyScreen } from "@/components/arena/lobby-screen"
import { GameScreen } from "@/components/arena/game-screen"
import { HistoryScreen } from "@/components/arena/history-screen"
import { ackDisclosure, hasAckedDisclosure } from "@/lib/arena-disclosure"
import {
  ArenaApiError,
  getArenaApi,
  getStoredToken,
  setStoredToken,
  setUnauthorizedHandler,
  type ArenaUser,
} from "@/lib/arena-api"
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

type ArenaView = "login" | "disclosure" | "lobby" | "game" | "history"

export default function ArenaPage() {
  // null until the mount effect resolves auth + disclosure-ack — avoids a
  // flash of the wrong screen before we know either (both are client-only:
  // a JWT in localStorage and a disclosure-ack flag in localStorage).
  const [view, setView] = useState<ArenaView | null>(null)
  const [user, setUser] = useState<ArenaUser | null>(null)
  const [activeGameId, setActiveGameId] = useState<number | null>(null)

  const afterAuthView = useCallback((): ArenaView => (hasAckedDisclosure() ? "lobby" : "disclosure"), [])

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null)
      setActiveGameId(null)
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

  const signOut = useCallback(() => {
    setStoredToken(null)
    setUser(null)
    setActiveGameId(null)
    setView("login")
  }, [])

  if (view === null) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#0a0a0a] text-muted-foreground">
        Loading…
      </div>
    )
  }

  return (
    <ErrorBoundary>
      <TooltipProvider>
        <div className="h-screen flex flex-col bg-[#0a0a0a]" data-testid="arena-root">
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
            <LobbyScreen onGameStarted={onGameStarted} onOpenHistory={() => setView("history")} />
          )}

          {view === "game" && activeGameId !== null && (
            <GameScreen gameId={activeGameId} onExit={() => setView("lobby")} />
          )}

          {view === "history" && <HistoryScreen onResume={onGameStarted} onBack={() => setView("lobby")} />}
        </div>
      </TooltipProvider>
    </ErrorBoundary>
  )
}

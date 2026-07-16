"use client"

// Persona Arena login (spec 217 Auth: "Google auth ported from the golf
// app... invite-only allowlist"). The real backend (server/arena/app/main.py
// + auth.py) issues a JWT from a Google Identity Services (GIS) ID token —
// there is no separate hosted login PAGE to redirect to, so this screen
// renders Google's own Sign-In button client-side via the GIS script.
//
// NEXT_PUBLIC_ARENA_GOOGLE_CLIENT_ID must match the backend's
// GOOGLE_CLIENT_ID (server/arena/.env.example) — it is a public OAuth client
// ID, not a secret, safe to bundle into a static export.

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { getArenaApi, setStoredToken, ArenaApiError, type ArenaUser } from "@chessgui/core/arena-api"

const GIS_SRC = "https://accounts.google.com/gsi/client"
const CLIENT_ID = process.env.NEXT_PUBLIC_ARENA_GOOGLE_CLIENT_ID ?? ""

interface GoogleCredentialResponse {
  credential: string
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (opts: {
            client_id: string
            callback: (resp: GoogleCredentialResponse) => void
          }) => void
          renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void
        }
      }
    }
  }
}

function loadGisScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve()
  if (window.google?.accounts?.id) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`)
    if (existing) {
      existing.addEventListener("load", () => resolve())
      existing.addEventListener("error", () => reject(new Error("Failed to load Google Sign-In")))
      return
    }
    const script = document.createElement("script")
    script.src = GIS_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error("Failed to load Google Sign-In"))
    document.head.appendChild(script)
  })
}

export function LoginScreen({ onSignedIn }: { onSignedIn: (user: ArenaUser) => void }) {
  const buttonRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [gisReady, setGisReady] = useState(false)
  // Whether a mock API client is active (window.__ARENA_API__, installed by
  // app/arena/page.tsx behind ?mock=1) — purely a headless-verification
  // affordance so the login step is drivable without real Google credentials.
  // Never true against the real backend.
  const [mockActive, setMockActive] = useState(false)

  useEffect(() => {
    setMockActive(
      typeof window !== "undefined" &&
        !!(window as unknown as { __ARENA_API__?: unknown }).__ARENA_API__,
    )
  }, [])

  const completeLogin = async (idToken: string) => {
    setError(null)
    try {
      const { token, user } = await getArenaApi().googleLogin(idToken)
      setStoredToken(token)
      onSignedIn(user)
    } catch (e) {
      setError(e instanceof ArenaApiError ? e.message : "Sign-in failed.")
    }
  }

  useEffect(() => {
    if (!CLIENT_ID) return
    let cancelled = false
    loadGisScript()
      .then(() => {
        if (cancelled || !window.google || !buttonRef.current) return
        window.google.accounts.id.initialize({
          client_id: CLIENT_ID,
          callback: (resp) => completeLogin(resp.credential),
        })
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: "outline",
          size: "large",
          text: "signin_with",
        })
        setGisReady(true)
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Sign-in failed to load."))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex-1 flex items-center justify-center p-6" data-testid="arena-login">
      <div className="max-w-sm w-full space-y-5 text-center">
        <h1 className="text-2xl font-bold">Sign in</h1>
        <p className="text-sm text-muted-foreground">
          Persona Arena is invite-only — sign in with the Google account you were invited with.
        </p>

        {!CLIENT_ID && (
          <p className="text-xs text-amber-300" data-testid="arena-login-no-client-id">
            Google Sign-In isn&apos;t configured on this build (NEXT_PUBLIC_ARENA_GOOGLE_CLIENT_ID
            unset).
          </p>
        )}

        <div ref={buttonRef} className="flex justify-center" data-testid="arena-login-gis-button" />

        {CLIENT_ID && !gisReady && !error && (
          <p className="text-xs text-muted-foreground">Loading Google Sign-In…</p>
        )}

        {error && (
          <p className="text-sm text-red-400" data-testid="arena-login-error">
            {error}
          </p>
        )}

        {/* Headless-verification affordance only (see mockActive above) —
            bypasses real Google Sign-In when a mock API client is installed. */}
        {mockActive && (
          <Button
            variant="outline"
            onClick={() => completeLogin("mock-id-token")}
            data-testid="arena-login-mock"
          >
            Continue (mock session)
          </Button>
        )}
      </div>
    </div>
  )
}

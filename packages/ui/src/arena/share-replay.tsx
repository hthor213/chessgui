"use client"

// Family replay link control (spec 217 Tier 2: "spectator/replay links
// shareable in the family"). Rendered on the game-over panel and the history
// replay view for a FINISHED game: one tap asks the server to mint (or hand
// back — the endpoint is idempotent) the game's unguessable share token, and
// the resulting URL opens a read-only replay WITHOUT login
// (shared-replay-screen.tsx via /arena?replay=<token>). Revoke kills the
// link server-side; deleting the game does too.

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@chessgui/ui/ui/button"
import { ArenaApiError, getArenaApi } from "@chessgui/core/arena-api"
import { arenaReplayUrl } from "@/lib/arena-moves"

export function ShareReplayControl({ gameId }: { gameId: number }) {
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const share = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const { token } = await getArenaApi().shareGame(gameId)
      setUrl(arenaReplayUrl(token))
    } catch (e) {
      setError(e instanceof ArenaApiError ? e.message : "Couldn't create the link.")
    } finally {
      setBusy(false)
    }
  }, [gameId])

  const copy = useCallback(async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard unavailable (permissions, non-secure context) — the URL is
      // visible in the read-only input below, so manual copy still works.
      setError("Couldn't copy automatically — select the link and copy it.")
    }
  }, [url])

  const revoke = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await getArenaApi().revokeShare(gameId)
      setUrl(null)
    } catch (e) {
      setError(e instanceof ArenaApiError ? e.message : "Couldn't revoke the link.")
    } finally {
      setBusy(false)
    }
  }, [gameId])

  return (
    <div className="flex flex-col gap-1.5" data-testid="arena-share">
      {url === null ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={share}
          disabled={busy}
          data-testid="arena-share-button"
        >
          Share replay
        </Button>
      ) : (
        <>
          <span className="text-[11px] text-muted-foreground">
            Anyone with this link can watch the game — no login needed.
          </span>
          <input
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full bg-white/[0.03] border border-white/10 rounded-md px-2 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-white/20"
            data-testid="arena-share-url"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={copy} data-testid="arena-share-copy">
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={revoke}
              disabled={busy}
              data-testid="arena-share-revoke"
            >
              Revoke
            </Button>
          </div>
        </>
      )}
      {error && (
        <p className="text-xs text-red-400" data-testid="arena-share-error">
          {error}
        </p>
      )}
    </div>
  )
}

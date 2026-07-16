"use client"

// Persona Arena lobby (spec 217 Tier 0) — roster cards for the 3 playable
// personas plus greyed "coming soon" cards for the rest of the committed GM
// roster (lib/arena-roster.ts), plus — spec 217 Promise 1 — the logged-in
// player's OWN private persona when the backend returns one (per-user
// gating happens server-side; see mergeApiPersonas). Picking a side and
// clicking Play calls the
// real backend's create-game endpoint (lib/arena-api.ts, matching
// server/arena/app/main.py) and hands the new game id to the parent, which
// switches to the game screen. "Random" is resolved to a concrete color
// client-side — the real CreateGameRequest requires `player_color` to
// already be 'white' or 'black' (no server-side random resolution).

import { useCallback, useEffect, useMemo, useState } from "react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { buildArenaRoster, mergeApiPersonas, type ArenaRosterEntry } from "@/lib/arena-roster"
import {
  getArenaApi,
  ArenaApiError,
  type ArenaColor,
  type ArenaPersonaInfo,
  type ArenaSideChoice,
} from "@chessgui/core/arena-api"

function resolveColor(choice: ArenaSideChoice): ArenaColor {
  return choice === "random" ? (Math.random() < 0.5 ? "white" : "black") : choice
}

export function LobbyScreen({
  onGameStarted,
  onOpenHistory,
}: {
  onGameStarted: (gameId: number) => void
  onOpenHistory: () => void
}) {
  // Per-user personas from the backend (spec 217 Promise 1: your OWN private
  // persona appears in your lobby and nobody else's — the server decides, the
  // client just merges). A failed fetch degrades to the static GM roster;
  // starting a game surfaces its own error.
  const [apiPersonas, setApiPersonas] = useState<ArenaPersonaInfo[]>([])
  useEffect(() => {
    let cancelled = false
    getArenaApi()
      .listPersonas()
      .then((res) => {
        if (!cancelled) setApiPersonas(res.personas)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  const roster = useMemo(() => mergeApiPersonas(buildArenaRoster(), apiPersonas), [apiPersonas])
  const [sideBySlug, setSideBySlug] = useState<Record<string, ArenaSideChoice>>({})
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const play = useCallback(
    async (slug: string) => {
      setPending(slug)
      setError(null)
      try {
        const color = resolveColor(sideBySlug[slug] ?? "random")
        const game = await getArenaApi().createGame(slug, color)
        onGameStarted(game.id)
      } catch (e) {
        setError(e instanceof ArenaApiError ? e.message : "Couldn't start the game.")
      } finally {
        setPending(null)
      }
    },
    [sideBySlug, onGameStarted],
  )

  return (
    <div className="flex-1 min-h-0 overflow-auto p-6" data-testid="arena-lobby">
      <div className="max-w-3xl mx-auto space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Persona Arena</h1>
            <p className="text-muted-foreground mt-1">
              &ldquo;Best per capita :-)&rdquo; — pick an opponent. Every card states its honest,
              measured strength.
            </p>
          </div>
          <Button variant="outline" onClick={onOpenHistory} data-testid="arena-open-history">
            My games
          </Button>
        </div>

        {error && (
          <p className="text-sm text-red-400" data-testid="arena-lobby-error">
            {error}
          </p>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3" data-testid="arena-roster-grid">
          {roster.map((entry) => (
            <RosterCard
              key={entry.slug}
              entry={entry}
              side={sideBySlug[entry.slug] ?? "random"}
              onSideChange={(s) => setSideBySlug((prev) => ({ ...prev, [entry.slug]: s }))}
              onPlay={() => play(entry.slug)}
              pending={pending === entry.slug}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

const SIDE_OPTIONS: { id: ArenaSideChoice; label: string }[] = [
  { id: "random", label: "Random" },
  { id: "white", label: "White" },
  { id: "black", label: "Black" },
]

function RosterCard({
  entry,
  side,
  onSideChange,
  onPlay,
  pending,
}: {
  entry: ArenaRosterEntry
  side: ArenaSideChoice
  onSideChange: (s: ArenaSideChoice) => void
  onPlay: () => void
  pending: boolean
}) {
  return (
    <div
      className={`rounded-lg border border-white/10 bg-white/[0.03] p-4 flex flex-col gap-3 ${
        entry.available ? "" : "opacity-50"
      }`}
      data-testid={`arena-roster-card-${entry.slug}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <Avatar className="h-10 w-10 shrink-0">
          <AvatarFallback>{entry.initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">
            {entry.displayName}
            {entry.isPrivate && (
              <span
                className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 align-middle"
                data-testid={`arena-private-${entry.slug}`}
              >
                Only in your lobby
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">{entry.strengthLabel}</div>
        </div>
      </div>

      {entry.available ? (
        <>
          <div className="flex gap-1">
            {SIDE_OPTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => onSideChange(s.id)}
                data-testid={`arena-side-${entry.slug}-${s.id}`}
                className={`px-2 py-1 text-xs rounded-md border transition-colors ${
                  side === s.id
                    ? "border-white/30 bg-white/10 text-foreground"
                    : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <Button size="sm" onClick={onPlay} disabled={pending} data-testid={`arena-play-${entry.slug}`}>
            {pending ? "Starting…" : "Play"}
          </Button>
        </>
      ) : (
        <span
          className="inline-block self-start px-2 py-0.5 rounded-full text-[11px] font-medium bg-white/5 text-muted-foreground border border-white/10"
          data-testid={`arena-coming-soon-${entry.slug}`}
        >
          Coming soon
        </span>
      )}
    </div>
  )
}

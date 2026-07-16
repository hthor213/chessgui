"use client"

// Persona-vs-persona exhibit hall (spec 217 Promise 3: "watch Fischer vs
// Kasparov, who never played each other"). Two pickers + Start, above the
// family-shared list of every exhibition — live ones open into the spectate
// view, finished ones into the replay (both are ExhibitionScreen; the server
// serves one shape for both). The roster offered here is the PUBLIC roster
// only: the server refuses private personas in exhibitions (a spectatable
// game would leak their existence), so the pickers never offer one.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@chessgui/ui/ui/button"
import { buildArenaRoster } from "@/lib/arena-roster"
import { arenaExhibitionStatusLabel } from "@/lib/arena-moves"
import {
  ArenaApiError,
  getArenaApi,
  type ArenaExhibitionSummary,
} from "@chessgui/core/arena-api"

interface PickerEntry {
  slug: string
  displayName: string
}

export function ExhibitionsScreen({
  onOpenExhibition,
  onBack,
}: {
  onOpenExhibition: (exhibitionId: number) => void
  onBack: () => void
}) {
  // Pickers offer the server's playable public personas; a failed fetch
  // degrades to the static unlocked roster (same posture as the lobby).
  const staticRoster = useMemo<PickerEntry[]>(
    () =>
      buildArenaRoster()
        .filter((e) => e.available)
        .map((e) => ({ slug: e.slug, displayName: e.displayName })),
    [],
  )
  const [personas, setPersonas] = useState<PickerEntry[]>(staticRoster)
  useEffect(() => {
    let cancelled = false
    getArenaApi()
      .listPersonas()
      .then((res) => {
        const pub = res.personas
          .filter((p) => !p.isPrivate)
          .map((p) => ({ slug: p.slug, displayName: p.displayName }))
        if (!cancelled && pub.length > 0) setPersonas(pub)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // The marquee matchup (spec 217: "fun to watch Fischer vs Kasparov, who
  // never played each other") is the default when both are on the roster.
  const [white, setWhite] = useState("fischer")
  const [black, setBlack] = useState("kasparov")
  useEffect(() => {
    // Reconcile the picks when the roster changes (functional updates keep
    // the current pick when it's still offered, without depending on it).
    const slugs = new Set(personas.map((p) => p.slug))
    setWhite((w) => (slugs.has(w) ? w : personas[0]?.slug ?? ""))
    setBlack((b) => (slugs.has(b) ? b : personas[Math.min(1, personas.length - 1)]?.slug ?? ""))
  }, [personas])

  const [exhibitions, setExhibitions] = useState<ArenaExhibitionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const load = useCallback(async () => {
    try {
      setExhibitions(await getArenaApi().listExhibitions())
    } catch (e) {
      setError(e instanceof ArenaApiError ? e.message : "Couldn't load exhibitions.")
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const start = useCallback(async () => {
    if (!white || !black) return
    setStarting(true)
    setError(null)
    try {
      const ex = await getArenaApi().createExhibition(white, black)
      onOpenExhibition(ex.id)
    } catch (e) {
      // The 409 here is the one-at-a-time resource policy — surface the
      // server's own wording rather than a generic failure.
      setError(e instanceof ArenaApiError ? e.message : "Couldn't start the exhibition.")
    } finally {
      setStarting(false)
    }
  }, [white, black, onOpenExhibition])

  const selectClass =
    "bg-white/[0.03] border border-white/10 rounded-md px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-white/20"

  return (
    <div className="flex-1 min-h-0 overflow-auto p-6" data-testid="arena-exhibitions">
      <div className="max-w-2xl mx-auto space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Exhibitions</h1>
            <p className="text-muted-foreground mt-1">
              Let the personas compete — Fischer vs Kasparov never happened, until now.
            </p>
          </div>
          <Button variant="ghost" onClick={onBack} data-testid="arena-exhibitions-back">
            ‹ Lobby
          </Button>
        </div>

        <div
          className="rounded-lg border border-white/10 bg-white/[0.03] p-4 flex flex-wrap items-end gap-3"
          data-testid="arena-exhibition-create"
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            White
            <select
              className={selectClass}
              value={white}
              onChange={(e) => setWhite(e.target.value)}
              data-testid="arena-exhibition-white"
            >
              {personas.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Black
            <select
              className={selectClass}
              value={black}
              onChange={(e) => setBlack(e.target.value)}
              data-testid="arena-exhibition-black"
            >
              {personas.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            onClick={start}
            disabled={starting || !white || !black}
            data-testid="arena-exhibition-start"
          >
            {starting ? "Starting…" : "Start exhibition"}
          </Button>
          <span className="text-[11px] text-muted-foreground basis-full">
            One exhibition runs at a time, at low priority — live games always come first.
          </span>
        </div>

        {error && (
          <p className="text-sm text-red-400" data-testid="arena-exhibitions-error">
            {error}
          </p>
        )}

        {!exhibitions ? (
          <p className="text-sm text-muted-foreground" data-testid="arena-exhibitions-loading">
            Loading…
          </p>
        ) : exhibitions.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="arena-exhibitions-empty">
            No exhibitions yet — start one above.
          </p>
        ) : (
          <div className="flex flex-col gap-2" data-testid="arena-exhibitions-list">
            {exhibitions.map((ex) => (
              <button
                key={ex.id}
                onClick={() => onOpenExhibition(ex.id)}
                className="rounded-lg border border-white/10 bg-white/[0.03] p-3 flex items-center justify-between gap-3 text-left hover:bg-white/[0.06] transition-colors"
                data-testid={`arena-exhibition-row-${ex.id}`}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {ex.whiteName} vs {ex.blackName}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {ex.movesCount} moves · {new Date(ex.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${
                    ex.status === "active"
                      ? "border-emerald-400/40 text-emerald-300"
                      : "border-white/10 text-muted-foreground"
                  }`}
                >
                  {ex.status === "active"
                    ? "Live"
                    : arenaExhibitionStatusLabel(ex) ?? "Finished"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

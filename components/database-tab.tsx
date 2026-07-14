"use client"

// Database tab (spec 200): browse the game database, filter/sort the game list,
// import PGN, delete games, and search for the current board position with a
// next-move breakdown (the seed of the opening explorer).
//
// All data access goes through lib/database.ts, which transparently routes to
// the Rust backend inside Tauri or to an in-memory mock in a plain browser — so
// this component renders and is drivable identically in both.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  deleteGames,
  getGame,
  importPgn,
  listGames,
  searchPosition,
  stats as dbStats,
  type GameFilter,
  type GameHeader,
  type ImportReport,
  type PositionHit,
  type Sort,
  type SortColumn,
} from "@/lib/database"

const PAGE_SIZE = 50

type DatabaseTabProps = {
  /** Current board FEN — the explorer panel searches (and re-searches) this
   *  position automatically as the user plays or navigates moves. */
  currentFen?: string
  /** Load a game's PGN onto the board (parent parses + switches to the board). */
  onLoadGame: (pgn: string) => void
  /** Play a move (UCI) from the explorer panel onto the board's current game,
   *  without leaving the Database tab — lets the user click through the
   *  opening tree the way the position search panel is aggregated. */
  onPlayMove?: (uci: string) => void
}

/** Empty draft for the filter bar. */
const EMPTY_FILTER: GameFilter = {}

export function DatabaseTab({ currentFen, onLoadGame, onPlayMove }: DatabaseTabProps) {
  const [draft, setDraft] = useState<GameFilter>(EMPTY_FILTER)
  const [applied, setApplied] = useState<GameFilter>(EMPTY_FILTER)
  const [sort, setSort] = useState<Sort | undefined>(undefined)
  const [page, setPage] = useState(0)

  const [rows, setRows] = useState<GameHeader[]>([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const [importOpen, setImportOpen] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  const [hits, setHits] = useState<PositionHit[] | null>(null)
  const [searching, setSearching] = useState(false)

  // Ignore out-of-order responses when filters change rapidly.
  const reqId = useRef(0)
  // Same pattern, scoped to the position-search panel (separate counter so a
  // fast game-list refresh and a fast explorer re-search never race each other).
  const posReqId = useRef(0)

  // Debounce filter drafts into the applied filter (live search).
  useEffect(() => {
    const t = setTimeout(() => {
      setApplied(draft)
      setPage(0)
    }, 300)
    return () => clearTimeout(t)
  }, [draft])

  const refresh = useCallback(async () => {
    const id = ++reqId.current
    setLoading(true)
    try {
      const [list, s] = await Promise.all([
        listGames(applied, PAGE_SIZE, page * PAGE_SIZE, sort),
        dbStats(),
      ])
      if (id !== reqId.current) return
      setRows(list)
      setCount(s.games)
    } finally {
      if (id === reqId.current) setLoading(false)
    }
  }, [applied, page, sort])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Drop stale selections whenever the visible rows change.
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(rows.map((r) => r.id))
      const next = new Set<number>()
      for (const id of prev) if (visible.has(id)) next.add(id)
      return next
    })
  }, [rows])

  const toggleSort = useCallback((col: SortColumn) => {
    setSort((prev) => {
      if (prev?.by === col) {
        return { by: col, dir: prev.dir === "asc" ? "desc" : "asc" }
      }
      return { by: col, dir: "asc" }
    })
    setPage(0)
  }, [])

  const openGame = useCallback(
    async (id: number) => {
      const pgn = await getGame(id)
      if (pgn) onLoadGame(pgn)
    },
    [onLoadGame],
  )

  const onImported = useCallback(
    (report: ImportReport) => {
      setBanner(
        `Imported ${report.imported} game(s), skipped ${report.dups_skipped} duplicate(s)` +
          (report.errors ? `, ${report.errors} error(s)` : ""),
      )
      setImportOpen(false)
      void refresh()
    },
    [refresh],
  )

  const removeSelected = useCallback(async () => {
    if (selected.size === 0) return
    if (!confirm(`Delete ${selected.size} selected game(s)? This cannot be undone.`)) return
    const removed = await deleteGames([...selected])
    setBanner(`Deleted ${removed} game(s)`)
    setSelected(new Set())
    void refresh()
  }, [selected, refresh])

  const findPosition = useCallback(async (fen: string) => {
    const id = ++posReqId.current
    setSearching(true)
    try {
      const found = await searchPosition(fen, 500)
      if (id === posReqId.current) setHits(found)
    } finally {
      if (id === posReqId.current) setSearching(false)
    }
  }, [])

  // Auto-update the explorer panel as the user plays or navigates moves on
  // the board — debounced so rapid navigation (holding an arrow key, or a
  // string of explorer click-throughs) doesn't flood the backend with a
  // search per intermediate position.
  useEffect(() => {
    if (!currentFen) {
      setHits(null)
      return
    }
    const t = setTimeout(() => void findPosition(currentFen), 200)
    return () => clearTimeout(t)
  }, [currentFen, findPosition])

  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (rows.every((r) => prev.has(r.id))) return new Set()
      return new Set(rows.map((r) => r.id))
    })
  }, [rows])

  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE))

  return (
    <div className="h-full overflow-y-auto p-6" data-testid="database-tab">
      <div className="mx-auto max-w-6xl flex flex-col gap-4">
        {/* Header: title, stats, import */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium">Game Database</h2>
            <p className="text-sm text-muted-foreground" data-testid="db-stats">
              {count.toLocaleString()} game{count === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {selected.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={removeSelected}
                data-testid="db-delete-selected"
              >
                Delete {selected.size}
              </Button>
            )}
            <Button size="sm" onClick={() => setImportOpen(true)} data-testid="db-import-open">
              Import PGN
            </Button>
          </div>
        </div>

        {banner && (
          <div
            className="px-4 py-2 text-sm text-emerald-200 bg-emerald-900/30 border border-emerald-700/30 rounded-md flex items-center justify-between"
            data-testid="db-banner"
          >
            <span>{banner}</span>
            <button className="text-emerald-300/70 hover:text-emerald-200" onClick={() => setBanner(null)}>
              ×
            </button>
          </div>
        )}

        {/* Filter bar */}
        <FilterBar draft={draft} setDraft={setDraft} />

        {/* Games table */}
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="db-games-table">
              <thead className="bg-secondary/40 text-muted-foreground">
                <tr>
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={allOnPageSelected}
                      onChange={toggleAll}
                      aria-label="Select all"
                      data-testid="db-select-all"
                    />
                  </th>
                  <SortHeader label="White" col="white" sort={sort} onSort={toggleSort} />
                  <SortHeader label="Elo" col="white_elo" sort={sort} onSort={toggleSort} align="right" />
                  <SortHeader label="Black" col="black" sort={sort} onSort={toggleSort} />
                  <SortHeader label="Elo" col="black_elo" sort={sort} onSort={toggleSort} align="right" />
                  <SortHeader label="Result" col="result" sort={sort} onSort={toggleSort} align="center" />
                  <SortHeader label="Event" col="event" sort={sort} onSort={toggleSort} />
                  <SortHeader label="Date" col="date" sort={sort} onSort={toggleSort} />
                  <SortHeader label="ECO" col="eco" sort={sort} onSort={toggleSort} />
                  <SortHeader label="Ply" col="ply_count" sort={sort} onSort={toggleSort} align="right" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-border hover:bg-white/5 cursor-pointer"
                    onClick={() => openGame(r.id)}
                    data-testid={`db-row-${r.id}`}
                  >
                    <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={(e) => {
                          setSelected((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(r.id)
                            else next.delete(r.id)
                            return next
                          })
                        }}
                        aria-label={`Select game ${r.id}`}
                      />
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{r.white || "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.white_elo ?? ""}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{r.black || "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.black_elo ?? ""}</td>
                    <td className="px-3 py-1.5 text-center whitespace-nowrap">{r.result}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap max-w-[16rem] truncate" title={r.event}>{r.event}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">{r.date}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{r.eco}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.ply_count}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-3 py-8 text-center text-muted-foreground" data-testid="db-empty">
                      {loading ? "Loading…" : "No games match the current filters."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {count > 0
              ? `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, count)} of ${count.toLocaleString()}`
              : "—"}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              data-testid="db-prev-page"
            >
              Prev
            </Button>
            <span data-testid="db-page-indicator">
              {page + 1} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page + 1 >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              data-testid="db-next-page"
            >
              Next
            </Button>
          </div>
        </div>

        {/* Position search (opening-explorer seed) — auto-updates as the
            board's current position changes; click a move to play it. */}
        <div className="border border-border rounded-lg p-4 flex flex-col gap-3" data-testid="db-position-search">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium">Position search</h3>
              <p className="text-xs text-muted-foreground">
                Every game reaching the current board position, grouped by the next move. Updates
                as you play or navigate; click a move to play it.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => currentFen && void findPosition(currentFen)}
              disabled={!currentFen || searching}
              data-testid="db-find-position"
            >
              {searching ? "Searching…" : "Refresh"}
            </Button>
          </div>
          {hits && <PositionResults hits={hits} onPlayMove={onPlayMove} />}
        </div>
      </div>

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={onImported} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function FilterBar({
  draft,
  setDraft,
}: {
  draft: GameFilter
  setDraft: (f: GameFilter) => void
}) {
  const set = (patch: Partial<GameFilter>) => setDraft({ ...draft, ...patch })
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2" data-testid="db-filters">
      <Input
        placeholder="Player"
        value={draft.player ?? ""}
        onChange={(e) => set({ player: e.target.value })}
        data-testid="db-filter-player"
      />
      <Input
        placeholder="Event"
        value={draft.event ?? ""}
        onChange={(e) => set({ event: e.target.value })}
        data-testid="db-filter-event"
      />
      <Input
        placeholder="ECO (e.g. B90)"
        value={draft.eco ?? ""}
        onChange={(e) => set({ eco: e.target.value })}
        data-testid="db-filter-eco"
      />
      <select
        className="h-10 rounded-md border border-input bg-background px-3 text-sm"
        value={draft.result ?? ""}
        onChange={(e) => set({ result: e.target.value || undefined })}
        data-testid="db-filter-result"
      >
        <option value="">Any result</option>
        <option value="1-0">1-0</option>
        <option value="0-1">0-1</option>
        <option value="1/2-1/2">½-½</option>
      </select>
      <Input
        type="number"
        placeholder="Min Elo"
        value={draft.min_elo ?? ""}
        onChange={(e) => set({ min_elo: e.target.value ? Number(e.target.value) : undefined })}
        data-testid="db-filter-min-elo"
      />
      <Input
        placeholder="Date from"
        value={draft.date_from ?? ""}
        onChange={(e) => set({ date_from: e.target.value })}
        data-testid="db-filter-date-from"
      />
      <Input
        placeholder="Date to"
        value={draft.date_to ?? ""}
        onChange={(e) => set({ date_to: e.target.value })}
        data-testid="db-filter-date-to"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sortable header cell
// ---------------------------------------------------------------------------

function SortHeader({
  label,
  col,
  sort,
  onSort,
  align = "left",
}: {
  label: string
  col: SortColumn
  sort: Sort | undefined
  onSort: (col: SortColumn) => void
  align?: "left" | "right" | "center"
}) {
  const active = sort?.by === col
  const arrow = active ? (sort!.dir === "asc" ? " ↑" : " ↓") : ""
  const alignCls = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
  return (
    <th className={`px-3 py-2 font-medium ${alignCls}`}>
      <button
        className={`hover:text-foreground ${active ? "text-foreground" : ""}`}
        onClick={() => onSort(col)}
        data-testid={`db-sort-${col}`}
      >
        {label}
        {arrow}
      </button>
    </th>
  )
}

// ---------------------------------------------------------------------------
// Position search results — grouped by next move with a W/D/L bar
// ---------------------------------------------------------------------------

type MoveGroup = {
  san: string
  uci: string | null
  total: number
  whiteWins: number
  draws: number
  blackWins: number
  avgElo: number | null
}

function aggregate(hits: PositionHit[]): MoveGroup[] {
  const groups = new Map<string, MoveGroup>()
  for (const h of hits) {
    const key = h.next_san ?? "(end of game)"
    let g = groups.get(key)
    if (!g) {
      g = { san: key, uci: h.next_uci, total: 0, whiteWins: 0, draws: 0, blackWins: 0, avgElo: null }
      groups.set(key, g)
    }
    g.total += 1
    if (h.result === "1-0") g.whiteWins += 1
    else if (h.result === "1/2-1/2") g.draws += 1
    else if (h.result === "0-1") g.blackWins += 1
    const elos = [h.white_elo, h.black_elo].filter((e): e is number => e != null)
    if (elos.length) {
      const mean = elos.reduce((a, b) => a + b, 0) / elos.length
      g.avgElo = g.avgElo == null ? mean : (g.avgElo * (g.total - 1) + mean) / g.total
    }
  }
  return [...groups.values()].sort((a, b) => b.total - a.total)
}

function PositionResults({
  hits,
  onPlayMove,
}: {
  hits: PositionHit[]
  onPlayMove?: (uci: string) => void
}) {
  const groups = useMemo(() => aggregate(hits), [hits])
  if (hits.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="db-position-empty">
        No games in the database reach this position.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1" data-testid="db-position-results">
      <p className="text-xs text-muted-foreground">
        {hits.length} game{hits.length === 1 ? "" : "s"} · {groups.length} move
        {groups.length === 1 ? "" : "s"}
      </p>
      {groups.map((g) => {
        // "(end of game)" groups (no next move) and a missing UCI (shouldn't
        // happen for a real move, but the type allows it) aren't playable.
        const playable = !!g.uci && !!onPlayMove
        return (
          <div
            key={g.san}
            className={`flex items-center gap-3 rounded px-1 -mx-1 py-0.5 ${
              playable ? "cursor-pointer hover:bg-white/5" : ""
            }`}
            data-testid={`db-move-${g.san}`}
            onClick={playable ? () => onPlayMove!(g.uci!) : undefined}
            role={playable ? "button" : undefined}
            tabIndex={playable ? 0 : undefined}
            title={playable ? `Play ${g.san}` : undefined}
            onKeyDown={
              playable
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      onPlayMove!(g.uci!)
                    }
                  }
                : undefined
            }
          >
            <span className="w-20 font-mono text-sm">{g.san}</span>
            <span className="w-14 text-right tabular-nums text-sm text-muted-foreground">{g.total}</span>
            <div className="flex-1 h-4 rounded overflow-hidden flex bg-secondary" title={`+${g.whiteWins} =${g.draws} -${g.blackWins}`}>
              <div className="bg-neutral-100" style={{ width: `${(g.whiteWins / g.total) * 100}%` }} />
              <div className="bg-neutral-400" style={{ width: `${(g.draws / g.total) * 100}%` }} />
              <div className="bg-neutral-700" style={{ width: `${(g.blackWins / g.total) * 100}%` }} />
            </div>
            <span className="w-14 text-right tabular-nums text-xs text-muted-foreground">
              {g.avgElo != null ? Math.round(g.avgElo) : ""}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Import dialog — paste or pick a .pgn file
// ---------------------------------------------------------------------------

function ImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (report: ImportReport) => void
}) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const runImport = useCallback(
    async (pgn: string, source: string) => {
      if (!pgn.trim()) {
        setError("Paste some PGN or choose a file first.")
        return
      }
      setBusy(true)
      setError(null)
      try {
        const report = await importPgn({ source, text: pgn })
        setText("")
        onImported(report)
      } catch (e) {
        setError(typeof e === "string" ? e : "Import failed.")
      } finally {
        setBusy(false)
      }
    },
    [onImported],
  )

  const handleFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = "" // allow re-picking the same file
      if (!file) return
      const content = await file.text()
      await runImport(content, file.name)
    },
    [runImport],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="db-import-dialog">
        <DialogHeader>
          <DialogTitle>Import PGN</DialogTitle>
          <DialogDescription>
            Paste PGN text or choose a .pgn file. Exact duplicates are skipped automatically.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          className="h-48 font-mono text-xs"
          placeholder="[Event &quot;…&quot;]&#10;1. e4 e5 …"
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="db-import-text"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pgn,.txt"
          className="hidden"
          onChange={handleFile}
          data-testid="db-import-file"
        />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            data-testid="db-import-file-button"
          >
            Choose file…
          </Button>
          <Button
            onClick={() => runImport(text, "paste")}
            disabled={busy}
            data-testid="db-import-submit"
          >
            {busy ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

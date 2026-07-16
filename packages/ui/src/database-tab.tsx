"use client"

// Database tab (spec 200): browse the game database, filter/sort the game list,
// import PGN, delete games, and search for the current board position with a
// next-move breakdown (the seed of the opening explorer).
//
// All data access goes through lib/database.ts, which transparently routes to
// the Rust backend inside Tauri or to an in-memory mock in a plain browser — so
// this component renders and is drivable identically in both.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@chessgui/ui/ui/button"
import { Input } from "@chessgui/ui/ui/input"
import { Textarea } from "@chessgui/ui/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@chessgui/ui/ui/dialog"
import {
  addTag,
  cancelCbhImport,
  deleteGames,
  getGame,
  importCbh,
  importPgn,
  isTauri,
  listGames,
  listTags,
  removeTag,
  searchPosition,
  stats as dbStats,
  type CbhImportProgress,
  type GameFilter,
  type GameHeader,
  type ImportReport,
  type PgnImportProgress,
  type PositionHit,
  type Sort,
  type SortColumn,
} from "@/lib/database"
import { pickFile } from "@/lib/dialog"
import {
  aggregateHits,
  moverFromFen,
  sortGroups,
  type ExplorerSort,
  type MoveGroup,
} from "@/lib/explorer-stats"
import {
  fetchLichessExplorer,
  type LichessExplorerResult,
} from "@/lib/lichess-explorer"
import { ecoName } from "@chessgui/core/eco"
import { parseMaterialQuery } from "@chessgui/core/material-signature"
import { addDbPath, dbDisplayName, loadDbPaths, saveDbPaths } from "@/lib/db-registry"

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

/** The reserved tag behind the star column (spec 200 favorites). */
const FAVORITE_TAG = "favorite"

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
  // Explorer sort mode (spec 200: "configurable: by count, by performance").
  const [explorerSort, setExplorerSort] = useState<ExplorerSort>("count")
  // Lichess online fallback (spec 200) — consulted when the local database has
  // no games for the current position.
  const [online, setOnline] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ok"; data: LichessExplorerResult }
    | { status: "error"; message: string }
  >({ status: "idle" })

  // Active database (spec 200 multi-DB): undefined = the default games.db;
  // extra databases are opened via the native picker and remembered.
  const [dbPath, setDbPath] = useState<string | undefined>(undefined)
  const [dbPaths, setDbPaths] = useState<string[]>([])
  const [tauri, setTauri] = useState(false)
  useEffect(() => {
    setTauri(isTauri())
    setDbPaths(loadDbPaths())
  }, [])

  const openDatabase = useCallback(async () => {
    // Native picker: the backend needs a real filesystem path for the SQLite file.
    const picked = await pickFile({
      filters: [{ name: "ChessGUI database", extensions: ["db", "sqlite", "sqlite3"] }],
    })
    if (!picked) return // cancelled
    setDbPaths((prev) => {
      const next = addDbPath(prev, picked)
      saveDbPaths(next)
      return next
    })
    setDbPath(picked)
    setPage(0)
    setSelected(new Set())
  }, [])

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
        listGames(applied, PAGE_SIZE, page * PAGE_SIZE, sort, dbPath),
        dbStats(dbPath),
      ])
      if (id !== reqId.current) return
      setRows(list)
      setCount(s.games)
    } finally {
      if (id === reqId.current) setLoading(false)
    }
  }, [applied, page, sort, dbPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Tags in use (spec 200 tagging) — feeds the filter dropdown. Reloaded on
  // db switch and after any tag edit.
  const [allTags, setAllTags] = useState<string[]>([])
  const refreshTags = useCallback(async () => {
    setAllTags(await listTags(dbPath))
  }, [dbPath])
  useEffect(() => {
    void refreshTags()
  }, [refreshTags])

  // Tag edits refresh the list (rows carry their tags) and the tag dropdown.
  const editTag = useCallback(
    async (id: number, tag: string, on: boolean) => {
      if (on) await addTag(id, tag, dbPath)
      else await removeTag(id, tag, dbPath)
      void refresh()
      void refreshTags()
    },
    [dbPath, refresh, refreshTags],
  )

  const promptAddTag = useCallback(
    async (id: number) => {
      const tag = prompt("Tag name:")?.trim()
      if (tag) await editTag(id, tag, true)
    },
    [editTag],
  )

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
      const pgn = await getGame(id, dbPath)
      if (pgn) onLoadGame(pgn)
    },
    [onLoadGame, dbPath],
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
    const removed = await deleteGames([...selected], dbPath)
    setBanner(`Deleted ${removed} game(s)`)
    setSelected(new Set())
    void refresh()
  }, [selected, refresh, dbPath])

  const findPosition = useCallback(async (fen: string) => {
    const id = ++posReqId.current
    setSearching(true)
    try {
      const found = await searchPosition(fen, 500, dbPath)
      if (id === posReqId.current) setHits(found)
    } finally {
      if (id === posReqId.current) setSearching(false)
    }
  }, [dbPath])

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

  // Aggregate local hits into explorer move groups, sorted per the toggle.
  const mover = currentFen ? moverFromFen(currentFen) : "white"
  const localGroups = useMemo(
    () => (hits ? sortGroups(aggregateHits(hits, mover), explorerSort) : null),
    [hits, mover, explorerSort],
  )

  // Lichess fallback: only when the local search came back empty for a real
  // position. Guarded by a nonce so a stale response can't clobber a newer one.
  const onlineReqId = useRef(0)
  useEffect(() => {
    if (!currentFen || hits === null || hits.length > 0) {
      setOnline({ status: "idle" })
      return
    }
    const id = ++onlineReqId.current
    setOnline({ status: "loading" })
    fetchLichessExplorer(currentFen)
      .then((data) => {
        if (id === onlineReqId.current) setOnline({ status: "ok", data })
      })
      .catch((e: unknown) => {
        if (id === onlineReqId.current)
          setOnline({
            status: "error",
            message: e instanceof Error ? e.message : "Lichess explorer failed",
          })
      })
  }, [currentFen, hits])

  const onlineGroups = useMemo(
    () =>
      online.status === "ok" ? sortGroups(online.data.moves, explorerSort) : null,
    [online, explorerSort],
  )

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
            {/* Database switcher (spec 200 multi-DB): the backend keeps one
                connection per path, so switching is instant. */}
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm max-w-[14rem]"
              value={dbPath ?? ""}
              onChange={(e) => {
                setDbPath(e.target.value || undefined)
                setPage(0)
                setSelected(new Set())
              }}
              title={dbPath ?? "Default database (app data)"}
              data-testid="db-switcher"
            >
              <option value="">Default</option>
              {dbPaths.map((p) => (
                <option key={p} value={p}>
                  {dbDisplayName(p)}
                </option>
              ))}
            </select>
            {tauri && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void openDatabase()}
                title="Open another database file (kept open alongside this one)"
                data-testid="db-open"
              >
                Open…
              </Button>
            )}
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
              Import…
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
        <FilterBar draft={draft} setDraft={setDraft} allTags={allTags} />

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
                  <th className="px-3 py-2 font-medium text-left">Tags</th>
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
                    <td
                      className="px-3 py-1.5 whitespace-nowrap"
                      title={ecoName(r.eco) ?? undefined}
                    >
                      {r.eco}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.ply_count}</td>
                    {/* Tags / favorites (spec 200): star toggles the reserved
                        "favorite" tag; chips remove on click; + adds. */}
                    <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        <button
                          className={
                            r.tags.includes(FAVORITE_TAG)
                              ? "text-amber-400 hover:text-amber-300"
                              : "text-muted-foreground/40 hover:text-muted-foreground"
                          }
                          title={r.tags.includes(FAVORITE_TAG) ? "Remove from favorites" : "Add to favorites"}
                          onClick={() => void editTag(r.id, FAVORITE_TAG, !r.tags.includes(FAVORITE_TAG))}
                          data-testid={`db-fav-${r.id}`}
                        >
                          {r.tags.includes(FAVORITE_TAG) ? "★" : "☆"}
                        </button>
                        {r.tags
                          .filter((t) => t !== FAVORITE_TAG)
                          .map((t) => (
                            <button
                              key={t}
                              className="px-1.5 py-0 rounded-full bg-secondary text-xs text-muted-foreground hover:text-foreground whitespace-nowrap"
                              title={`Remove tag "${t}"`}
                              onClick={() => void editTag(r.id, t, false)}
                              data-testid={`db-tag-${r.id}-${t}`}
                            >
                              {t} ×
                            </button>
                          ))}
                        <button
                          className="text-muted-foreground/40 hover:text-muted-foreground text-xs"
                          title="Add tag…"
                          onClick={() => void promptAddTag(r.id)}
                          data-testid={`db-tag-add-${r.id}`}
                        >
                          +
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-3 py-8 text-center text-muted-foreground" data-testid="db-empty">
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
              {/* Explicit transposition claim (spec 200): the index is keyed
                  on the position (Zobrist hash), not the move order. */}
              <p className="text-xs text-muted-foreground" data-testid="db-transposition-note">
                Matches are by position (Zobrist key), so transpositions from other move orders
                are included.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {/* Sort toggle (spec 200: by count / by performance) */}
              <div className="flex rounded-md border border-input overflow-hidden text-xs">
                {(["count", "performance"] as const).map((mode) => (
                  <button
                    key={mode}
                    className={`px-2 py-1 ${
                      explorerSort === mode
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    onClick={() => setExplorerSort(mode)}
                    title={mode === "count" ? "Sort moves by game count" : "Sort moves by performance rating"}
                    data-testid={`db-explorer-sort-${mode}`}
                  >
                    {mode === "count" ? "Count" : "Perf"}
                  </button>
                ))}
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
          </div>
          {localGroups && localGroups.length > 0 && (
            <PositionResults
              groups={localGroups}
              games={hits!.length}
              onPlayMove={onPlayMove}
            />
          )}
          {/* Local DB has nothing → Lichess fallback, clearly marked online. */}
          {localGroups && localGroups.length === 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground" data-testid="db-position-empty">
                No games in the database reach this position.
              </p>
              {online.status === "loading" && (
                <p className="text-xs text-muted-foreground" data-testid="db-lichess-loading">
                  Checking the Lichess opening explorer…
                </p>
              )}
              {online.status === "error" && (
                <p className="text-xs text-amber-400/80" data-testid="db-lichess-error">
                  {online.message}
                </p>
              )}
              {online.status === "ok" && onlineGroups && (
                <div className="flex flex-col gap-1" data-testid="db-lichess-results">
                  <span className="inline-flex items-center gap-1.5 text-xs text-sky-300">
                    <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
                    online — Lichess opening explorer ({online.data.total.toLocaleString()} games)
                  </span>
                  {onlineGroups.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Lichess has no games for this position either.
                    </p>
                  ) : (
                    <PositionResults
                      groups={onlineGroups}
                      games={online.data.total}
                      onPlayMove={onPlayMove}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={onImported}
        dbPath={dbPath}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function FilterBar({
  draft,
  setDraft,
  allTags,
}: {
  draft: GameFilter
  setDraft: (f: GameFilter) => void
  /** Tags in use across the database — options for the tag filter. */
  allTags: string[]
}) {
  const set = (patch: Partial<GameFilter>) => setDraft({ ...draft, ...patch })
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-2" data-testid="db-filters">
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
        type="number"
        placeholder="Max Elo"
        value={draft.max_elo ?? ""}
        onChange={(e) => set({ max_elo: e.target.value ? Number(e.target.value) : undefined })}
        data-testid="db-filter-max-elo"
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
      {/* Full-text (spec 200): players, event, site and the movetext — so
          comments and annotations are searchable too. */}
      <Input
        placeholder="Search all text"
        value={draft.text ?? ""}
        onChange={(e) => set({ text: e.target.value })}
        data-testid="db-filter-text"
      />
      {/* Material signature (spec 200): games reaching e.g. a R+P vs R
          ending at any point, either colour. Red-tinted while unparseable
          (an invalid signature matches nothing, mirroring the backend). */}
      <Input
        placeholder="Material (e.g. KRP vs KR)"
        value={draft.material ?? ""}
        onChange={(e) => set({ material: e.target.value })}
        className={
          draft.material?.trim() && !parseMaterialQuery(draft.material)
            ? "border-red-500/60"
            : undefined
        }
        title="Find games reaching this material, either colour — piece letters QRBNP, kings implied"
        data-testid="db-filter-material"
      />
      {/* Tag filter (spec 200 tagging/favorites). */}
      <select
        className="h-10 rounded-md border border-input bg-background px-3 text-sm"
        value={draft.tag ?? ""}
        onChange={(e) => set({ tag: e.target.value || undefined })}
        data-testid="db-filter-tag"
      >
        <option value="">Any tag</option>
        {allTags.map((t) => (
          <option key={t} value={t}>
            {t === FAVORITE_TAG ? "★ favorite" : t}
          </option>
        ))}
      </select>
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

// Aggregation lives in lib/explorer-stats.ts (shared with tests and the
// Lichess fallback); this component just renders pre-sorted MoveGroups.
function PositionResults({
  groups,
  games,
  onPlayMove,
}: {
  groups: MoveGroup[]
  games: number
  onPlayMove?: (uci: string) => void
}) {
  return (
    <div className="flex flex-col gap-1" data-testid="db-position-results">
      <p className="text-xs text-muted-foreground">
        {games.toLocaleString()} game{games === 1 ? "" : "s"} · {groups.length} move
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
            <span
              className="w-14 text-right tabular-nums text-xs text-muted-foreground"
              title={g.avgElo != null ? `Average rating ${Math.round(g.avgElo)}` : undefined}
            >
              {g.avgElo != null ? Math.round(g.avgElo) : ""}
            </span>
            {/* Performance rating of the side to move for this move (spec 200) */}
            <span
              className="w-14 text-right tabular-nums text-xs text-muted-foreground"
              title={
                g.performance != null
                  ? `Performance rating ${g.performance} (side to move)`
                  : undefined
              }
              data-testid={`db-move-perf-${g.san}`}
            >
              {g.performance != null ? `p${g.performance}` : ""}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Import dialog — paste PGN, pick a .pgn file, or import a ChessBase .cbh
// ---------------------------------------------------------------------------

function ImportDialog({
  open,
  onOpenChange,
  onImported,
  dbPath,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (report: ImportReport) => void
  /** Target database — imports land in the currently-selected DB. */
  dbPath?: string
}) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cbhProgress, setCbhProgress] = useState<CbhImportProgress | null>(null)
  const [cbhCancelling, setCbhCancelling] = useState(false)
  const [pgnProgress, setPgnProgress] = useState<PgnImportProgress | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // CBH import needs a real filesystem path (native dialog + Rust decoder), so
  // the button only exists inside Tauri. Set via effect to keep SSR/browser
  // hydration consistent.
  const [tauri, setTauri] = useState(false)
  useEffect(() => setTauri(isTauri()), [])

  const runImport = useCallback(
    async (pgn: string, source: string) => {
      if (!pgn.trim()) {
        setError("Paste some PGN or choose a file first.")
        return
      }
      setBusy(true)
      setError(null)
      try {
        const report = await importPgn({
          source,
          text: pgn,
          dbPath,
          onProgress: setPgnProgress,
        })
        setText("")
        onImported(report)
      } catch (e) {
        setError(typeof e === "string" ? e : "Import failed.")
      } finally {
        setBusy(false)
        setPgnProgress(null)
      }
    },
    [onImported, dbPath],
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

  const handleCbh = useCallback(async () => {
    setError(null)
    // Native picker (not the hidden <input>): the Rust decoder needs a real
    // filesystem path so it can read the sibling .cbg/.cba/… files.
    const picked = await pickFile({
      filters: [{ name: "ChessBase database", extensions: ["cbh"] }],
    })
    if (!picked) return // cancelled
    setBusy(true)
    setCbhCancelling(false)
    try {
      const report = await importCbh({ cbhPath: picked, dbPath, onProgress: setCbhProgress })
      // Fold into the PGN-shaped report the parent banner expects. A cancelled
      // import still reports — its counts cover what genuinely landed.
      onImported({
        imported: report.imported,
        dups_skipped: report.dups_skipped,
        errors: report.convert_errors + report.db_errors,
      })
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : "CBH import failed.")
    } finally {
      setBusy(false)
      setCbhProgress(null)
      setCbhCancelling(false)
    }
  }, [onImported, dbPath])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="db-import-dialog">
        <DialogHeader>
          <DialogTitle>Import games</DialogTitle>
          <DialogDescription>
            Paste PGN text, choose a .pgn file{tauri ? ", or import a ChessBase .cbh database" : ""}.
            Exact duplicates are skipped automatically.
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
        {/* PGN import progress (spec 200): streamed per committed batch. No
            total is knowable for a PGN stream, so the bar is indeterminate —
            the counts are the real signal. */}
        {pgnProgress && (
          <div className="text-sm text-muted-foreground" data-testid="db-import-pgn-progress">
            <span>
              Importing… {pgnProgress.processed.toLocaleString()} games processed (
              {pgnProgress.imported.toLocaleString()} added,{" "}
              {pgnProgress.dups_skipped.toLocaleString()} duplicates
              {pgnProgress.errors ? `, ${pgnProgress.errors.toLocaleString()} errors` : ""})
            </span>
            <div className="mt-1 h-1.5 rounded bg-secondary overflow-hidden">
              <div className="h-full w-1/3 bg-primary animate-pulse" />
            </div>
          </div>
        )}
        {cbhProgress && (
          <div className="text-sm text-muted-foreground" data-testid="db-import-cbh-progress">
            <div className="flex items-center justify-between gap-2">
              <span>
                Importing… {cbhProgress.processed.toLocaleString()} /{" "}
                {cbhProgress.total.toLocaleString()} games ({cbhProgress.imported.toLocaleString()}{" "}
                added, {cbhProgress.dups_skipped.toLocaleString()} duplicates)
              </span>
              {/* Stops the Rust loop at its next batch boundary; already-
                  committed batches are kept and reported. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCbhCancelling(true)
                  void cancelCbhImport().catch(() => setCbhCancelling(false))
                }}
                disabled={cbhCancelling}
                data-testid="db-import-cbh-cancel"
              >
                {cbhCancelling ? "Cancelling…" : "Cancel"}
              </Button>
            </div>
            <div className="mt-1 h-1.5 rounded bg-secondary overflow-hidden">
              <div
                className="h-full bg-primary transition-[width]"
                style={{
                  width: `${(cbhProgress.processed / Math.max(1, cbhProgress.total)) * 100}%`,
                }}
              />
            </div>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pgn,.txt"
          className="hidden"
          onChange={handleFile}
          data-testid="db-import-file"
        />
        <DialogFooter>
          {tauri && (
            <Button
              variant="outline"
              onClick={handleCbh}
              disabled={busy}
              data-testid="db-import-cbh-button"
            >
              ChessBase (.cbh)…
            </Button>
          )}
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

"use client"

// Active games list (spec 219 D): every game flagged "Live game — analysis
// board only", with Resume / Game finished / delete. Data and flows go
// through @/lib/active-games (shell-resolved, like database-tab's @/lib
// imports), so the same component serves the desktop and web shells.
//
// The compliance-critical part is what this panel does NOT do: nothing here
// lifts the engine lockout except a successful archive (the fetched or
// pasted PGN actually written to the game database — lib/active-games owns
// that invariant). Fetch failures leave the record active and locked, with
// retry and manual-PGN paste as the only ways forward. Deletion is the one
// other exit and sits behind the fair-play confirmation below.

import { useCallback, useEffect, useState } from "react"
import { Button } from "@chessgui/ui/ui/button"
import { Textarea } from "@chessgui/ui/ui/textarea"
import type { ActiveGameRecord } from "@chessgui/core/active-game"
import type { ChesscomGame } from "@chessgui/core/chesscom"
import type { SerializedTree } from "@chessgui/core/game-tree"
import {
  archiveActiveGamePgn,
  deleteActiveGame,
  finishActiveGame,
  loadActiveGames,
} from "@/lib/active-games"

/** Fair-play wording for the deletion confirmation (spec 219 B). */
export const ACTIVE_GAME_DELETE_WARNING =
  "This game was flagged as an active chess.com daily game. Deleting the " +
  "flag re-enables engine analysis on this position — only do this if the " +
  "game is truly over or was never real. Engine assistance during an " +
  "ongoing game violates chess.com's Fair Play Policy."

/** Mainline move count of a serialized tree (children[0] chain from root). */
export function mainlineMoveCount(tree: SerializedTree): number {
  let count = 0
  const seen = new Set<string>()
  let node = tree.nodes[tree.rootId]
  while (node && node.children.length > 0 && !seen.has(node.id)) {
    seen.add(node.id)
    node = tree.nodes[node.children[0]]
    if (!node) break
    count++
  }
  return count
}

/** Compact "how stale is this" label for the list row. */
export function agoLabel(ms: number, now: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** What a "Game finished" attempt came back as (mirrors lib/active-games'
 *  FinishActiveGameResult, minus the record payloads the list doesn't need). */
export type FinishOutcome =
  | { status: "archived" }
  | { status: "needs-confirmation"; candidates: ChesscomGame[] }
  | { status: "not-found" }
  | { status: "error"; message: string }

type RowStatus =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "not-found" }
  | { kind: "needs-confirmation"; candidates: ChesscomGame[] }
  | { kind: "error"; message: string }

export interface ActiveGamesListProps {
  records: ActiveGameRecord[]
  onResume: (record: ActiveGameRecord) => void
  onFinish: (record: ActiveGameRecord) => Promise<FinishOutcome>
  /** Archive one confirmed heuristic candidate (its pgn). */
  onConfirmCandidate: (
    record: ActiveGameRecord,
    game: ChesscomGame,
  ) => Promise<{ ok: boolean; message?: string }>
  /** Manual fallback: archive a pasted PGN. */
  onArchivePgn: (
    record: ActiveGameRecord,
    pgn: string,
  ) => Promise<{ ok: boolean; message?: string }>
  /** Called only after the fair-play confirmation. */
  onDelete: (record: ActiveGameRecord) => void
  /** Remove an already-archived record from the list (no fair-play gate —
   *  the lockout is long lifted). */
  onRemoveArchived: (record: ActiveGameRecord) => void
}

const ROW_BTN = "h-7 px-2.5 text-xs"

function CandidateRow({
  game,
  onPick,
  disabled,
}: {
  game: ChesscomGame
  onPick: () => void
  disabled: boolean
}) {
  const ended = game.end_time
    ? new Date(game.end_time * 1000).toLocaleDateString()
    : "?"
  return (
    <div className="flex items-center justify-between gap-2 rounded bg-black/20 px-2 py-1.5">
      <span className="text-xs text-[#bababa] truncate">
        {game.white.username} vs {game.black.username}
        <span className="text-muted-foreground"> · ended {ended}</span>
      </span>
      <Button
        size="sm"
        variant="outline"
        className={`${ROW_BTN} shrink-0 border-green-700 text-green-300 hover:bg-green-950`}
        disabled={disabled}
        onClick={onPick}
      >
        This one
      </Button>
    </div>
  )
}

function PgnPasteFallback({
  onArchive,
  disabled,
}: {
  onArchive: (pgn: string) => void
  disabled: boolean
}) {
  const [pgn, setPgn] = useState("")
  return (
    <div className="flex flex-col gap-2 mt-2">
      <Textarea
        value={pgn}
        onChange={(e) => setPgn(e.target.value)}
        placeholder="Paste the finished game's PGN here…"
        spellCheck={false}
        className="min-h-[72px] bg-[#2a2825] border-[#3a3835] text-xs font-mono"
        data-testid="active-game-pgn-paste"
      />
      <Button
        size="sm"
        variant="outline"
        className={`${ROW_BTN} self-start border-green-700 text-green-300 hover:bg-green-950`}
        disabled={disabled || !pgn.trim()}
        onClick={() => onArchive(pgn)}
      >
        Archive pasted PGN
      </Button>
    </div>
  )
}

export function ActiveGamesList({
  records,
  onResume,
  onFinish,
  onConfirmCandidate,
  onArchivePgn,
  onDelete,
  onRemoveArchived,
}: ActiveGamesListProps) {
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({})
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const setStatus = (id: string, status: RowStatus) =>
    setStatuses((s) => ({ ...s, [id]: status }))

  const handleFinish = async (record: ActiveGameRecord) => {
    setStatus(record.id, { kind: "busy" })
    const outcome = await onFinish(record)
    if (outcome.status === "archived") setStatus(record.id, { kind: "idle" })
    else if (outcome.status === "needs-confirmation")
      setStatus(record.id, { kind: "needs-confirmation", candidates: outcome.candidates })
    else if (outcome.status === "not-found") setStatus(record.id, { kind: "not-found" })
    else setStatus(record.id, { kind: "error", message: outcome.message })
  }

  const handleArchive = async (
    record: ActiveGameRecord,
    run: () => Promise<{ ok: boolean; message?: string }>,
  ) => {
    setStatus(record.id, { kind: "busy" })
    const res = await run()
    if (res.ok) setStatus(record.id, { kind: "idle" })
    else
      setStatus(record.id, {
        kind: "error",
        message: res.message ?? "archiving failed — the game stays locked",
      })
  }

  return (
    <div className="flex flex-col gap-2" data-testid="active-games-list">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-amber-200">Active games</span>
        <span className="text-xs text-muted-foreground">
          engine off until marked finished (fair play)
        </span>
      </div>
      {records.map((record) => {
        const status = statuses[record.id] ?? { kind: "idle" }
        const busy = status.kind === "busy"
        const moveCount = mainlineMoveCount(record.tree)
        return (
          <div
            key={record.id}
            data-testid={`active-game-row-${record.id}`}
            className={`rounded-lg border px-3 py-2 ${
              record.archived
                ? "border-[#2a2825] bg-[#1e1c19]/60"
                : "border-amber-800/40 bg-amber-950/20"
            }`}
          >
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <p className="text-sm font-medium text-[#f6f6f6] truncate">
                  {record.meta.opponent ? `vs ${record.meta.opponent}` : "Unknown opponent"}
                  {record.meta.chesscomUsername && (
                    <span className="text-muted-foreground font-normal">
                      {" "}
                      · as {record.meta.chesscomUsername}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {moveCount} {moveCount === 1 ? "move" : "moves"} · updated{" "}
                  {agoLabel(record.lastUpdated)}
                  {record.meta.gameUrl && (
                    <>
                      {" · "}
                      <a
                        href={record.meta.gameUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline hover:text-foreground"
                      >
                        chess.com
                      </a>
                    </>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {record.archived ? (
                  <>
                    <span className="text-xs text-green-400">
                      Archived — engine analysis unlocked
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={`${ROW_BTN} text-muted-foreground hover:text-foreground`}
                      onClick={() => onRemoveArchived(record)}
                    >
                      Remove
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className={`${ROW_BTN} border-blue-700 text-blue-300 hover:bg-blue-950`}
                      disabled={busy}
                      onClick={() => onResume(record)}
                      data-testid={`active-game-resume-${record.id}`}
                    >
                      Resume
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className={`${ROW_BTN} border-green-700 text-green-300 hover:bg-green-950`}
                      disabled={busy}
                      onClick={() => handleFinish(record)}
                      data-testid={`active-game-finish-${record.id}`}
                    >
                      {busy ? "Checking…" : "Game finished"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={`${ROW_BTN} text-red-400 hover:text-red-300`}
                      disabled={busy}
                      onClick={() => setDeleteConfirmId(record.id)}
                      data-testid={`active-game-delete-${record.id}`}
                    >
                      Delete
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/* Fetch outcomes. Every non-archived outcome states that the
                game STAYS locked (spec 219 D failure UX). */}
            {status.kind === "not-found" && (
              <div className="mt-2 text-xs text-amber-200/90">
                Not in chess.com&rsquo;s public archive yet — it refreshes every
                12–24 hours. The game stays locked; retry later, or paste the
                final PGN:
                <PgnPasteFallback
                  disabled={false}
                  onArchive={(pgn) =>
                    handleArchive(record, () => onArchivePgn(record, pgn))
                  }
                />
              </div>
            )}
            {status.kind === "error" && (
              <div className="mt-2 text-xs text-red-400">
                {status.message} — the game stays locked. Retry, or paste the
                final PGN:
                <PgnPasteFallback
                  disabled={false}
                  onArchive={(pgn) =>
                    handleArchive(record, () => onArchivePgn(record, pgn))
                  }
                />
              </div>
            )}
            {status.kind === "needs-confirmation" && (
              <div className="mt-2 flex flex-col gap-1.5">
                <span className="text-xs text-amber-200/90">
                  No game URL was stored, so confirm which finished game this
                  was (nothing is archived until you pick one):
                </span>
                {status.candidates.map((g) => (
                  <CandidateRow
                    key={g.url}
                    game={g}
                    disabled={false}
                    onPick={() =>
                      handleArchive(record, () => onConfirmCandidate(record, g))
                    }
                  />
                ))}
              </div>
            )}

            {/* Deletion sits behind the fair-play confirmation (spec 219 B). */}
            {deleteConfirmId === record.id && (
              <div
                className="mt-2 rounded border border-red-800/50 bg-red-950/30 px-3 py-2"
                data-testid={`active-game-delete-confirm-${record.id}`}
              >
                <p className="text-xs text-red-200 leading-relaxed">
                  {ACTIVE_GAME_DELETE_WARNING}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className={`${ROW_BTN} border-red-700 text-red-300 hover:bg-red-950`}
                    onClick={() => {
                      setDeleteConfirmId(null)
                      onDelete(record)
                    }}
                  >
                    Delete: understood
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={`${ROW_BTN} text-muted-foreground hover:text-foreground`}
                    onClick={() => setDeleteConfirmId(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Self-loading container: reads the persisted store, wires the fetch/archive
 * flows from @/lib/active-games, and renders nothing while the list is empty
 * (the hosting view stays unchanged until the first game is flagged).
 * `refreshNonce` re-reads the store after out-of-panel changes (flagging a
 * game in the editor, "Continue later" on the board).
 */
export function ActiveGamesPanel({
  onResume,
  onArchived,
  onDeleted,
  refreshNonce = 0,
}: {
  onResume: (record: ActiveGameRecord) => void
  /** The record's lockout was lifted — the host unflags the open game if it
   *  is the same one. */
  onArchived?: (record: ActiveGameRecord) => void
  onDeleted?: (record: ActiveGameRecord) => void
  refreshNonce?: number
}) {
  const [records, setRecords] = useState<ActiveGameRecord[]>([])

  const reload = useCallback(() => {
    loadActiveGames()
      .then(setRecords)
      .catch((e) => console.error("[active-games] load failed:", e))
  }, [])

  useEffect(() => {
    reload()
  }, [reload, refreshNonce])

  const handleFinish = useCallback(
    async (record: ActiveGameRecord): Promise<FinishOutcome> => {
      const result = await finishActiveGame(record)
      if (result.status === "archived") {
        reload()
        onArchived?.(result.record)
        return { status: "archived" }
      }
      if (result.status === "needs-confirmation")
        return { status: "needs-confirmation", candidates: result.candidates }
      if (result.status === "not-found") return { status: "not-found" }
      return { status: "error", message: result.message }
    },
    [reload, onArchived],
  )

  const archivePgn = useCallback(
    async (record: ActiveGameRecord, pgn: string) => {
      try {
        const { record: archived } = await archiveActiveGamePgn(record, pgn)
        reload()
        onArchived?.(archived)
        return { ok: true }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
    [reload, onArchived],
  )

  const handleConfirmCandidate = useCallback(
    async (record: ActiveGameRecord, game: ChesscomGame) => {
      if (!game.pgn) return { ok: false, message: "candidate has no PGN" }
      return archivePgn(record, game.pgn)
    },
    [archivePgn],
  )

  const handleDelete = useCallback(
    (record: ActiveGameRecord) => {
      deleteActiveGame(record.id)
        .then(() => {
          reload()
          onDeleted?.(record)
        })
        .catch((e) => console.error("[active-games] delete failed:", e))
    },
    [reload, onDeleted],
  )

  if (records.length === 0) return null

  return (
    <ActiveGamesList
      records={records}
      onResume={onResume}
      onFinish={handleFinish}
      onConfirmCandidate={handleConfirmCandidate}
      onArchivePgn={archivePgn}
      onDelete={handleDelete}
      onRemoveArchived={handleDelete}
    />
  )
}

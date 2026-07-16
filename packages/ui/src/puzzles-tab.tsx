"use client"

// Avoidance puzzles solver (spec 211 "Don't Step On the Rake", Tier 1).
//
// Shows the pre-cliff position with a deliberately unalarming prompt ("Your
// move." — the absence of a "tactic here!" tell is the point) and grades with
// MANY-CORRECT semantics (lib/puzzles.gradeMove): the stored trap fails, any
// engine-safe move passes, mediocre-but-not-losing passes with a note. On a
// fail the punishing reply is PLAYED on the board and the refutation line is
// walked move by move with arrows — the teaching moment is experiencing the
// rake (spec 211 "Puzzle Mechanics").
//
// Two launch surfaces share this component: the Learn ▸ Avoidance sub-tab
// (setup screen: band, deck size, import) and the Training tab's rake_deck
// exercise (passes `initialDeck` to jump straight into a session).
//
// Session flow (spec 211): decks are built by lib/puzzles.buildDeck — due
// respawns lead (failed puzzles on the 1d/3d/7d ladder, lib/puzzle-results),
// the rest is a shuffled ~70/30 rake/calm mix. NOTHING pre-answer reveals
// whether the position holds a rake or is calm (the anchor-leak lesson):
// same prompt, same board, same progress line; the kind surfaces only on
// the result card. Every graded answer is persisted to the local results
// store, which also feeds the setup screen's per-band record and the
// session streak in the header.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import type { Key } from "@lichess-org/chessground/types"
import type { DrawShape } from "@lichess-org/chessground/draw"
import { Chess } from "chessops/chess"
import { parseFen } from "chessops/fen"
import { chessgroundDests } from "chessops/compat"
import { Button } from "@chessgui/ui/ui/button"
import { Input } from "@chessgui/ui/ui/input"
import { applyUci, dragToUci, turnOf, type SparColor } from "@/lib/spar"
import {
  buildDeck,
  checkMove,
  deckItemBand,
  deckItemFen,
  deckItemKey,
  DEFAULT_DECK_SIZE,
  gradeCalmMove,
  gradeMove,
  importPuzzles,
  puzzleStats,
  streak,
  summarize,
  type DeckItem,
  type DeckRequest,
  type Grade,
  type PuzzleStats,
  type SessionResult,
} from "@/lib/puzzles"
import {
  appendPuzzleResult,
  bandRecords,
  buildPuzzleResult,
  dueRespawns,
  failCountFor,
  loadPuzzleResults,
  persistPuzzleResults,
  respawnIntervalDays,
  type BandRecord,
} from "@/lib/puzzle-results"

const Board = dynamic(() => import("@chessgui/ui/board").then((m) => ({ default: m.Board })), {
  ssr: false,
})

/** Delay between replayed refutation moves — slow enough to read the geometry. */
const REPLAY_STEP_MS = 900

interface PuzzlesTabProps {
  /** Jump straight into a session (the Training tab's rake_deck launch).
   *  Without it the setup screen shows first (the Learn sub-tab). */
  initialDeck?: DeckRequest
  /** Back to the launching surface (rendered only when provided). */
  onExit?: () => void
}

function legalDests(fen: string): Map<Key, Key[]> {
  const setup = parseFen(fen)
  if (setup.isErr) return new Map()
  const pos = Chess.fromSetup(setup.unwrap())
  if (pos.isErr) return new Map()
  return chessgroundDests(pos.unwrap()) as Map<Key, Key[]>
}

function arrow(uci: string, brush: string): DrawShape {
  return { orig: uci.slice(0, 2) as Key, dest: uci.slice(2, 4) as Key, brush }
}

type Stage = "solve" | "checking" | "replay" | "result"

export function PuzzlesTab({ initialDeck, onExit }: PuzzlesTabProps) {
  // ------------------------------------------------------------------ setup
  const [stats, setStats] = useState<PuzzleStats | null>(null)
  const [band, setBand] = useState<string | null>(initialDeck?.band ?? null)
  const [count, setCount] = useState(initialDeck?.count ?? DEFAULT_DECK_SIZE)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [deckError, setDeckError] = useState<string | null>(null)

  const refreshStats = useCallback(() => {
    puzzleStats()
      .then(setStats)
      .catch((e) => setDeckError(String(e)))
  }, [])
  useEffect(() => {
    refreshStats()
  }, [refreshStats])

  // Per-band record + due-respawn count from the local results store. Read
  // in an effect (not render) so the static-export prerender stays empty.
  const [record, setRecord] = useState<{ bands: BandRecord[]; due: number }>({ bands: [], due: 0 })
  const refreshRecord = useCallback(() => {
    const entries = loadPuzzleResults()
    setRecord({ bands: bandRecords(entries), due: dueRespawns(entries).length })
  }, [])
  useEffect(() => {
    refreshRecord()
  }, [refreshRecord])

  // ---------------------------------------------------------------- session
  const [deck, setDeck] = useState<DeckItem[] | null>(null)
  const [idx, setIdx] = useState(0)
  const [results, setResults] = useState<SessionResult[]>([])
  const [stage, setStage] = useState<Stage>("solve")
  const [fen, setFen] = useState<string>("")
  const [grade, setGrade] = useState<Grade | null>(null)
  /** Spaced-repetition line on the result card ("comes back in 3d" / "review cleared"). */
  const [respawnNote, setRespawnNote] = useState<string | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [shapes, setShapes] = useState<DrawShape[]>([])
  const [boardNonce, setBoardNonce] = useState(0)

  const item = deck && idx < deck.length ? deck[idx] : null
  const itemFen = item ? deckItemFen(item) : ""
  const sessionOver = deck !== null && idx >= deck.length

  // Replay bookkeeping: the queue of refutation plies still to play, and the
  // live timer. Refs, not state — the timer callback owns the sequencing.
  const replayQueue = useRef<string[]>([])
  const replayFen = useRef<string>("")
  const replayTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  useEffect(() => () => clearInterval(replayTimer.current), [])

  const loadDeck = useCallback(
    (req: DeckRequest) => {
      clearInterval(replayTimer.current)
      setDeckError(null)
      buildDeck(req, { entries: loadPuzzleResults() })
        .then((items) => {
          if (items.length === 0) {
            setDeckError("No puzzles in the database yet — import a generator batch below.")
            setDeck(null)
            return
          }
          setDeck(items)
          setIdx(0)
          setResults([])
          setStage("solve")
          setFen(deckItemFen(items[0]))
          setGrade(null)
          setRespawnNote(null)
          setCheckError(null)
          setShapes([])
          setBoardNonce((n) => n + 1)
        })
        .catch((e) => setDeckError(String(e)))
    },
    [],
  )

  // Training launch: straight into the requested deck.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (initialDeck && !autoStarted.current) {
      autoStarted.current = true
      loadDeck(initialDeck)
    }
  }, [initialDeck, loadDeck])

  const mover: SparColor = item ? turnOf(itemFen) : "white"

  /** Walk the refutation from the position after the failed move, arrows on
   *  each move as it lands (red = the punishing side, yellow = the mover's
   *  forced replies), then show the result card. */
  const startReplay = useCallback(
    (failedUci: string, line: string[], startFrom: string) => {
      replayQueue.current = [...line]
      replayFen.current = startFrom
      setShapes([arrow(failedUci, "red")])
      setStage("replay")
      let punisher = true // first replayed move is the opponent's punishment
      clearInterval(replayTimer.current)
      replayTimer.current = setInterval(() => {
        const next = replayQueue.current.shift()
        if (!next) {
          clearInterval(replayTimer.current)
          setStage("result")
          return
        }
        const ply = applyUci(replayFen.current, next)
        if (!ply) {
          // A malformed line (should be filtered by import validation) — stop
          // the replay honestly instead of looping on a stuck position.
          clearInterval(replayTimer.current)
          setStage("result")
          return
        }
        replayFen.current = ply.fen
        setFen(ply.fen)
        setShapes([arrow(next, punisher ? "red" : "yellow")])
        punisher = !punisher
      }, REPLAY_STEP_MS)
    },
    [],
  )

  const recordAndShow = useCallback(
    (it: DeckItem, g: Grade, failedUci: string, afterFen: string) => {
      setGrade(g)
      setResults((prev) => [
        ...prev,
        {
          puzzleId: it.kind === "rake" ? it.puzzle.id : it.calm.id,
          verdict: g.verdict,
          correct: g.correct,
        },
      ])
      // Persist to the local results store — this drives the per-band record
      // and the spaced-repetition respawn of everything failed here.
      const key = deckItemKey(it)
      const entries = appendPuzzleResult(
        loadPuzzleResults(),
        buildPuzzleResult({
          key,
          kind: it.kind,
          band: deckItemBand(it),
          puzzleId: it.kind === "rake" ? it.puzzle.id : null,
          fen: deckItemFen(it),
          verdict: g.verdict,
          correct: g.correct,
        }),
      )
      persistPuzzleResults(entries)
      if (!g.correct) {
        const days = respawnIntervalDays(failCountFor(entries, key))
        setRespawnNote(`This one comes back for review in ${days} day${days === 1 ? "" : "s"}.`)
      } else if (it.respawn) {
        setRespawnNote("Review cleared — this one had beaten you before.")
      } else {
        setRespawnNote(null)
      }
      if (!g.correct && g.replayLine.length > 0) {
        startReplay(failedUci, g.replayLine, afterFen)
      } else {
        setStage("result")
      }
    },
    [startReplay],
  )

  const onBoardMove = useCallback(
    (from: Key, to: Key) => {
      if (!item || stage !== "solve") return
      const startFen = deckItemFen(item)
      const uci = dragToUci(startFen, from as string, to as string)
      const ply = applyUci(startFen, uci)
      if (!ply) return
      setFen(ply.fen)
      if (item.kind === "rake" && uci === item.puzzle.trap_uci) {
        // The stored rake: no engine needed, the generator verified it.
        recordAndShow(item, gradeMove(item.puzzle, uci, null), uci, ply.fen)
        return
      }
      setStage("checking")
      setCheckError(null)
      const depth = item.kind === "rake" ? item.puzzle.engine_verify_depth : item.calm.engine_verify_depth
      checkMove(startFen, uci, depth)
        .then((check) =>
          recordAndShow(
            item,
            item.kind === "rake" ? gradeMove(item.puzzle, uci, check) : gradeCalmMove(item.calm, check),
            uci,
            ply.fen,
          ),
        )
        .catch((e) => {
          // Engine failed (missing binary, crash): grade as unverified and say
          // why — never invent a score, never block the session.
          setCheckError(String(e))
          recordAndShow(
            item,
            item.kind === "rake" ? gradeMove(item.puzzle, uci, null) : gradeCalmMove(item.calm, null),
            uci,
            ply.fen,
          )
        })
    },
    [item, stage, recordAndShow],
  )

  const nextPuzzle = useCallback(() => {
    if (!deck) return
    clearInterval(replayTimer.current)
    const next = idx + 1
    setIdx(next)
    setGrade(null)
    setRespawnNote(null)
    setCheckError(null)
    setShapes([])
    setStage("solve")
    if (next < deck.length) setFen(deckItemFen(deck[next]))
    setBoardNonce((n) => n + 1)
  }, [deck, idx])

  const exitSession = useCallback(() => {
    clearInterval(replayTimer.current)
    setDeck(null)
    refreshStats()
    refreshRecord()
    if (onExit) onExit()
  }, [onExit, refreshStats, refreshRecord])

  const legalMoves = useMemo(
    () => (item && stage === "solve" ? legalDests(deckItemFen(item)) : new Map<Key, Key[]>()),
    [item, stage],
  )

  // ------------------------------------------------------------------------
  // Setup screen (no deck loaded)
  // ------------------------------------------------------------------------
  if (deck === null) {
    return (
      <SetupScreen
        stats={stats}
        band={band}
        count={count}
        importMsg={importMsg}
        deckError={deckError}
        records={record.bands}
        dueCount={record.due}
        onBand={setBand}
        onCount={setCount}
        onStart={() => loadDeck({ band, count })}
        onImportText={(text) =>
          importPuzzles({ text })
            .then((r) => {
              setImportMsg(
                `Imported ${r.imported} puzzle${r.imported === 1 ? "" : "s"}, ${r.dups_skipped} duplicate${
                  r.dups_skipped === 1 ? "" : "s"
                } skipped${r.errors > 0 ? `, ${r.errors} invalid row${r.errors === 1 ? "" : "s"}` : ""}.`,
              )
              refreshStats()
            })
            .catch((e) => setImportMsg(`Import failed: ${e}`))
        }
        onExit={onExit}
      />
    )
  }

  // ------------------------------------------------------------------------
  // Session summary
  // ------------------------------------------------------------------------
  if (sessionOver) {
    const sum = summarize(results)
    return (
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6" data-testid="puzzles-summary">
        <div className="max-w-md w-full space-y-4 text-center">
          <h1 className="text-2xl font-bold">Deck done</h1>
          <p className="text-4xl font-bold tabular-nums" data-testid="puzzles-summary-score">
            {sum.correct}/{sum.total}
          </p>
          <p className="text-sm text-muted-foreground">
            {sum.rakes === 0
              ? "No rakes stepped on."
              : `${sum.rakes} rake${sum.rakes === 1 ? "" : "s"} stepped on — each one was replayed, and each comes back for review (1d, then 3d, then 7d).`}
            {sum.unverified > 0 &&
              ` ${sum.unverified} answer${sum.unverified === 1 ? "" : "s"} unverified (no engine here).`}
          </p>
          <div className="flex gap-2 justify-center">
            <Button onClick={() => loadDeck({ band, count })} data-testid="puzzles-again">
              Another deck
            </Button>
            <Button variant="outline" onClick={exitSession} data-testid="puzzles-exit">
              Done
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ------------------------------------------------------------------------
  // Solver
  // ------------------------------------------------------------------------
  const moverLabel = mover === "white" ? "White" : "Black"
  return (
    <div className="h-full flex flex-col" data-testid="puzzles-session">
      <div className="px-6 py-3 border-b border-white/10 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-medium shrink-0">Avoidance</span>
          <span className="text-xs text-muted-foreground tabular-nums" data-testid="puzzles-progress">
            Puzzle {idx + 1} of {deck.length}
            {item && deckItemBand(item) ? ` · band ${deckItemBand(item)}` : ""}
          </span>
          <span
            className={`text-xs tabular-nums ${streak(results) > 0 ? "text-emerald-300" : "text-muted-foreground"}`}
            data-testid="puzzles-streak"
          >
            Streak {streak(results)}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={exitSession} data-testid="puzzles-session-exit">
          Exit deck
        </Button>
      </div>

      <div className="flex-1 min-h-0 flex gap-8 p-6">
        <div className="flex-1 min-w-0 flex items-center justify-center" data-testid="puzzles-board" data-fen={fen}>
          <Board
            key={boardNonce}
            fen={fen}
            orientation={mover}
            movableColor={mover}
            onMove={onBoardMove}
            legalMoves={legalMoves}
            autoShapes={shapes}
            viewOnly={stage !== "solve"}
          />
        </div>

        <div className="w-80 shrink-0 flex flex-col gap-4 overflow-auto">
          {/* The prompt stays unalarming on purpose: no "White to play and
              win" tell — sensing danger without a signal IS the exercise. */}
          <div className="text-sm" data-testid="puzzles-prompt">
            {stage === "solve" && (
              <span className="text-emerald-300">Your move — you play {moverLabel}.</span>
            )}
            {stage === "checking" && (
              <span className="text-muted-foreground" data-testid="puzzles-checking">
                Checking your move with the engine…
              </span>
            )}
            {stage === "replay" && (
              <span className="text-red-300" data-testid="puzzles-replay">
                That one loses — watch the refutation.
              </span>
            )}
          </div>

          {stage === "result" && grade && item && (
            <div
              className={`rounded-lg border p-3 space-y-1.5 ${
                grade.correct
                  ? grade.verdict === "safe"
                    ? "border-emerald-500/30 bg-emerald-500/[0.07]"
                    : "border-amber-500/30 bg-amber-500/[0.07]"
                  : "border-red-500/30 bg-red-500/[0.07]"
              }`}
              data-testid="puzzles-result"
              data-verdict={grade.verdict}
              data-kind={item.kind}
            >
              <div
                className={`text-sm font-bold ${
                  grade.correct
                    ? grade.verdict === "safe"
                      ? "text-emerald-300"
                      : "text-amber-300"
                    : "text-red-300"
                }`}
              >
                {grade.correct ? "Safe" : "You stepped on the rake"}
              </div>
              <p className="text-xs text-muted-foreground">{grade.note}</p>
              {!grade.correct && item.kind === "rake" && item.puzzle.trap_san && (
                <p className="text-xs text-muted-foreground">
                  In the source game ({item.puzzle.band ? `~${item.puzzle.band} level` : "unknown band"}) a
                  real player fell for {item.puzzle.trap_san} too.
                </p>
              )}
              {respawnNote && (
                <p className="text-xs text-muted-foreground" data-testid="puzzles-respawn-note">
                  {respawnNote}
                </p>
              )}
              {checkError && (
                <p className="text-xs text-amber-300/90" data-testid="puzzles-check-error">
                  Engine check failed: {checkError}
                </p>
              )}
              <Button size="sm" onClick={nextPuzzle} data-testid="puzzles-next" className="mt-1">
                {idx + 1 < deck.length ? "Next puzzle" : "Finish deck"}
              </Button>
            </div>
          )}

          {stage === "result" && item && (item.kind === "rake" ? item.puzzle.site : item.calm.site) && (
            <p className="text-[11px] text-muted-foreground">
              Source: {item.kind === "rake" ? item.puzzle.site : item.calm.site}
              {(item.kind === "rake" ? item.puzzle.time_control : item.calm.time_control)
                ? ` · ${item.kind === "rake" ? item.puzzle.time_control : item.calm.time_control}`
                : ""}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------------

function SetupScreen({
  stats,
  band,
  count,
  importMsg,
  deckError,
  records,
  dueCount,
  onBand,
  onCount,
  onStart,
  onImportText,
  onExit,
}: {
  stats: PuzzleStats | null
  band: string | null
  count: number
  importMsg: string | null
  deckError: string | null
  records: BandRecord[]
  dueCount: number
  onBand: (b: string | null) => void
  onCount: (n: number) => void
  onStart: () => void
  onImportText: (text: string) => void
  onExit?: () => void
}) {
  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = "" // allow re-picking the same file
    if (!file) return
    file
      .text()
      .then(onImportText)
      .catch(() => onImportText("")) // unreadable file → parse error surfaces
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6" data-testid="puzzles-setup">
      <div className="max-w-xl w-full space-y-5">
        <div>
          {onExit && (
            <button onClick={onExit} className="text-xs text-muted-foreground hover:text-foreground" data-testid="puzzles-back">
              ‹ Back
            </button>
          )}
          <h1 className="text-2xl font-bold mt-1">Avoidance — don&apos;t step on the rake</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Positions one move before a real player&apos;s eval cliff. There is no &quot;tactic
            here!&quot; tell — most moves are fine, one loses. Make any sound move; step on the rake
            and you experience the refutation.
          </p>
        </div>

        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-3">
          <div className="text-sm" data-testid="puzzles-stats">
            {stats === null ? (
              <span className="text-muted-foreground italic">Loading puzzle counts…</span>
            ) : stats.total === 0 ? (
              <span className="text-muted-foreground">
                No puzzles in the database yet — import a mined batch below.
              </span>
            ) : (
              <span>
                <span className="font-bold tabular-nums">{stats.total}</span>{" "}
                <span className="text-muted-foreground">puzzles, mined from real games.</span>
              </span>
            )}
          </div>

          {stats !== null && stats.total > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground mr-1">Band:</span>
                <BandChip label="All" active={band === null} onClick={() => onBand(null)} testid="puzzles-band-all" />
                {stats.bands.map((b) => (
                  <BandChip
                    key={b.band}
                    label={`${b.band} (${b.count})`}
                    active={band === b.band}
                    onClick={() => onBand(b.band)}
                    testid={`puzzles-band-${b.band}`}
                  />
                ))}
              </div>
              <div className="flex items-end gap-3">
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Puzzles</span>
                  <Input
                    type="number"
                    min={1}
                    max={50}
                    value={count}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10)
                      if (Number.isFinite(n)) onCount(Math.min(Math.max(n, 1), 50))
                    }}
                    className="w-20 tabular-nums"
                    data-testid="puzzles-count"
                  />
                </label>
                <Button onClick={onStart} data-testid="puzzles-start">
                  Start deck
                </Button>
              </div>
            </>
          )}
          {deckError && (
            <p className="text-sm text-red-400" data-testid="puzzles-deck-error">
              {deckError}
            </p>
          )}
        </div>

        {(records.length > 0 || dueCount > 0) && (
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-2">
            <div className="text-sm font-semibold">Your record</div>
            {dueCount > 0 && (
              <p className="text-xs text-amber-300" data-testid="puzzles-due">
                {dueCount} failed puzzle{dueCount === 1 ? "" : "s"} due for review — they lead your
                next deck.
              </p>
            )}
            {records.length > 0 && (
              <table className="text-xs tabular-nums w-full" data-testid="puzzles-record">
                <thead>
                  <tr className="text-muted-foreground text-left">
                    <th className="font-normal py-0.5">Band</th>
                    <th className="font-normal py-0.5 text-right">Solved / attempted</th>
                    <th className="font-normal py-0.5 text-right">Last 7 days</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.band} data-testid={`puzzles-record-${r.band}`}>
                      <td className="py-0.5">{r.band}</td>
                      <td className="py-0.5 text-right">
                        {r.solved}/{r.attempted}
                      </td>
                      <td className="py-0.5 text-right text-muted-foreground">
                        {r.recentAttempted > 0 ? `${r.recentSolved}/${r.recentAttempted}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-2">
          <div className="text-sm font-semibold">Import puzzles</div>
          <p className="text-xs text-muted-foreground">
            Load a <code className="font-mono">*.cliffs.jsonl</code> batch from{" "}
            <code className="font-mono">scripts/mining/mine_cliffs.py</code>. Re-importing is safe —
            duplicates are skipped.
          </p>
          <label className="inline-flex">
            <input
              type="file"
              accept=".jsonl,.json,application/jsonl"
              onChange={onFilePicked}
              className="hidden"
              data-testid="puzzles-import-file"
            />
            <span className="cursor-pointer inline-flex items-center px-3 h-8 rounded-md border border-input bg-transparent text-sm hover:bg-white/5">
              Import puzzles…
            </span>
          </label>
          {importMsg && (
            <p className="text-xs text-muted-foreground" data-testid="puzzles-import-msg">
              {importMsg}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function BandChip({
  label,
  active,
  onClick,
  testid,
}: {
  label: string
  active: boolean
  onClick: () => void
  testid: string
}) {
  return (
    <button
      data-testid={testid}
      onClick={onClick}
      className={`px-2 py-1 text-xs rounded-md border transition-colors tabular-nums ${
        active
          ? "border-white/30 bg-white/10 text-foreground"
          : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
      }`}
    >
      {label}
    </button>
  )
}

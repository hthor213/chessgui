// Avoidance puzzles (spec 211, Tier 1): types, MANY-CORRECT grading, and the
// provider seam over the Rust `puzzles_*` commands (src-tauri/src/puzzles.rs).
//
// Grading semantics (spec 211 "Puzzle Mechanics", using the generator's own
// vocabulary so there is ONE definition of "safe", not two):
//   • the stored trap move → FAIL, replay the stored refutation line;
//   • any other move is engine-checked (fixed depth = the puzzle's verify
//     depth, mover-POV cp — the same convention as verified_pre_best_cp):
//       – within safe_threshold of the verified best  → safe;
//       – worse than that but not losing              → correct, with a note
//         ("safe, though X was more accurate");
//       – at or below the lost bar (or mated)         → FAIL, replay the
//         engine's PV as the refutation;
//   • outside Tauri no engine exists: a non-trap move is reported honestly as
//     "not the rake — unverified", never as engine-confirmed safe.
//
// The lost bar mirrors mine_cliffs.py's --lost-threshold default (100cp): the
// generator counted "reasonable alternatives" as moves not below it, so the
// solver failing you below the same bar is consistent with how the puzzle was
// built. It is a constant here because the generator does not persist it
// per-row (only safe_threshold travels in the JSONL).

import { getProviders } from "@/lib/platform"
import { calmDeck, getCalm, type CalmRow } from "@/lib/calm-positions"
import { dueRespawns, rakeKey, type PuzzleResultEntry } from "@/lib/puzzle-results"

// ---------------------------------------------------------------------------
// Types mirroring the Rust structs (src-tauri/src/puzzles.rs)
// ---------------------------------------------------------------------------

// Extracted to @chessgui/core (spec 220 step 5); re-exported so existing
// importers keep working.
import type {
  DeckRequest,
  MoveCheck,
  PuzzleImportReport,
  PuzzleRow,
  PuzzleStats,
} from "@chessgui/core/puzzle-types"
export type { DeckRequest, MoveCheck, PuzzleImportReport, PuzzleRow, PuzzleStats }
export { OPENING_MAX_PLY } from "@chessgui/core/puzzle-types"

// ---------------------------------------------------------------------------
// Grading (pure)
// ---------------------------------------------------------------------------

/** mine_cliffs.py --lost-threshold default: an alternative at or below −1.0
 *  for the mover was not counted as reasonable by the generator, and is a
 *  fail here. Not persisted per-row (see module header). */
export const LOST_THRESHOLD_CP = 100

export type GradeVerdict =
  /** The stored trap move — the rake itself. */
  | "trap"
  /** A different move the engine grades as losing — a rake of its own. */
  | "blunder"
  /** Within the safe window of the verified best. */
  | "safe"
  /** Correct but meaningfully worse than best ("safe, though …"). */
  | "inaccuracy"
  /** Not the trap, but no engine was available to verify it. */
  | "safe_unverified"

export interface Grade {
  verdict: GradeVerdict
  /** Scores the puzzle: everything except trap/blunder. */
  correct: boolean
  /** One-line explanation for the result card. */
  note: string
  /** Refutation to replay on failure (starts from the position AFTER the
   *  failed move), else empty. */
  replayLine: string[]
}

function pawns(cp: number): string {
  const v = cp / 100
  return v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1)
}

/**
 * Grade `uci` against `puzzle`. `check` is the fixed-depth engine read for
 * that move (mover POV), or null when no engine is available. The trap move
 * needs no engine — the generator already verified its refutation.
 */
export function gradeMove(puzzle: PuzzleRow, uci: string, check: MoveCheck | null): Grade {
  if (uci === puzzle.trap_uci) {
    const after = puzzle.verified_after_cp
    return {
      verdict: "trap",
      correct: false,
      note: puzzle.mate
        ? `${puzzle.trap_san ?? uci} steps on the rake — it runs into a forced mate.`
        : `${puzzle.trap_san ?? uci} steps on the rake — the reply leaves you at ${
            after != null ? pawns(after) : "a lost eval"
          }.`,
      replayLine: puzzle.refutation_line,
    }
  }

  if (check === null) {
    return {
      verdict: "safe_unverified",
      correct: true,
      note: "Not the rake. Engine check unavailable here, so this move is unverified — the desktop app grades it fully.",
      replayLine: [],
    }
  }

  const best = puzzle.verified_pre_best_cp ?? 0
  // Mate scores dominate cp: getting mated is a fail, mating is safe.
  if (check.mate_mover != null) {
    if (check.mate_mover < 0) {
      return {
        verdict: "blunder",
        correct: false,
        note: `Not the stored trap, but this loses too — mate in ${-check.mate_mover}.`,
        replayLine: check.pv,
      }
    }
    return {
      verdict: "safe",
      correct: true,
      note: `Safe — in fact it mates in ${check.mate_mover}.`,
      replayLine: [],
    }
  }

  const cp = check.cp_mover ?? 0
  if (cp <= -LOST_THRESHOLD_CP) {
    return {
      verdict: "blunder",
      correct: false,
      note: `Not the stored trap, but this loses too (${pawns(cp)} at depth ${check.depth}).`,
      replayLine: check.pv,
    }
  }
  if (cp >= best - puzzle.safe_threshold) {
    return {
      verdict: "safe",
      correct: true,
      note: `Safe (${pawns(cp)} at depth ${check.depth} — best was ${pawns(best)}).`,
      replayLine: [],
    }
  }
  return {
    verdict: "inaccuracy",
    correct: true,
    note: `Safe, though not best — ${pawns(cp)} vs ${pawns(best)} at depth ${check.depth}. You avoided the rake.`,
    replayLine: [],
  }
}

/**
 * Grade a move on a CALM position (spec 211 mixed decks: no stored trap —
 * "any developing move passes"). Same thresholds as gradeMove's engine path,
 * against the calm row's own verified best; the notes may reveal the
 * position was calm because grading happens strictly AFTER the answer.
 */
export function gradeCalmMove(calm: CalmRow, check: MoveCheck | null): Grade {
  if (check === null) {
    return {
      verdict: "safe_unverified",
      correct: true,
      note: "Engine check unavailable here, so this move is unverified — the desktop app grades it fully.",
      replayLine: [],
    }
  }
  if (check.mate_mover != null) {
    if (check.mate_mover < 0) {
      return {
        verdict: "blunder",
        correct: false,
        note: `This position was calm — most moves were fine, but this one runs into mate in ${-check.mate_mover}.`,
        replayLine: check.pv,
      }
    }
    return {
      verdict: "safe",
      correct: true,
      note: `Safe — in fact it mates in ${check.mate_mover}.`,
      replayLine: [],
    }
  }
  const best = calm.verified_pre_best_cp
  const cp = check.cp_mover ?? 0
  if (cp <= -LOST_THRESHOLD_CP) {
    return {
      verdict: "blunder",
      correct: false,
      note: `This position was calm — most moves were fine, but this one loses (${pawns(cp)} at depth ${check.depth}).`,
      replayLine: check.pv,
    }
  }
  if (cp >= best - calm.safe_threshold) {
    return {
      verdict: "safe",
      correct: true,
      note: `Sound (${pawns(cp)} at depth ${check.depth}). This position was calm — most moves keep the balance.`,
      replayLine: [],
    }
  }
  return {
    verdict: "inaccuracy",
    correct: true,
    note: `Safe, though not most accurate — ${pawns(cp)} vs ${pawns(best)} at depth ${check.depth}. The position was calm.`,
    replayLine: [],
  }
}

// ---------------------------------------------------------------------------
// Deck sessions: respawns-first draw, ~70/30 rake/calm fresh mix, session
// streak. Results persist via lib/puzzle-results.ts (the caller records).
// ---------------------------------------------------------------------------


export const DEFAULT_DECK_SIZE = 5

/** Map a rating (e.g. the latest maia_rapid metric) to the generator's
 *  100-Elo band label. The corpus floor/ceiling clamp keeps thin tails
 *  usable (mirrors the spec's TAIL RULE at the top; data starts at 1400). */
export function bandForRating(rating: number | null): string | null {
  if (rating == null || !Number.isFinite(rating)) return null
  const clamped = Math.min(Math.max(rating, 1400), 2400)
  return String(Math.floor(clamped / 100) * 100)
}

export interface SessionResult {
  /** DB row id for rake puzzles, the stable string id for calm rows. */
  puzzleId: number | string
  verdict: GradeVerdict
  correct: boolean
}

/** Current session streak: consecutive correct answers counting back from
 *  the latest result. Resets to 0 the moment a rake is stepped on. */
export function streak(results: readonly SessionResult[]): number {
  let n = 0
  for (let i = results.length - 1; i >= 0 && results[i].correct; i--) n++
  return n
}

export interface SessionSummary {
  total: number
  correct: number
  rakes: number
  unverified: number
}

export function summarize(results: SessionResult[]): SessionSummary {
  return {
    total: results.length,
    correct: results.filter((r) => r.correct).length,
    rakes: results.filter((r) => !r.correct).length,
    unverified: results.filter((r) => r.verdict === "safe_unverified").length,
  }
}

// ---------------------------------------------------------------------------
// Mixed-deck builder (spec 211: calm mix + respawn priority)
// ---------------------------------------------------------------------------

/** One deck slot: a mined rake puzzle or an engine-verified calm position.
 *  `respawn` marks a failed puzzle back for review (spaced repetition). */
export type DeckItem =
  | { kind: "rake"; puzzle: PuzzleRow; respawn: boolean }
  | { kind: "calm"; calm: CalmRow; respawn: boolean }

export function deckItemFen(item: DeckItem): string {
  return item.kind === "rake" ? item.puzzle.fen : item.calm.fen
}

export function deckItemBand(item: DeckItem): string | null {
  return item.kind === "rake" ? item.puzzle.band : item.calm.band
}

/** Stable spaced-repetition identity (see lib/puzzle-results.ts). */
export function deckItemKey(item: DeckItem): string {
  return item.kind === "rake" ? rakeKey(item.puzzle.fen, item.puzzle.trap_uci) : item.calm.id
}

/** Fraction of the FRESH draw that is calm (spec 211 default ~70/30). */
export const CALM_RATIO = 0.3

/** Calm slots in a fresh draw of `n`: nearest integer to 30% (5 → 2, 10 → 3,
 *  1 → 0). Rounding, not flooring, so small decks still carry calm. */
export function calmCountFor(n: number): number {
  return Math.max(0, Math.round(n * CALM_RATIO))
}

export interface BuildDeckOptions {
  /** The attempt log (lib/puzzle-results.ts). Empty = no respawns. */
  entries?: readonly PuzzleResultEntry[]
  now?: number
  /** Injectable for deterministic tests; shuffles the fresh mix. */
  rng?: () => number
}

/**
 * Build a session deck of `req.count` items:
 *   1. Due respawns first (longest-overdue leading) — failed puzzles whose
 *      review day has come get priority, filtered to the requested band
 *      ("All" reviews every band). Rake respawns are refetched by row id and
 *      dropped if the row no longer matches (DB rebuilt) — better a fresh
 *      puzzle than a wrong one.
 *   2. The remaining slots are a fresh draw, ~70/30 rake/calm (calmCountFor),
 *      shuffled together so position in the deck never signals the kind
 *      (spec 211's anchor-leak lesson). Short supply on either side tops up
 *      from the other; if both are short the deck is short — honestly.
 *
 * `req.maxPly` (opening decks) is a hard filter on every source — fresh
 * rakes, calm mix AND respawns (a midgame review inside an opening deck
 * would leak the kind by feel alone); filtered-out respawns stay due and
 * lead the next uncapped deck instead.
 */
export async function buildDeck(req: DeckRequest, opts: BuildDeckOptions = {}): Promise<DeckItem[]> {
  const now = opts.now ?? Date.now()
  const rng = opts.rng ?? Math.random
  const entries = opts.entries ?? []

  const maxPly = req.maxPly ?? null
  const inPhase = (ply: number | null) => maxPly === null || (ply !== null && ply < maxPly)

  const respawns: DeckItem[] = []
  const usedRakeKeys = new Set<string>()
  const usedCalmIds = new Set<string>()
  for (const r of dueRespawns(entries, now)) {
    if (respawns.length >= req.count) break
    if (req.band !== null && r.band !== req.band) continue
    if (r.kind === "calm") {
      const calm = getCalm(r.key)
      if (calm && inPhase(calm.ply) && !usedCalmIds.has(calm.id)) {
        respawns.push({ kind: "calm", calm, respawn: true })
        usedCalmIds.add(calm.id)
      }
    } else if (r.puzzleId != null) {
      const row = await getPuzzle(r.puzzleId)
      if (
        row &&
        row.fen === r.fen &&
        inPhase(row.ply) &&
        !usedRakeKeys.has(rakeKey(row.fen, row.trap_uci))
      ) {
        respawns.push({ kind: "rake", puzzle: row, respawn: true })
        usedRakeKeys.add(rakeKey(row.fen, row.trap_uci))
      }
    }
  }

  const fresh = req.count - respawns.length
  // Calm first (bounded supply), remainder to rakes; a thin rake draw hands
  // its unfilled slots back to calm.
  const calmRows = calmDeck(req.band, calmCountFor(fresh), usedCalmIds, rng, maxPly)
  const rakeTarget = fresh - calmRows.length
  let rakeRows: PuzzleRow[] = []
  if (rakeTarget > 0) {
    const drawn = await puzzleDeck({
      band: req.band,
      count: rakeTarget + usedRakeKeys.size,
      maxPly,
    })
    rakeRows = drawn
      .filter((p) => !usedRakeKeys.has(rakeKey(p.fen, p.trap_uci)))
      .slice(0, rakeTarget)
  }
  if (rakeRows.length < rakeTarget) {
    const exclude = new Set([...usedCalmIds, ...calmRows.map((c) => c.id)])
    calmRows.push(...calmDeck(req.band, rakeTarget - rakeRows.length, exclude, rng, maxPly))
  }

  const freshItems: DeckItem[] = [
    ...rakeRows.map((puzzle): DeckItem => ({ kind: "rake", puzzle, respawn: false })),
    ...calmRows.map((calm): DeckItem => ({ kind: "calm", calm, respawn: false })),
  ]
  for (let i = freshItems.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[freshItems[i], freshItems[j]] = [freshItems[j], freshItems[i]]
  }
  return [...respawns, ...freshItems]
}

// ---------------------------------------------------------------------------
// Provider seam (spec 220 step 2: deck persistence rides DatabaseProvider,
// the Stockfish-backed move check rides EngineProvider)
// ---------------------------------------------------------------------------

/** The surface both the Tauri path and the mock implement. */
export interface PuzzlesApi {
  importPuzzles(args: { text?: string; filePath?: string; dbPath?: string }): Promise<PuzzleImportReport>
  deck(req: DeckRequest, dbPath?: string): Promise<PuzzleRow[]>
  getPuzzle(id: number, dbPath?: string): Promise<PuzzleRow | null>
  stats(dbPath?: string): Promise<PuzzleStats>
  /** Fixed-depth engine read of `fen` after `uci`, mover POV — or null when
   *  no engine exists (the mock): the HONEST fallback, never a fake score. */
  checkMove(fen: string, uci: string, depth: number): Promise<MoveCheck | null>
}

/** Import generator JSONL (`text` from a file picker, or `filePath` in Tauri). */
export function importPuzzles(args: {
  text?: string
  filePath?: string
  dbPath?: string
}): Promise<PuzzleImportReport> {
  return getProviders().database.importPuzzles(args)
}

/** Draw a deck: random within the band, topped up from all bands when thin. */
export function puzzleDeck(req: DeckRequest, dbPath?: string): Promise<PuzzleRow[]> {
  return getProviders().database.puzzleDeck(req, dbPath)
}

export function getPuzzle(id: number, dbPath?: string): Promise<PuzzleRow | null> {
  return getProviders().database.getPuzzle(id, dbPath)
}

export function puzzleStats(dbPath?: string): Promise<PuzzleStats> {
  return getProviders().database.puzzleStats(dbPath)
}

/** Engine check for a candidate move. Resolves null on engine-less shells. */
export function checkMove(fen: string, uci: string, depth: number): Promise<MoveCheck | null> {
  return getProviders().engine.puzzleCheckMove(fen, uci, depth)
}

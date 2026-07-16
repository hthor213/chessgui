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

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/database"

// ---------------------------------------------------------------------------
// Types mirroring the Rust structs (src-tauri/src/puzzles.rs)
// ---------------------------------------------------------------------------

/** One puzzle row. Mirrors Rust `PuzzleRow`; snake_case is serde's wire shape. */
export type PuzzleRow = {
  id: number
  fen: string
  trap_uci: string
  trap_san: string | null
  refutation_line: string[]
  played_reply_san: string | null
  safe_threshold: number
  eval_before_cp: number | null
  eval_after_cp: number | null
  verified_pre_best_cp: number | null
  verified_after_cp: number | null
  n_alternatives: number | null
  mate: boolean
  mover: string | null
  ply: number | null
  band: string | null
  white_elo: number | null
  black_elo: number | null
  source_game_id: string | null
  site: string | null
  date: string | null
  time_control: string | null
  themes: string[]
  band_miss_rates: string | null
  engine_verify_depth: number
}

/** Outcome of a JSONL import. Mirrors Rust `PuzzleImportReport`. */
export type PuzzleImportReport = {
  imported: number
  dups_skipped: number
  errors: number
}

export type PuzzleStats = {
  total: number
  bands: { band: string; count: number }[]
}

/** Engine verdict on a candidate move, MOVER-POV (mirrors Rust `MoveCheck`).
 *  `null` at the seam means "no engine available" (plain browser). */
export type MoveCheck = {
  cp_mover: number | null
  mate_mover: number | null
  pv: string[]
  depth: number
}

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

// ---------------------------------------------------------------------------
// Deck sessions (minimal: N puzzles, tallied — streaks/spaced-rep are spec
// 211 session-flow items, deliberately NOT built here)
// ---------------------------------------------------------------------------

export interface DeckRequest {
  /** Mover Elo band ("1900" … "2500"), or null for all bands. */
  band: string | null
  count: number
}

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
  puzzleId: number
  verdict: GradeVerdict
  correct: boolean
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
// Provider seam (Tauri commands vs the in-memory mock, like lib/database.ts)
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

let mockApiPromise: Promise<PuzzlesApi> | null = null
function mockApi(): Promise<PuzzlesApi> {
  if (!mockApiPromise) {
    mockApiPromise = import("./puzzles-mock").then((m) => m.mockPuzzles)
  }
  return mockApiPromise
}

/** Import generator JSONL (`text` from a file picker, or `filePath` in Tauri). */
export function importPuzzles(args: {
  text?: string
  filePath?: string
  dbPath?: string
}): Promise<PuzzleImportReport> {
  if (!isTauri()) return mockApi().then((m) => m.importPuzzles(args))
  return invoke<PuzzleImportReport>("puzzles_import", {
    text: args.text ?? null,
    filePath: args.filePath ?? null,
    dbPath: args.dbPath ?? null,
  })
}

/** Draw a deck: random within the band, topped up from all bands when thin. */
export function puzzleDeck(req: DeckRequest, dbPath?: string): Promise<PuzzleRow[]> {
  if (!isTauri()) return mockApi().then((m) => m.deck(req, dbPath))
  return invoke<PuzzleRow[]>("puzzles_deck", {
    band: req.band,
    theme: null,
    limit: req.count,
    dbPath: dbPath ?? null,
  })
}

export function getPuzzle(id: number, dbPath?: string): Promise<PuzzleRow | null> {
  if (!isTauri()) return mockApi().then((m) => m.getPuzzle(id, dbPath))
  return invoke<PuzzleRow | null>("puzzles_get", { id, dbPath: dbPath ?? null })
}

export function puzzleStats(dbPath?: string): Promise<PuzzleStats> {
  if (!isTauri()) return mockApi().then((m) => m.stats(dbPath))
  return invoke<PuzzleStats>("puzzles_stats", { dbPath: dbPath ?? null })
}

/** Engine check for a candidate move. Resolves null outside Tauri. */
export function checkMove(fen: string, uci: string, depth: number): Promise<MoveCheck | null> {
  if (!isTauri()) return mockApi().then((m) => m.checkMove(fen, uci, depth))
  return invoke<MoveCheck>("puzzle_check_move", { fen, uci, depth })
}

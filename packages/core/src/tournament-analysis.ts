// Spec 212 tier-1 consumers of the win-prob swing labeler (lib/win-prob.ts):
// per-engine error profiles (label × phase × clock pressure) with a delta
// view, band trajectories, seed/opening-family breakdown, termination-quality
// cross-classification, and the annotated-PGN handoff that carries swing
// labels into the Analyze tree as NAGs + comments.
//
// Everything here is pure aggregation over completed `GameOutcome`s — no
// Tauri, no DOM — so each analysis is unit-testable against fixture outcomes
// with known answers (spec 212 checklist items 3-8).

import {
  gameResult,
  plyEvalPawns,
  MATE_EVAL_PAWNS,
  STANDARD_START_FEN,
  type EvalMap,
  type GameOutcome,
} from "./tournament"
import {
  computeMoveSwings,
  decisiveMoment,
  DEFAULT_THRESHOLDS,
  type MoveLabel,
  type MoveSwing,
  type SwingThresholds,
  type WinProbCurve,
} from "./win-prob"
import { replayFens, sansFromUci } from "./game-replay"
import { ecoForFen, ecoLabel } from "./eco"

// ---------------------------------------------------------------------------
// Game phases (spec 212:38 "opening/middle/endgame by material+ply heuristic")
// ---------------------------------------------------------------------------

export type GamePhase = "opening" | "middlegame" | "endgame"
export const GAME_PHASES: GamePhase[] = ["opening", "middlegame", "endgame"]

/**
 * Endgame threshold: total non-pawn, non-king material on the board (both
 * sides, Q=9 R=5 B=N=3) at or below this is an endgame. 13 ≈ one side keeping
 * at most Q+N/R+R+B while the other is bare — the conventional "queens or
 * heavy pieces mostly off" line. Spec pins the heuristic's INPUTS (material +
 * ply) but not the constants; these are documented defaults.
 */
export const ENDGAME_MATERIAL_MAX = 13

/** Fullmove number at or below which a non-endgame position is "opening". */
export const OPENING_MAX_FULLMOVE = 10

/** Total non-pawn, non-king material (points) on the board of a FEN. */
export function fenMaterial(fen: string): number {
  const board = fen.split(/\s+/)[0] ?? ""
  let total = 0
  for (const ch of board) {
    switch (ch) {
      case "q": case "Q": total += 9; break
      case "r": case "R": total += 5; break
      case "b": case "B": case "n": case "N": total += 3; break
      default: break
    }
  }
  return total
}

/**
 * Phase of a single position. Material dominates (a ply-8 pawn ending is an
 * endgame); the opening window reads the FEN's own fullmove counter, so a
 * curated middlegame seed (fullmove 9+) never counts as "opening" just
 * because the ENGINES have only played a few moves from it.
 */
export function fenPhase(fen: string): GamePhase {
  if (fenMaterial(fen) <= ENDGAME_MATERIAL_MAX) return "endgame"
  const fullmove = parseInt(fen.split(/\s+/)[5] ?? "1", 10) || 1
  return fullmove <= OPENING_MAX_FULLMOVE ? "opening" : "middlegame"
}

/**
 * Phase of the position each move was played FROM: `phases[i]` is the phase
 * in which `moves[i]` (ply i+1) was chosen. Replays the game once; truncates
 * with `replayFens` on a malformed tail.
 */
export function gamePhases(startFen: string, moves: string[]): GamePhase[] {
  const fens = replayFens(startFen, moves)
  const n = Math.min(moves.length, fens.length - 1)
  const phases: GamePhase[] = []
  for (let i = 0; i < n; i++) phases.push(fenPhase(fens[i]))
  return phases
}

// ---------------------------------------------------------------------------
// Per-game analysis bundle (game list markers, spec 212:33-35 + 82)
// ---------------------------------------------------------------------------

export type LabelCounts = { inaccuracy: number; mistake: number; blunder: number }

export function emptyLabelCounts(): LabelCounts {
  return { inaccuracy: 0, mistake: 0, blunder: 0 }
}

/** One game's swing analysis, precomputed for the completed-games browser. */
export type GameAnalysis = {
  id: number
  swings: MoveSwing[]
  /** Labeled (inaccuracy/mistake/blunder) moves only, in ply order. */
  labeled: MoveSwing[]
  /** Largest win-prob drop — "where the game was decided" (spec 212:33). */
  decisive: MoveSwing | null
  /** Error counts per engine ("a"/"b"). */
  counts: { a: LabelCounts; b: LabelCounts }
}

export function analyzeGame(
  outcome: GameOutcome,
  curve: WinProbCurve,
  thresholds: SwingThresholds = DEFAULT_THRESHOLDS,
): GameAnalysis {
  const swings = computeMoveSwings(outcome, curve, thresholds)
  const labeled = swings.filter((s) => s.label !== null)
  const counts = { a: emptyLabelCounts(), b: emptyLabelCounts() }
  for (const s of labeled) counts[s.engine][s.label as MoveLabel]++
  return { id: outcome.id, swings, labeled, decisive: decisiveMoment(swings), counts }
}

// ---------------------------------------------------------------------------
// Per-engine error profile (spec 212:37-40 — label × phase × clock pressure)
// ---------------------------------------------------------------------------

/** "low" = mover's post-move clock was under the pressure threshold. Moves
 *  with no known clock (pre-212 payloads) count as "ok" — the un-pressured
 *  default — rather than inventing a third bucket. */
export type ClockBucket = "ok" | "low"
export const CLOCK_BUCKETS: ClockBucket[] = ["ok", "low"]

/** Spec 212:39's "sub-N-seconds flag" default N (ms). */
export const DEFAULT_LOW_CLOCK_MS = 30_000

export type ProfileCell = {
  /** Scored moves this engine played in this phase × clock bucket. */
  moves: number
  inaccuracy: number
  mistake: number
  blunder: number
}

export type EngineErrorProfile = {
  /** All scored moves this engine played (the per-100 denominators' total). */
  moves: number
  counts: LabelCounts
  cells: Record<GamePhase, Record<ClockBucket, ProfileCell>>
}

function emptyProfile(): EngineErrorProfile {
  const cell = (): ProfileCell => ({ moves: 0, inaccuracy: 0, mistake: 0, blunder: 0 })
  return {
    moves: 0,
    counts: emptyLabelCounts(),
    cells: {
      opening: { ok: cell(), low: cell() },
      middlegame: { ok: cell(), low: cell() },
      endgame: { ok: cell(), low: cell() },
    },
  }
}

/** Errors of `label` per 100 moves in a cell; null when the cell is empty. */
export function per100(cell: ProfileCell, label: MoveLabel): number | null {
  return cell.moves > 0 ? (cell[label] / cell.moves) * 100 : null
}

/**
 * Aggregate both engines' error profiles over a run (spec 212:37-40). Only
 * SCORED moves (both neighboring plies evaluated — same rule as
 * computeMoveSwings) enter the denominators, so "errors per 100 moves" is
 * measured against the moves that could have been labeled at all.
 */
export function buildErrorProfiles(
  outcomes: GameOutcome[],
  curve: WinProbCurve,
  opts: { thresholds?: SwingThresholds; lowClockMs?: number } = {},
): { a: EngineErrorProfile; b: EngineErrorProfile } {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS
  const lowClockMs = opts.lowClockMs ?? DEFAULT_LOW_CLOCK_MS
  const a = emptyProfile()
  const b = emptyProfile()
  for (const o of outcomes) {
    const g = gameResult(o)
    if (!g || o.aborted) continue
    const swings = computeMoveSwings(o, curve, thresholds)
    if (swings.length === 0) continue
    const phases = gamePhases(g.start_fen, g.moves)
    for (const s of swings) {
      const phase = phases[s.ply - 1]
      if (!phase) continue // move beyond the replayable prefix
      const bucket: ClockBucket =
        s.clockMs !== null && s.clockMs < lowClockMs ? "low" : "ok"
      const profile = s.engine === "a" ? a : b
      const cell = profile.cells[phase][bucket]
      profile.moves++
      cell.moves++
      if (s.label !== null) {
        profile.counts[s.label]++
        cell[s.label]++
      }
    }
  }
  return { a, b }
}

/** One row of the delta view: the same cell for both engines, side by side. */
export type ProfileDeltaRow = {
  phase: GamePhase
  clock: ClockBucket
  label: MoveLabel
  aMoves: number
  bMoves: number
  /** Errors per 100 moves (null when that engine has no moves in the cell). */
  aRate: number | null
  bRate: number | null
  /**
   * bRate / aRate when both are positive ("B blunders 3.1× more …");
   * Infinity when only B errs, 0 when only A errs, null when neither can be
   * compared (an empty cell or neither side erring).
   */
  ratio: number | null
}

/** Delta view rows (spec 212:40), every phase × clock × label combination
 *  where at least one engine has moves. */
export function errorProfileDelta(
  a: EngineErrorProfile,
  b: EngineErrorProfile,
): ProfileDeltaRow[] {
  const rows: ProfileDeltaRow[] = []
  const labels: MoveLabel[] = ["blunder", "mistake", "inaccuracy"]
  for (const phase of GAME_PHASES) {
    for (const clock of CLOCK_BUCKETS) {
      const ca = a.cells[phase][clock]
      const cb = b.cells[phase][clock]
      if (ca.moves === 0 && cb.moves === 0) continue
      for (const label of labels) {
        const aRate = per100(ca, label)
        const bRate = per100(cb, label)
        let ratio: number | null = null
        if (aRate !== null && bRate !== null && (aRate > 0 || bRate > 0)) {
          ratio = aRate > 0 ? bRate / aRate : Infinity
        }
        rows.push({ phase, clock, label, aMoves: ca.moves, bMoves: cb.moves, aRate, bRate, ratio })
      }
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Band trajectories (spec 212:45-47 — mean ± spread by starting-eval bucket)
// ---------------------------------------------------------------------------

export type BandPoint = { ply: number; mean: number; sd: number; n: number }

export type TrajectoryBand = {
  /** Starting-eval bucket bounds (pawns, ENGINE-A perspective). */
  lo: number
  hi: number
  center: number
  games: number
  /** Mean ± population-sd eval by ply, engine-A perspective, ply ascending. */
  points: BandPoint[]
}

/**
 * Band trajectories: games grouped by their starting eval (engine-A
 * perspective, so a flipped game's seed eval is sign-flipped along with its
 * per-ply evals — the same normalization `averageEvalByPly` uses), each band
 * carrying the mean ± spread of the eval at every ply. Answers "games
 * starting +1.0: how does the advantage typically evolve?" (spec 212:46-47).
 */
export function buildBandTrajectories(
  outcomes: GameOutcome[],
  evalById: EvalMap,
  bandWidth = 0.5,
  clampPawns = MATE_EVAL_PAWNS,
): TrajectoryBand[] {
  type Acc = { games: number; sum: number[]; sumSq: number[]; n: number[] }
  const accs = new Map<number, Acc>() // key: band index = floor(aStart / bandWidth)

  for (const o of outcomes) {
    const g = gameResult(o)
    if (!g || o.aborted) continue
    const meta = evalById.get(o.id)
    if (!meta) continue
    const evals = o.evals ?? []
    if (evals.length === 0) continue
    const aStart = o.flipped ? -meta.eval : meta.eval
    const key = Math.floor(aStart / bandWidth + 1e-9)
    let acc = accs.get(key)
    if (!acc) {
      acc = { games: 0, sum: [], sumSq: [], n: [] }
      accs.set(key, acc)
    }
    acc.games++
    for (const pe of evals) {
      let v = plyEvalPawns(pe)
      if (v === null) continue
      if (o.flipped) v = -v
      v = Math.max(-clampPawns, Math.min(clampPawns, v))
      acc.sum[pe.ply] = (acc.sum[pe.ply] ?? 0) + v
      acc.sumSq[pe.ply] = (acc.sumSq[pe.ply] ?? 0) + v * v
      acc.n[pe.ply] = (acc.n[pe.ply] ?? 0) + 1
    }
  }

  const bands: TrajectoryBand[] = []
  for (const [key, acc] of accs) {
    const lo = key * bandWidth
    const points: BandPoint[] = []
    for (let ply = 0; ply < acc.sum.length; ply++) {
      const n = acc.n[ply]
      if (!n) continue
      const mean = acc.sum[ply] / n
      const variance = Math.max(0, acc.sumSq[ply] / n - mean * mean)
      points.push({ ply, mean, sd: Math.sqrt(variance), n })
    }
    bands.push({ lo, hi: lo + bandWidth, center: lo + bandWidth / 2, games: acc.games, points })
  }
  bands.sort((x, y) => x.lo - y.lo)
  return bands
}

// ---------------------------------------------------------------------------
// Seed / opening-family breakdown (spec 212:49-51)
// ---------------------------------------------------------------------------

export type SeedFamilyRow = {
  /** Family key: "ECO · name" where known, else pool tag + |eval| bucket
   *  (or "standard start"). */
  key: string
  /** ECO code when the family is an ECO opening family; null otherwise. */
  eco: string | null
  tag: string | null
  /** |starting eval| bucket bounds (pawns); null for the standard start. */
  lo: number | null
  hi: number | null
  /** Distinct starting FENs in the family. */
  seeds: number
  games: number
  aWins: number
  draws: number
  aLosses: number
  /** Engine A's mean score across the family's games. */
  aScore: number
  /** Flagged when the family is decisively one-sided with a real sample. */
  lopsided: boolean
}

/** Minimum games before a family can be flagged lopsided. */
export const LOPSIDED_MIN_GAMES = 4
/** |aScore − 0.5| at/above which a family with enough games is lopsided. */
export const LOPSIDED_SCORE_MARGIN = 0.25

/**
 * Group completed games into starting-position families (spec 212:49-51),
 * "ECO where known" first: a seed classifies into an ECO opening family when
 * its position carries an explicit code (`ecoByFen`, from the EPD `eco`
 * opcode) or matches the coded-line table (eco.ts ecoForFen). Everything
 * else falls back to curated-pool tag (via `tagByFen`, e.g.
 * tagged_positions.json's `source`) × |starting-eval| bucket — sign is
 * arbitrary under color flip, so families bucket by magnitude while A's
 * score still folds both colors correctly.
 */
export function buildSeedBreakdown(
  outcomes: GameOutcome[],
  evalById: EvalMap,
  tagByFen?: Map<string, string>,
  bucketWidth = 0.5,
  ecoByFen?: Map<string, string>,
): SeedFamilyRow[] {
  type Acc = {
    eco: string | null
    tag: string | null
    lo: number | null
    hi: number | null
    fens: Set<string>
    games: number
    aWins: number
    draws: number
    aLosses: number
    scoreSum: number
  }
  const accs = new Map<string, Acc>()

  for (const o of outcomes) {
    const g = gameResult(o)
    if (!g || o.aborted) continue
    const meta = evalById.get(o.id)
    const isStandard = g.start_fen.trim() === STANDARD_START_FEN
    const tag = tagByFen?.get(g.start_fen) ?? null
    // The explicit per-position code (EPD opcode) outranks the table lookup.
    const eco = isStandard
      ? null
      : (ecoByFen?.get(g.start_fen)?.trim().toUpperCase() ?? ecoForFen(g.start_fen))
    let key: string
    let lo: number | null = null
    let hi: number | null = null
    if (isStandard) {
      key = "standard start"
    } else if (eco) {
      key = ecoLabel(eco)
    } else {
      const mag = Math.abs(meta?.eval ?? 0)
      const bucket = Math.floor(mag / bucketWidth + 1e-9)
      lo = bucket * bucketWidth
      hi = lo + bucketWidth
      key = `${tag ?? "untagged"} | ${lo.toFixed(2)}–${hi.toFixed(2)}`
    }
    let acc = accs.get(key)
    if (!acc) {
      acc = { eco, tag, lo, hi, fens: new Set(), games: 0, aWins: 0, draws: 0, aLosses: 0, scoreSum: 0 }
      accs.set(key, acc)
    }
    acc.fens.add(g.start_fen)
    acc.games++
    if (g.result === "1/2-1/2") {
      acc.draws++
      acc.scoreSum += 0.5
    } else if ((g.result === "1-0") === !o.flipped) {
      acc.aWins++
      acc.scoreSum += 1
    } else {
      acc.aLosses++
    }
  }

  const rows: SeedFamilyRow[] = []
  for (const [key, acc] of accs) {
    const aScore = acc.games > 0 ? acc.scoreSum / acc.games : 0.5
    rows.push({
      key,
      eco: acc.eco,
      tag: acc.tag,
      lo: acc.lo,
      hi: acc.hi,
      seeds: acc.fens.size,
      games: acc.games,
      aWins: acc.aWins,
      draws: acc.draws,
      aLosses: acc.aLosses,
      aScore,
      lopsided:
        acc.games >= LOPSIDED_MIN_GAMES &&
        Math.abs(aScore - 0.5) >= LOPSIDED_SCORE_MARGIN,
    })
  }
  // Most lopsided first — those are the findings; ties by sample size.
  rows.sort(
    (x, y) =>
      Math.abs(y.aScore - 0.5) - Math.abs(x.aScore - 0.5) || y.games - x.games,
  )
  return rows
}

// ---------------------------------------------------------------------------
// Termination quality (spec 212:53-56)
// ---------------------------------------------------------------------------

export type TerminationQualityRow = {
  termination: string
  games: number
  draws: number
  decisive: number
  /** Decisive games with no per-ply evals — can't be quality-classified. */
  unscored: number
  /** Loser had NO move ≥ mistake — the "engine gap" signal (spec 212:56). */
  groundDown: number
  /** Loser's errors were exactly one blunder (no other mistakes). */
  singleBlunder: number
  /** Loser made multiple labeled errors (≥ mistake beyond one blunder). */
  multiError: number
  /** Decisive games where the WINNER also had zero labeled errors —
   *  "converted cleanly by opponent". Orthogonal to the loser columns. */
  cleanConversion: number
}

/**
 * Cross-classify how games ended × how the loss happened (spec 212:53-56).
 * Loser categories partition the scored decisive games: ground-down (no loser
 * error ≥ mistake), single-blunder (exactly one blunder, no other mistakes),
 * multi-error (the rest). `cleanConversion` counts the winner's side of the
 * same games and can overlap any loser column.
 */
export function buildTerminationQuality(
  outcomes: GameOutcome[],
  curve: WinProbCurve,
  thresholds: SwingThresholds = DEFAULT_THRESHOLDS,
): TerminationQualityRow[] {
  const rows = new Map<string, TerminationQualityRow>()
  const rowFor = (term: string): TerminationQualityRow => {
    let r = rows.get(term)
    if (!r) {
      r = {
        termination: term,
        games: 0,
        draws: 0,
        decisive: 0,
        unscored: 0,
        groundDown: 0,
        singleBlunder: 0,
        multiError: 0,
        cleanConversion: 0,
      }
      rows.set(term, r)
    }
    return r
  }

  for (const o of outcomes) {
    const g = gameResult(o)
    if (!g || o.aborted) continue
    const r = rowFor(g.termination)
    r.games++
    if (g.result === "1/2-1/2") {
      r.draws++
      continue
    }
    r.decisive++
    const swings = computeMoveSwings(o, curve, thresholds)
    if (swings.length === 0) {
      r.unscored++
      continue
    }
    // Which engine lost: A is White unless flipped.
    const aWon = (g.result === "1-0") === !o.flipped
    const loser = aWon ? "b" : "a"
    let loserBlunders = 0
    let loserMistakes = 0
    let winnerErrors = 0
    for (const s of swings) {
      if (s.label === null || s.label === "inaccuracy") continue
      if (s.engine === loser) {
        if (s.label === "blunder") loserBlunders++
        else loserMistakes++
      } else {
        winnerErrors++
      }
    }
    if (loserBlunders === 0 && loserMistakes === 0) r.groundDown++
    else if (loserBlunders === 1 && loserMistakes === 0) r.singleBlunder++
    else r.multiError++
    if (winnerErrors === 0) r.cleanConversion++
  }

  return [...rows.values()].sort((x, y) => y.games - x.games)
}

// ---------------------------------------------------------------------------
// Annotated-PGN handoff (spec 212:58-61 — labels as NAGs + comments)
// ---------------------------------------------------------------------------

/** PGN Numeric Annotation Glyphs: ?! = $6, ? = $2, ?? = $4. */
export const LABEL_NAG: Record<MoveLabel, number> = {
  inaccuracy: 6,
  mistake: 2,
  blunder: 4,
}

const LABEL_TEXT: Record<MoveLabel, string> = {
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  blunder: "Blunder",
}

const pct = (v: number) => `${Math.round(v * 100)}%`

/** Human comment for one labeled swing (the tree comment in Analyze). */
export function swingComment(
  s: MoveSwing,
  moverName?: string,
  isDecisive = false,
): string {
  const drop = Math.round(s.drop * 100)
  const parts = [
    `${LABEL_TEXT[s.label ?? "inaccuracy"]}${moverName ? ` (${moverName})` : ""}: win prob ${pct(s.wpBefore)} → ${pct(s.wpAfter)} (−${drop}pp).`,
  ]
  if (s.bestMoveGapCp !== null && s.bestMoveGapCp > 0) {
    parts.push(`${s.bestMoveGapCp}cp off the evaluator's best move.`)
  }
  if (isDecisive) parts.push("Decisive moment.")
  return parts.join(" ")
}

/** Raw eval text for a `[%eval]` tag: mate as #n, else pawns. */
function evalTag(s: MoveSwing): string | null {
  const e = s.evalAfter
  if (e.mate != null) return `[%eval #${e.mate}]`
  if (e.cp != null) return `[%eval ${(e.cp / 100).toFixed(2)}]`
  return null
}

export type AnnotatedPgnOptions = {
  thresholds?: SwingThresholds
  event?: string
  white?: string
  black?: string
  /** Display names for engine a/b, used in move comments ("Blunder (Reckless): …"). */
  engineNames?: { a: string; b: string }
}

/**
 * Build a PGN whose labeled moves carry NAGs ($6/$2/$4) and comments (the
 * win-prob swing + best-move gap), and whose scored moves carry `[%eval]`
 * tags, so the game "opens in Analyze" with the error report already on the
 * tree (spec 212:58-61) and the eval graph populated. Same header/numbering
 * behavior as `movesToPgn` (which stays the unannotated path); round-trips
 * through `parsePgnToTrees` — NAGs land in `node.nags`, comments in
 * `node.comment`, `[%eval]` in `node.eval`.
 *
 * Returns null for Err/aborted outcomes (nothing to open).
 */
export function annotatedGamePgn(
  outcome: GameOutcome,
  curve: WinProbCurve,
  opts: AnnotatedPgnOptions = {},
): string | null {
  const g = gameResult(outcome)
  if (!g || outcome.aborted) return null

  const swings = computeMoveSwings(outcome, curve, opts.thresholds ?? DEFAULT_THRESHOLDS)
  const decisive = decisiveMoment(swings)
  const byPly = new Map<number, MoveSwing>()
  for (const s of swings) byPly.set(s.ply, s)

  // SAN reconstruction — same replay path movesToPgn uses.
  const sans = sansFromUci(g.start_fen, g.moves)

  const fields = g.start_fen.split(/\s+/)
  const isStandardStart = g.start_fen.trim() === STANDARD_START_FEN
  const header = [
    `[Event "${opts.event ?? "Engine tournament"}"]`,
    `[White "${opts.white ?? "White"}"]`,
    `[Black "${opts.black ?? "Black"}"]`,
    `[Result "${g.result}"]`,
  ]
  if (!isStandardStart) {
    header.push(`[SetUp "1"]`, `[FEN "${g.start_fen}"]`)
  }

  let fullmove = parseInt(fields[5] ?? "1", 10) || 1
  let whiteToMove = (fields[1] ?? "w") !== "b"
  const tokens: string[] = []
  for (let i = 0; i < sans.length; i++) {
    if (whiteToMove) tokens.push(`${fullmove}.`)
    else if (i === 0) tokens.push(`${fullmove}...`)
    tokens.push(sans[i])

    const s = byPly.get(i + 1)
    if (s) {
      const notes: string[] = []
      if (s.label !== null) {
        tokens.push(`$${LABEL_NAG[s.label]}`)
        const name = opts.engineNames ? opts.engineNames[s.engine] : undefined
        notes.push(
          swingComment(s, name, decisive !== null && decisive.ply === s.ply)
            // A stray brace would end the PGN comment early.
            .replace(/[{}]/g, ""),
        )
      }
      const ev = evalTag(s)
      if (ev) notes.push(ev)
      if (notes.length) tokens.push(`{ ${notes.join(" ")} }`)
    }

    if (!whiteToMove) fullmove++
    whiteToMove = !whiteToMove
  }
  tokens.push(g.result)

  return `${header.join("\n")}\n\n${tokens.join(" ")}\n`
}

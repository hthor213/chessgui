// Engine tournament types + sampling/pairing/aggregation logic.
//
// Mirrors the Rust structs in src-tauri/src/match_runner.rs. The backend exposes
// the `play_batch` / `cancel_batch` Tauri commands; this module builds the
// `GameSpec[]` payload, keeps the id -> eval side-table the Rust side does not
// carry, and aggregates outcomes into an eval -> conversion probability map.

// ---------------------------------------------------------------------------
// Types mirroring the Rust structs
// ---------------------------------------------------------------------------

/** One game to be played as part of a batch. Mirrors Rust `GameSpec`. */
export type GameSpec = {
  id: number
  white_path: string
  black_path: string
  start_fen: string | null
  movetime_ms: number
  max_plies: number
  flipped: boolean
}

/** A completed (or adjudicated) game. Mirrors Rust `GameResult`. */
export type GameResult = {
  result: "1-0" | "0-1" | "1/2-1/2"
  termination: string
  plies: number
  start_fen: string
  moves: string[]
}

/**
 * Outcome of attempting one `GameSpec`. serde serializes the Rust `Result` as
 * `{ Ok: GameResult }` or `{ Err: string }`, so the result is one of those
 * shapes.
 */
export type GameOutcome = {
  id: number
  flipped: boolean
  result: { Ok: GameResult } | { Err: string }
}

/** Progress event emitted as each game completes. Mirrors Rust `BatchProgress`. */
export type BatchProgress = {
  completed: number
  total: number
  last: GameOutcome
}

/** A single move streamed live as a game plays. Mirrors Rust `MoveEvent`. */
export type MoveEvent = {
  game_id: number
  ply: number
  uci: string
  /** Position AFTER the move. */
  fen: string
}

/** The currently-featured live game, surfaced for the board viewer. */
export type LiveGame = {
  gameId: number
  ply: number
  fen: string
  /** [from, to] squares of the last move, for board highlighting. */
  lastMove?: [string, string]
  whiteLabel: string
  blackLabel: string
}

/** Split a UCI move ("e2e4", "e7e8q") into [from, to] squares. */
export function uciSquares(uci: string): [string, string] | undefined {
  if (uci.length < 4) return undefined
  return [uci.slice(0, 2), uci.slice(2, 4)]
}

/** Aggregate raw W/D/L counts. Mirrors Rust `BatchSummary`. */
export type BatchSummary = {
  games: number
  white_wins: number
  black_wins: number
  draws: number
  errors: number
}

/** Full batch result. Mirrors Rust `BatchReport`. */
export type BatchReport = {
  outcomes: GameOutcome[]
  summary: BatchSummary
}

/** A tagged starting position from data/tagged_positions.json (White-POV eval). */
export type TaggedPosition = {
  fen: string
  eval_cp: number
  eval_pawns: number
  source: string
}

/** A seed for a pair of (color-flipped) games. */
export type Seed = {
  fen: string | null
  eval: number
}

export type StartMode = "normal" | "book" | "eval"

// ---------------------------------------------------------------------------
// Outcome helpers (handle the {Ok}/{Err} serde shape)
// ---------------------------------------------------------------------------

export function isOk(o: GameOutcome): o is GameOutcome & { result: { Ok: GameResult } } {
  return (o.result as { Ok?: GameResult }).Ok !== undefined
}

export function gameResult(o: GameOutcome): GameResult | null {
  return isOk(o) ? (o.result as { Ok: GameResult }).Ok : null
}

// ---------------------------------------------------------------------------
// Sampling for the three start modes
// ---------------------------------------------------------------------------

const STANDARD_START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Build `count` seeds for the chosen start mode.
 *
 * - "normal": every seed is the standard start position (eval 0).
 * - "book": sample for opening variety from roughly-balanced positions
 *   (|eval_pawns| <= 0.5). Varied openings, near-even material.
 * - "eval": eval-qualified spread. Bucket positions into ~0.25-pawn bins across
 *   [minEval, maxEval] and round-robin across the (shuffled) bins so the result
 *   has variance across the whole range. Empty bins are skipped.
 */
export function buildSeeds(
  mode: StartMode,
  count: number,
  positions: TaggedPosition[],
  minEval = -2,
  maxEval = 2,
): Seed[] {
  if (count <= 0) return []

  if (mode === "normal") {
    return Array.from({ length: count }, () => ({ fen: null as string | null, eval: 0 }))
  }

  if (mode === "book") {
    const balanced = positions.filter((p) => Math.abs(p.eval_pawns) <= 0.5)
    if (balanced.length === 0) {
      // Fallback: standard start if no balanced positions exist.
      return Array.from({ length: count }, () => ({ fen: null as string | null, eval: 0 }))
    }
    const pool = shuffle(balanced)
    const seeds: Seed[] = []
    for (let i = 0; i < count; i++) {
      // Cycle the (shuffled) pool if we need more seeds than distinct positions.
      const p = pool[i % pool.length]
      seeds.push({ fen: p.fen, eval: p.eval_pawns })
    }
    return seeds
  }

  // mode === "eval": eval-qualified spread (mirrors scripts/sample_spread.py).
  const binWidth = 0.25
  const lo = Math.min(minEval, maxEval)
  const hi = Math.max(minEval, maxEval)
  const nbins = Math.max(1, Math.round((hi - lo) / binWidth))

  const buckets: TaggedPosition[][] = Array.from({ length: nbins }, () => [])
  for (const p of positions) {
    const v = p.eval_pawns
    if (v >= lo && v < hi) {
      const idx = Math.floor((v - lo) / binWidth)
      if (idx >= 0 && idx < nbins) buckets[idx].push(p)
    }
  }
  for (let i = 0; i < nbins; i++) buckets[i] = shuffle(buckets[i])

  // Only non-empty bins participate in the round-robin.
  const activeBins = buckets
    .map((b, i) => ({ b, i }))
    .filter((x) => x.b.length > 0)

  if (activeBins.length === 0) {
    // No qualifying positions: fall back to standard start.
    return Array.from({ length: count }, () => ({ fen: null as string | null, eval: 0 }))
  }

  const cursors = new Map<number, number>()
  const seeds: Seed[] = []
  // Round-robin passes; reshuffle bin order each pass for jitter. Allow reuse
  // once distinct positions are exhausted so we always reach `count`.
  let guard = 0
  while (seeds.length < count) {
    const order = shuffle(activeBins.map((x) => x.i))
    let progressed = false
    for (const i of order) {
      if (seeds.length >= count) break
      const bucket = buckets[i]
      const cur = cursors.get(i) ?? 0
      if (cur < bucket.length) {
        const p = bucket[cur]
        seeds.push({ fen: p.fen, eval: p.eval_pawns })
        cursors.set(i, cur + 1)
        progressed = true
      }
    }
    if (!progressed) {
      // Distinct positions exhausted — reset cursors and reuse to fill count.
      cursors.clear()
      guard++
      if (guard > count + 2) break // safety: should never loop forever
    }
  }
  return seeds
}

// ---------------------------------------------------------------------------
// Pairing with color flip
// ---------------------------------------------------------------------------

export type EvalMap = Map<number, { eval: number }>

export type BuiltBatch = {
  specs: GameSpec[]
  evalById: EvalMap
}

/**
 * For each seed emit TWO color-flipped games that share the same start FEN+eval:
 *   game A: white=engineA, black=engineB, flipped=false
 *   game B: white=engineB, black=engineA, flipped=true
 * So "N games" requires ceil(N/2) seeds. ids are assigned sequentially. The
 * id -> eval map is returned separately since `GameSpec` carries no eval field.
 */
export function buildSpecs(
  seeds: Seed[],
  engineA: string,
  engineB: string,
  movetimeMs: number,
  maxPlies: number,
): BuiltBatch {
  const specs: GameSpec[] = []
  const evalById: EvalMap = new Map()
  let id = 0
  for (const seed of seeds) {
    const a: GameSpec = {
      id: id++,
      white_path: engineA,
      black_path: engineB,
      start_fen: seed.fen,
      movetime_ms: movetimeMs,
      max_plies: maxPlies,
      flipped: false,
    }
    evalById.set(a.id, { eval: seed.eval })
    specs.push(a)

    const b: GameSpec = {
      id: id++,
      white_path: engineB,
      black_path: engineA,
      start_fen: seed.fen,
      movetime_ms: movetimeMs,
      max_plies: maxPlies,
      flipped: true,
    }
    evalById.set(b.id, { eval: seed.eval })
    specs.push(b)
  }
  return { specs, evalById }
}

/**
 * Convenience: how many seeds are needed to produce (at least) `nGames` games,
 * given the 2-games-per-seed color flip.
 */
export function seedsForGames(nGames: number): number {
  return Math.max(1, Math.ceil(nGames / 2))
}

// ---------------------------------------------------------------------------
// Probability-map aggregation
// ---------------------------------------------------------------------------

/** One eval bin in the conversion probability map. */
export type ProbBin = {
  /** Bin lower bound (pawns, White-POV). */
  lo: number
  /** Bin upper bound (pawns). */
  hi: number
  /** Bin center, for labelling. */
  center: number
  count: number
  whiteWins: number
  draws: number
  blackWins: number
  /**
   * Mean score of the White (advantaged) side: 1.0 win / 0.5 draw / 0.0 loss.
   * "How often the side holding the +eval converted."
   */
  avgWhiteScore: number
}

/**
 * Bucket completed games by their starting White-POV eval into ~0.25-pawn bins.
 * For each game the score of the White side is 1.0 (1-0) / 0.5 (draw) / 0.0
 * (0-1). Err games are skipped. Bins are returned sorted ascending by eval.
 *
 * The range defaults to the supplied [minEval, maxEval] but is widened to cover
 * any seed evals that fall outside it (e.g. "book"/"normal" seeds at 0).
 */
export function buildProbabilityMap(
  outcomes: GameOutcome[],
  evalById: EvalMap,
  minEval = -2,
  maxEval = 2,
  binWidth = 0.25,
): ProbBin[] {
  // Determine the eval span actually present so no game is dropped.
  let lo = Math.min(minEval, maxEval)
  let hi = Math.max(minEval, maxEval)
  for (const { eval: e } of evalById.values()) {
    if (e < lo) lo = e
    if (e >= hi) hi = e + binWidth
  }
  // Snap bounds to the bin grid.
  lo = Math.floor(lo / binWidth) * binWidth
  hi = Math.ceil(hi / binWidth) * binWidth
  const nbins = Math.max(1, Math.round((hi - lo) / binWidth))

  type Acc = { count: number; w: number; d: number; b: number; scoreSum: number }
  const accs: Acc[] = Array.from({ length: nbins }, () => ({
    count: 0,
    w: 0,
    d: 0,
    b: 0,
    scoreSum: 0,
  }))

  for (const o of outcomes) {
    const g = gameResult(o)
    if (!g) continue // skip Err games
    const meta = evalById.get(o.id)
    if (!meta) continue
    let idx = Math.floor((meta.eval - lo) / binWidth)
    if (idx < 0) idx = 0
    if (idx >= nbins) idx = nbins - 1

    const acc = accs[idx]
    acc.count++
    if (g.result === "1-0") {
      acc.w++
      acc.scoreSum += 1
    } else if (g.result === "0-1") {
      acc.b++
      acc.scoreSum += 0
    } else {
      acc.d++
      acc.scoreSum += 0.5
    }
  }

  const bins: ProbBin[] = []
  for (let i = 0; i < nbins; i++) {
    const acc = accs[i]
    if (acc.count === 0) continue // omit empty bins from the map
    const binLo = lo + i * binWidth
    const binHi = binLo + binWidth
    bins.push({
      lo: binLo,
      hi: binHi,
      center: binLo + binWidth / 2,
      count: acc.count,
      whiteWins: acc.w,
      draws: acc.d,
      blackWins: acc.b,
      avgWhiteScore: acc.scoreSum / acc.count,
    })
  }
  bins.sort((a, b) => a.lo - b.lo)
  return bins
}

export { STANDARD_START_FEN }

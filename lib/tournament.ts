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
  /** Sudden-death base clock per side, milliseconds (engine-managed). */
  base_ms: number
  /** Increment added after each move, milliseconds. */
  inc_ms: number
  max_plies: number
  flipped: boolean
  /** Adjudicate <=7-man positions via the tablebase (perfect play). */
  adjudicate_tb: boolean
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
 * One neutral-evaluator score at a single ply. Mirrors Rust `PlyEval`. `ply` 0
 * is the start position; `ply` N is the position after the Nth half-move.
 * White-POV: + favors White. Exactly one of `cp`/`mate` is set (both null when
 * the evaluator produced no score).
 */
export type PlyEval = {
  ply: number
  cp: number | null
  mate: number | null
}

/** A neutral-evaluator score streamed live as a game plays. Mirrors Rust `EvalEvent`. */
export type EvalEvent = {
  game_id: number
  ply: number
  cp: number | null
  mate: number | null
}

/**
 * Outcome of attempting one `GameSpec`. serde serializes the Rust `Result` as
 * `{ Ok: GameResult }` or `{ Err: string }`, so the result is one of those
 * shapes. `evals` carries the neutral evaluator's per-ply White-POV scores
 * (empty when the evaluator was off or failed to start).
 */
export type GameOutcome = {
  id: number
  flipped: boolean
  result: { Ok: GameResult } | { Err: string }
  evals?: PlyEval[]
  /**
   * True when the game was cut short by a Stop request rather than finishing or
   * erroring. Aborted games are excluded from every result stat (they are not a
   * real outcome), and never shown in the completed-games browser.
   */
  aborted?: boolean
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
  /** White's remaining clock (ms) after this move. */
  wtime_ms: number
  /** Black's remaining clock (ms) after this move. */
  btime_ms: number
}

/** One recorded position of the featured live game, for back/forward nav. */
export type LiveFrame = {
  /** 1-based half-move index; 0 would be the start (not emitted as a frame). */
  ply: number
  fen: string
  /** [from, to] squares of the move that reached this position. */
  lastMove?: [string, string]
  whiteTimeMs: number
  blackTimeMs: number
  /** Neutral-evaluator score at THIS ply (White-POV), patched in as it arrives. */
  eval?: { cp: number | null; mate: number | null } | null
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
  /** Remaining clocks (ms) for each side. */
  whiteTimeMs: number
  blackTimeMs: number
  /**
   * Latest neutral-evaluator score for this game (White-POV), or null/undefined
   * when the evaluator is off or hasn't scored a position yet. Drives the live
   * eval bar; lags the board by roughly one ply, which is fine for a bar.
   */
  eval?: { cp: number | null; mate: number | null } | null
  /**
   * Full per-ply history of the featured game (since it became featured), so the
   * viewer can step back/forward and read the evaluator's eval at each ply. The
   * last frame is the live tip.
   */
  frames?: LiveFrame[]
}

/**
 * Live-viewer control surface, wired to the batch-control Tauri commands. Owned
 * by the Tournament tab (which knows the run state) and handed to the viewer so
 * Stop / Pause / auto-start / delay are reachable from the board window itself.
 */
export type ViewerControls = {
  paused: boolean
  autoStartNext: boolean
  /** A game just finished and the runner is waiting to start the next one. */
  waitingForNext: boolean
  delayMs: number
  onStop: () => void
  onTogglePause: () => void
  onToggleAutoStart: () => void
  onStartNext: () => void
  onSetDelay: (ms: number) => void
}

/** Move-display delay presets (ms) for the "too fast to follow" throttle. */
export const MOVE_DELAY_OPTIONS: { label: string; ms: number }[] = [
  { label: "No delay", ms: 0 },
  { label: "0.5s / move", ms: 500 },
  { label: "1s / move", ms: 1000 },
  { label: "2s / move", ms: 2000 },
]

/** A sudden-death + increment time control (per side). */
export type TimeControl = { id: string; label: string; baseMs: number; incMs: number }

/**
 * Base-time threshold (ms) at/above which the live eval bar defaults ON. At
 * 60s+ per side there's time to watch a game and the per-move eval reads are
 * meaningful; below it the games blitz by. This is only the DEFAULT — the user
 * can always override it.
 */
export const EVAL_BAR_BASE_MS_THRESHOLD = 60_000

/** Whether the eval bar should default ON for a given base clock (ms). */
export function evalBarDefaultForBaseMs(baseMs: number): boolean {
  return baseMs >= EVAL_BAR_BASE_MS_THRESHOLD
}

/**
 * Time-control presets. "Standard" (LTC, 60s+0.6s) is the established point
 * where the relative result between two engines is stable — see Fishtest.
 */
export const TIME_CONTROLS: TimeControl[] = [
  { id: "fast", label: "Fast — 10s + 0.1s", baseMs: 10_000, incMs: 100 },
  { id: "standard", label: "Standard — 60s + 0.6s", baseMs: 60_000, incMs: 600 },
  { id: "long", label: "Long — 300s + 3s", baseMs: 300_000, incMs: 3_000 },
  { id: "rapid", label: "Rapid — 10m + 5s", baseMs: 600_000, incMs: 5_000 },
]

/** Split a UCI move ("e2e4", "e7e8q") into [from, to] squares. */
export function uciSquares(uci: string): [string, string] | undefined {
  if (uci.length < 4) return undefined
  return [uci.slice(0, 2), uci.slice(2, 4)]
}

/**
 * Elo difference implied by a W/D/L record (from the first engine's view), with
 * a 95% confidence interval derived from the actual result distribution.
 * Returns null if no decisive sample. Positive elo = first engine stronger.
 */
export function eloDelta(
  wins: number,
  draws: number,
  losses: number,
): { score: number; elo: number; lo: number; hi: number } | null {
  const n = wins + draws + losses
  if (n === 0) return null
  const score = (wins + draws / 2) / n
  // s -> Elo, clamped so a clean sweep doesn't blow up to +/-Infinity.
  const toElo = (s: number) => {
    const c = Math.min(1 - 1e-9, Math.max(1e-9, s))
    return -400 * Math.log10(1 / c - 1)
  }
  const m = score
  const variance =
    (wins * (1 - m) ** 2 + draws * (0.5 - m) ** 2 + losses * (0 - m) ** 2) / n
  const se = Math.sqrt(variance / n)
  return {
    score,
    elo: toElo(score),
    lo: toElo(Math.max(0, m - 1.96 * se)),
    hi: toElo(Math.min(1, m + 1.96 * se)),
  }
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

export type StartMode = "normal" | "book" | "eval" | "current"

// ---------------------------------------------------------------------------
// Outcome helpers (handle the {Ok}/{Err} serde shape)
// ---------------------------------------------------------------------------

export function isOk(o: GameOutcome): o is GameOutcome & { result: { Ok: GameResult } } {
  return (o.result as { Ok?: GameResult }).Ok !== undefined
}

export function gameResult(o: GameOutcome): GameResult | null {
  return isOk(o) ? (o.result as { Ok: GameResult }).Ok : null
}

/** The error string of a failed outcome, or null if the game completed. */
export function gameError(o: GameOutcome): string | null {
  return isOk(o) ? null : (o.result as { Err: string }).Err
}

/**
 * Group failed outcomes by their (verbatim) error string, most frequent first.
 * Lets the UI render "2× Failed to start engine '…': …" instead of a bare
 * "Errors: 2", so a batch that fails is never opaque about WHY.
 */
export function summarizeErrors(
  outcomes: GameOutcome[],
): { message: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const o of outcomes) {
    if (o.aborted) continue // a Stop is not a failure
    const e = gameError(o)
    if (e === null) continue
    counts.set(e, (counts.get(e) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
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
 * - "current": every seed is `currentFen` — "play this position through". Each
 *   seed still becomes a color-flipped pair, so N games = N/2 identical pairs.
 */
export function buildSeeds(
  mode: StartMode,
  count: number,
  positions: TaggedPosition[],
  minEval = -2,
  maxEval = 2,
  currentFen: string | null = null,
): Seed[] {
  if (count <= 0) return []

  if (mode === "normal") {
    return Array.from({ length: count }, () => ({ fen: null as string | null, eval: 0 }))
  }

  if (mode === "current") {
    // No eval tag for an arbitrary user position; charts degenerate to one bin,
    // which is fine — the Summary card is the point of this mode.
    return Array.from({ length: count }, () => ({ fen: currentFen, eval: 0 }))
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

  // mode === "eval": absolute-imbalance spread. Under color-flip the SIGN of a
  // position's eval is irrelevant (a +0.6 position played flipped is a -0.6 for
  // the other engine), so qualify by |eval| magnitude across [lo, hi] and bucket
  // by magnitude. The seed keeps the signed eval for the per-engine curve.
  const binWidth = 0.25
  const lo = Math.max(0, Math.min(minEval, maxEval))
  const hi = Math.max(minEval, maxEval)
  const nbins = Math.max(1, Math.round((hi - lo) / binWidth))

  const buckets: TaggedPosition[][] = Array.from({ length: nbins }, () => [])
  for (const p of positions) {
    const v = Math.abs(p.eval_pawns)
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
 *
 * `flipFirst` reverses each pair's order (engine B takes White in the odd
 * games) — used by "current position" mode so engine A can start on the side
 * at the bottom of the user's board even when that side is Black. `flipped`
 * always means "engine A is Black", so downstream tallies are unaffected.
 */
export function buildSpecs(
  seeds: Seed[],
  engineA: string,
  engineB: string,
  baseMs: number,
  incMs: number,
  maxPlies: number,
  adjudicateTb: boolean,
  flipFirst = false,
): BuiltBatch {
  const specs: GameSpec[] = []
  const evalById: EvalMap = new Map()
  let id = 0
  for (const seed of seeds) {
    for (const flipped of flipFirst ? [true, false] : [false, true]) {
      const spec: GameSpec = {
        id: id++,
        white_path: flipped ? engineB : engineA,
        black_path: flipped ? engineA : engineB,
        start_fen: seed.fen,
        base_ms: baseMs,
        inc_ms: incMs,
        max_plies: maxPlies,
        flipped,
        adjudicate_tb: adjudicateTb,
      }
      evalById.set(spec.id, { eval: seed.eval })
      specs.push(spec)
    }
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

/**
 * W/D/L for ONE engine, binned by THAT engine's signed starting eval
 * (+x = it began the game up x pawns, -x = down x). Reuses ProbBin: whiteWins =
 * the engine's wins, blackWins = its losses, draws = draws, avgWhiteScore = its
 * mean score. Lets you read e.g. "when Stockfish was down 2.0: W/D/L" directly,
 * and compare the two engines' defense (negative bins) and conversion (positive).
 */
export function buildEngineWDL(
  outcomes: GameOutcome[],
  evalById: EvalMap,
  side: "a" | "b",
  minEval = -2.5,
  maxEval = 2.5,
  binWidth = 0.25,
): ProbBin[] {
  let lo = Math.min(minEval, maxEval)
  let hi = Math.max(minEval, maxEval)
  // Perspective evals span both signs; widen to cover the data either way.
  for (const { eval: e } of evalById.values()) {
    const m = Math.abs(e)
    if (-m < lo) lo = -m
    if (m + binWidth > hi) hi = m + binWidth
  }
  lo = Math.floor(lo / binWidth) * binWidth
  hi = Math.ceil(hi / binWidth) * binWidth
  const nbins = Math.max(1, Math.round((hi - lo) / binWidth))

  type Acc = { count: number; w: number; d: number; b: number; scoreSum: number }
  const accs: Acc[] = Array.from({ length: nbins }, () => ({
    count: 0, w: 0, d: 0, b: 0, scoreSum: 0,
  }))

  for (const o of outcomes) {
    const g = gameResult(o)
    if (!g) continue
    const meta = evalById.get(o.id)
    if (!meta) continue
    // Engine A is White when !flipped; engine B is White when flipped.
    const engineIsWhite = side === "a" ? !o.flipped : o.flipped
    const persp = engineIsWhite ? meta.eval : -meta.eval
    let idx = Math.floor((persp - lo) / binWidth)
    if (idx < 0) idx = 0
    if (idx >= nbins) idx = nbins - 1
    const acc = accs[idx]
    acc.count++
    if (g.result === "1/2-1/2") {
      acc.d++
      acc.scoreSum += 0.5
    } else if ((g.result === "1-0") === engineIsWhite) {
      acc.w++
      acc.scoreSum += 1
    } else {
      acc.b++
    }
  }

  const bins: ProbBin[] = []
  for (let i = 0; i < nbins; i++) {
    const acc = accs[i]
    if (acc.count === 0) continue
    const binLo = lo + i * binWidth
    bins.push({
      lo: binLo,
      hi: binLo + binWidth,
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

// ---------------------------------------------------------------------------
// Per-engine performance curve
// ---------------------------------------------------------------------------

/**
 * One eval bin in the per-engine performance curve. Each side ("a"/"b") records
 * how many games that engine played from a position with the bin's PERSPECTIVE
 * eval and its mean score (0..1) from those games. Empty sides have games:0.
 */
export type EngineCurveBin = {
  /** Bin lower bound (pawns, engine-perspective eval). */
  lo: number
  /** Bin upper bound (pawns). */
  hi: number
  /** Bin center, for labelling. */
  center: number
  a: { games: number; avgScore: number }
  b: { games: number; avgScore: number }
}

/**
 * Build a per-ENGINE score curve over starting eval. Unlike the conversion map
 * (which always measures from White's POV), this measures from each engine's
 * OWN perspective: how well engine A and engine B score as a function of the
 * eval they started from.
 *
 * Per game (skipping Err games and games with no recorded eval):
 *  - E = starting White-POV eval (pawns) from `evalById`.
 *  - Engine A is White when !flipped, else Black; Engine B is the other side.
 *  - Engine A's perspective-eval = E if A is White (!flipped), else -E.
 *  - Engine A's score = 1 if A won, 0.5 draw, 0 if A lost, where A won iff
 *    (result=="1-0" && !flipped) || (result=="0-1" && flipped).
 *  - Engine B is the mirror: perspective-eval = -A's, score = 1 - A's (0.5 draw).
 *
 * Because every seed is played from both colors, each engine accumulates data
 * across the whole +/- range, so both curves span the axis.
 *
 * Bins are ~`binWidth`-pawn wide spanning [lo, hi], widened to cover any data
 * that falls outside the requested range. Returned sorted ascending by center.
 */
export function buildEngineCurves(
  outcomes: GameOutcome[],
  evalById: EvalMap,
  minEval = -2,
  maxEval = 2,
  binWidth = 0.25,
): EngineCurveBin[] {
  // First pass: collect each engine's (perspectiveEval, score) samples so we can
  // determine the true span (perspective evals are mirrored, so the span is
  // symmetric around 0 but data may exceed the requested range).
  type Sample = { pe: number; score: number; engine: "a" | "b" }
  const samples: Sample[] = []
  for (const o of outcomes) {
    const g = gameResult(o)
    if (!g) continue // skip Err games
    const meta = evalById.get(o.id)
    if (!meta) continue
    const E = meta.eval
    // Engine A's score from its own perspective.
    const aWon =
      (g.result === "1-0" && !o.flipped) || (g.result === "0-1" && o.flipped)
    const draw = g.result === "1/2-1/2"
    const aScore = draw ? 0.5 : aWon ? 1 : 0
    const aPe = o.flipped ? -E : E // A is White only when !flipped
    samples.push({ pe: aPe, score: aScore, engine: "a" })
    samples.push({ pe: -aPe, score: draw ? 0.5 : 1 - aScore, engine: "b" })
  }

  // Determine the bin grid span, widening to cover all data.
  let lo = Math.min(minEval, maxEval)
  let hi = Math.max(minEval, maxEval)
  for (const s of samples) {
    if (s.pe < lo) lo = s.pe
    if (s.pe >= hi) hi = s.pe + binWidth
  }
  lo = Math.floor(lo / binWidth) * binWidth
  hi = Math.ceil(hi / binWidth) * binWidth
  const nbins = Math.max(1, Math.round((hi - lo) / binWidth))

  type Acc = { aGames: number; aSum: number; bGames: number; bSum: number }
  const accs: Acc[] = Array.from({ length: nbins }, () => ({
    aGames: 0,
    aSum: 0,
    bGames: 0,
    bSum: 0,
  }))

  for (const s of samples) {
    let idx = Math.floor((s.pe - lo) / binWidth)
    if (idx < 0) idx = 0
    if (idx >= nbins) idx = nbins - 1
    const acc = accs[idx]
    if (s.engine === "a") {
      acc.aGames++
      acc.aSum += s.score
    } else {
      acc.bGames++
      acc.bSum += s.score
    }
  }

  const bins: EngineCurveBin[] = []
  for (let i = 0; i < nbins; i++) {
    const acc = accs[i]
    const binLo = lo + i * binWidth
    bins.push({
      lo: binLo,
      hi: binLo + binWidth,
      center: binLo + binWidth / 2,
      a: { games: acc.aGames, avgScore: acc.aGames ? acc.aSum / acc.aGames : 0 },
      b: { games: acc.bGames, avgScore: acc.bGames ? acc.bSum / acc.bGames : 0 },
    })
  }
  bins.sort((a, b) => a.center - b.center)
  return bins
}

// ---------------------------------------------------------------------------
// Neutral-evaluator eval series (per-game graph + normalized average graph)
// ---------------------------------------------------------------------------

/**
 * Pawn value a mate score maps to for charting. A mate is "off the scale", so
 * it pins to the same visual bound the graphs clamp cp evals to — a single mate
 * never dwarfs the rest of the curve.
 */
export const MATE_EVAL_PAWNS = 10

/**
 * A [`PlyEval`] as a White-POV pawn value, or null when the ply has no score.
 * cp is /100; a mate maps to +/-[`MATE_EVAL_PAWNS`] by its sign (after the Rust
 * side already converted the score to White's POV).
 */
export function plyEvalPawns(e: PlyEval): number | null {
  if (e.mate != null) return (e.mate >= 0 ? 1 : -1) * MATE_EVAL_PAWNS
  if (e.cp != null) return e.cp / 100
  return null
}

/** A White-POV eval curve point for one game. */
export type EvalPoint = { ply: number; pawns: number | null }

/**
 * A single game's White-POV eval curve (the evaluator's numbers), one point per
 * recorded ply including the start position. Gaps (unscored plies) surface as
 * `pawns: null` so a chart can bridge them.
 */
export function gameEvalSeries(outcome: GameOutcome): EvalPoint[] {
  return (outcome.evals ?? []).map((pe) => ({ ply: pe.ply, pawns: plyEvalPawns(pe) }))
}

/** One point on the average eval curve: the mean over `n` games at that ply. */
export type AvgEvalPoint = { ply: number; mean: number; n: number }

/**
 * Mean eval by ply across completed games, normalized to ENGINE A's
 * perspective so + always means engine A is better.
 *
 * This normalization is the whole point: the evaluator scores White-POV, and
 * every opening is played from both colors, so engine A is White in half the
 * games and Black in the other half. Averaging the raw White-POV numbers would
 * make color-flipped pairs cancel to ~0. Flipping the sign for games where A
 * played Black (`flipped`) folds both colors onto A's perspective, so a real A
 * advantage accumulates instead of cancelling.
 *
 * Each contribution is clamped to +/-`clampPawns` (default [`MATE_EVAL_PAWNS`])
 * so one blowout or mate can't dominate the mean. Plies with no scored games
 * are omitted. Returned sorted ascending by ply.
 */
export function averageEvalByPly(
  outcomes: GameOutcome[],
  clampPawns = MATE_EVAL_PAWNS,
): AvgEvalPoint[] {
  const sum: number[] = []
  const cnt: number[] = []
  for (const o of outcomes) {
    if (o.aborted) continue // stopped mid-play: partial, excluded from the mean
    for (const pe of o.evals ?? []) {
      let v = plyEvalPawns(pe)
      if (v === null) continue
      // Fold onto engine A's perspective (A is White unless the game is flipped).
      if (o.flipped) v = -v
      v = Math.max(-clampPawns, Math.min(clampPawns, v))
      sum[pe.ply] = (sum[pe.ply] ?? 0) + v
      cnt[pe.ply] = (cnt[pe.ply] ?? 0) + 1
    }
  }
  const out: AvgEvalPoint[] = []
  for (let ply = 0; ply < sum.length; ply++) {
    if (!cnt[ply]) continue
    out.push({ ply, mean: sum[ply] / cnt[ply], n: cnt[ply] })
  }
  return out
}

export { STANDARD_START_FEN }

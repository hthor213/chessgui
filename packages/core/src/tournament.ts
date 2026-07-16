// Engine tournament types + sampling/pairing/aggregation logic.
//
// Mirrors the Rust structs in src-tauri/src/match_runner.rs. The backend exposes
// the `play_batch` / `cancel_batch` Tauri commands; this module builds the
// `GameSpec[]` payload, keeps the id -> eval side-table the Rust side does not
// carry, and aggregates outcomes into an eval -> conversion probability map.

import type { PersonaDecision } from "./persona-types"

// ---------------------------------------------------------------------------
// Participant wire shape (spec 218 "The Participant") — camelCase, matches
// src-tauri/src/match_runner.rs's `Participant`/`PersonaConfig`
// (`#[serde(rename_all = "camelCase")]`) verbatim; locked by a Rust unit test
// (`participant_wire_shape_matches_spec_218`, match_runner.rs). This is a
// DIFFERENT shape from lib/roster.ts's `Participant`/`PersonaConfig` — those
// are the UI-facing roster (displayName/avatar/strengthLabel/actions) consumed
// by Play vs Bot; this is the engine-runnable payload the tournament/
// exhibition runner actually deserializes. lib/tournament-roster.ts bridges
// the two (and reuses lib/roster.ts's rival-gating logic rather than
// reimplementing it) to build the dropdown this file's spec-builders consume.
// ---------------------------------------------------------------------------

export type ParticipantKind = "uci" | "persona"

/** A persona participant's move-selection config (spec 214 Tier 2). `level`
 *  is the Maia band policy backend AND the decision-log strength label;
 *  `weights` overrides the policy backend with a named managed net (e.g.
 *  "bt3" for a GM-strength persona) — when set, `level` no longer selects a
 *  Maia net file, it is purely the label. A GM persona (level > 1900) MUST
 *  set `weights`, or the runner's weight resolution errors (no Maia-1 net
 *  above 1900) — never send a GM persona level-only. */
export interface PersonaConfig {
  level: number
  temperature: number
  alpha: number
  lambda: number
  topK?: number
  topP?: number
  verifyDepth?: number
  /** Named managed net (e.g. "bt3"), overriding the Maia band policy backend. */
  weights?: string
  /** Per-persona base seed; mixed with the game id server-side (spec 214
   *  contract step 8) so every game in a batch is distinct yet reproducible. */
  seed?: number
}

/** The runtime object a surface spawns to field an opponent (spec 218). */
export interface Participant {
  id: string
  displayName: string
  kind: ParticipantKind
  /** kind: "uci" only. */
  enginePath?: string
  /** kind: "persona" only. */
  personaConfig?: PersonaConfig
}

/** A per-game seed below 2^53 so it survives the JSON number round-trip to
 *  Rust intact (same constraint as spar-tab.tsx's newGameSeed — kept as a
 *  separate one-liner here since that component is out of this file's
 *  scope). One fresh seed per participant per Run, not per game: the runner
 *  derives each game's actual seed from this base + the game id. */
export function newPersonaSeed(): number {
  return Math.floor(Math.random() * 2 ** 53)
}

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
  /**
   * Optional Participant for White/Black (spec 218). When present it
   * supersedes `white_path`/`black_path` server-side — the command layer
   * normalizes a UCI participant's `enginePath` into the legacy path field
   * and resolves a persona participant into a runnable engine. Additive:
   * absent = the legacy path-only behavior every existing caller still uses.
   */
  white?: Participant
  black?: Participant
}

/** A completed (or adjudicated) game. Mirrors Rust `GameResult`. */
export type GameResult = {
  result: "1-0" | "0-1" | "1/2-1/2"
  termination: string
  plies: number
  start_fen: string
  moves: string[]
  /**
   * Both sides' remaining clocks `[white_ms, black_ms]` AFTER each move —
   * `clocks_ms[i]` pairs with `moves[i]` (spec 212 tier-1 clock persistence;
   * the same values MoveEvent streams live). Additive: the Rust side omits
   * the key when empty (`skip_serializing_if`, like persona_logs), so it is
   * optional here and absent on pre-212 payloads.
   */
  clocks_ms?: [number, number][]
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
  /**
   * The evaluator's best move (first PV move, UCI) in this position, when its
   * info stream reported one (spec 212 best-move gap). Additive/optional: the
   * Rust side omits the key when absent.
   */
  best?: string | null
}

/** A neutral-evaluator score streamed live as a game plays. Mirrors Rust `EvalEvent`. */
export type EvalEvent = {
  game_id: number
  ply: number
  cp: number | null
  mate: number | null
  /** The evaluator's best move (first PV move, UCI), when reported. */
  best?: string | null
}

/**
 * One persona participant's per-move decision log entry (spec 214 contract
 * step 9), attached to a `GameOutcome`. Mirrors Rust `PersonaLogEntry`
 * (snake_case — no `rename_all` on that struct, unlike `Participant`). Reuses
 * `PersonaDecision`/`PersonaCandidate` from lib/persona.ts rather than
 * redefining them: those already mirror the exact Rust `persona.rs` shapes
 * the spar tab's `persona_move` command returns, and the match runner's
 * persona arm shares that same decision core (spec 218 "Persona arm in the
 * runner"), so the JSON shape is identical between the two call sites.
 */
export type PersonaLogEntry = {
  /** 1-based half-move index. */
  ply: number
  color: "white" | "black"
  decision: PersonaDecision
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
  /**
   * Per-move persona decision logs (spec 214 contract step 9). Additive:
   * absent/empty for pure-UCI games — `#[serde(skip_serializing_if =
   * "Vec::is_empty")]` on the Rust side omits the key entirely rather than
   * sending `[]`, so this is optional here too.
   */
  persona_logs?: PersonaLogEntry[]
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
  /**
   * The featured game's start FEN (null = standard start), paired with
   * `uciMoves` so the shared live viewer (`app/page.tsx`'s `LiveGameView`) can
   * build a numbered SAN move list via `lib/game-replay.ts`'s
   * `sansFromUci`/`numberMoves` — the same fix already shipped for the
   * exhibition viewer (spec 218 "Move numbers" follow-up).
   */
  startFen?: string | null
  /**
   * UCI moves played so far in the featured game, ply-indexed (uciMoves[0] is
   * ply 1) — same source as `MoveEvent.uci`. Like `frames`, only covers moves
   * played SINCE this game became featured (switching mid-game starts fresh).
   */
  uciMoves?: string[]
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

/** Result of parsing a user-picked EPD/FEN opening-positions file
 *  (spec 210 Phase 3: "loaded from disk via file picker"). */
export type ParsedPositionsFile = {
  positions: TaggedPosition[]
  /** How many positions carried an eval tag (EPD `ce` opcode). */
  tagged: number
  /** Non-empty, non-comment lines that didn't parse as a position. */
  skipped: number
}

// A position line's first four fields: board (8 ranks), side to move,
// castling (letters allowed a-h for X-FEN/Chess960 files), en passant.
const BOARD_FIELD_RE = /^[pnbrqkPNBRQK1-8]+(?:\/[pnbrqkPNBRQK1-8]+){7}$/
const CASTLING_FIELD_RE = /^(-|[KQkqA-Ha-h]+)$/
const EP_FIELD_RE = /^(-|[a-h][36])$/

/**
 * Parse a UHO-style opening-positions file: one EPD record or full FEN per
 * line. Bare 4-field EPD gets " 0 1" counters appended so the result is
 * always a runnable FEN. An EPD `ce` opcode (centipawns, side-to-move POV
 * per the EPD standard) becomes the position's eval, flipped to White POV to
 * match data/tagged_positions.json; untagged lines get eval 0 (fine for Book
 * mode's balance filter, degenerate for Eval mode's buckets — the UI warns).
 * Unparseable lines are counted, never fatal: one bad line must not hide the
 * rest of the book. `source` labels every position (the seed/family
 * breakdown shows it), typically the file's base name.
 */
export function parseOpeningPositions(text: string, source: string): ParsedPositionsFile {
  const positions: TaggedPosition[] = []
  let tagged = 0
  let skipped = 0
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#") || line.startsWith("//") || line.startsWith(";")) continue
    const fields = line.split(/\s+/)
    if (
      fields.length < 4 ||
      !BOARD_FIELD_RE.test(fields[0]) ||
      (fields[1] !== "w" && fields[1] !== "b") ||
      !CASTLING_FIELD_RE.test(fields[2]) ||
      !EP_FIELD_RE.test(fields[3])
    ) {
      skipped++
      continue
    }
    // Fields 5+6 both numeric = a full FEN (halfmove + fullmove counters);
    // anything else is bare EPD with opcodes starting at field 5.
    const isFullFen = fields.length >= 6 && /^\d+$/.test(fields[4]) && /^\d+$/.test(fields[5])
    const fen = isFullFen ? fields.slice(0, 6).join(" ") : `${fields.slice(0, 4).join(" ")} 0 1`
    const ops = fields.slice(isFullFen ? 6 : 4).join(" ")
    let evalCp = 0
    const ce = /(?:^|;)\s*ce\s+(-?\d+)/.exec(ops)
    if (ce) {
      const stmCp = Number(ce[1])
      evalCp = fields[1] === "b" ? -stmCp : stmCp
      tagged++
    }
    positions.push({ fen, eval_cp: evalCp, eval_pawns: evalCp / 100, source })
  }
  return { positions, tagged, skipped }
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

/** A UCI participant's `white_path`/`black_path` fallback value; a persona
 *  participant leaves the legacy path field empty — the runner resolves it
 *  server-side from `white`/`black` before any path is read (spec 218
 *  `resolve_participants` runs before `check_engine_paths`). */
function legacyPath(p: Participant): string {
  return p.kind === "uci" ? (p.enginePath ?? "") : ""
}

/**
 * Participant-aware sibling of `buildSpecs` (spec 218 "Exhibition &
 * tournament" checklist item 1): identical color-flip pairing, but each side
 * is a full `Participant` (engine OR persona) rather than a bare binary path.
 * `white_path`/`black_path` are still populated (best-effort, empty for a
 * persona side) purely for callers that only look at the legacy fields; the
 * runner itself always prefers `white`/`black` when present.
 */
export function buildParticipantSpecs(
  seeds: Seed[],
  participantA: Participant,
  participantB: Participant,
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
      const white = flipped ? participantB : participantA
      const black = flipped ? participantA : participantB
      const spec: GameSpec = {
        id: id++,
        white_path: legacyPath(white),
        black_path: legacyPath(black),
        start_fen: seed.fen,
        base_ms: baseMs,
        inc_ms: incMs,
        max_plies: maxPlies,
        flipped,
        adjudicate_tb: adjudicateTb,
        white,
        black,
      }
      evalById.set(spec.id, { eval: seed.eval })
      specs.push(spec)
    }
  }
  return { specs, evalById }
}

/**
 * A single (unflipped) game spec — the exhibition entry point's "batch of 1"
 * (spec 218 "Exhibition framing" checklist item): one featured game through
 * the SAME runner as a full batch, no color-flip pairing (that's what makes
 * it 1 game, not 2). `id` is always 0.
 */
export function buildExhibitionSpec(
  seed: Seed,
  white: Participant,
  black: Participant,
  baseMs: number,
  incMs: number,
  maxPlies: number,
  adjudicateTb: boolean,
): { spec: GameSpec; evalById: EvalMap } {
  const spec: GameSpec = {
    id: 0,
    white_path: legacyPath(white),
    black_path: legacyPath(black),
    start_fen: seed.fen,
    base_ms: baseMs,
    inc_ms: incMs,
    max_plies: maxPlies,
    flipped: false,
    adjudicate_tb: adjudicateTb,
    white,
    black,
  }
  return { spec, evalById: new Map([[0, { eval: seed.eval }]]) }
}

// ---------------------------------------------------------------------------
// Probability-map aggregation
// ---------------------------------------------------------------------------

/**
 * Classical Elo/eval-naive win-probability slope (per pawn), used ONLY as the
 * "expected" reference line for `conversionDelta` below — how a naive
 * Elo-equivalent prediction would convert a starting eval into a result,
 * independent of what this run's own engines actually did. Duplicated (not
 * imported) from `lib/win-prob.ts`'s `DEFAULT_LOGISTIC_K`: that module already
 * imports `ProbBin`/`GameOutcome` from this file for its OWN (data-derived,
 * per-run) win-prob curve, so importing back here would cycle. Same value
 * (0.4/pawn), which in turn mirrors the 0.004/cp squash `lib/annotations.ts`
 * uses for the eval graph — one consistent pawn<->win% shape across the app.
 */
export const CLASSICAL_LOGISTIC_K = 0.4

/**
 * Classical Elo-equivalent expected score (0..1) for the side holding a
 * White-POV eval of `pawns`, via the standard logistic pawns<->win%
 * conversion. This is the naive "what would the eval alone predict" baseline
 * spec 210's `conversion_delta` (`win_pct - expected_win_pct`) is measured
 * against — deliberately NOT fit to this run's own results, so a positive
 * delta means "this pairing converts advantage better than eval alone would
 * suggest" and a negative delta means worse.
 */
export function expectedWinPct(pawns: number, k = CLASSICAL_LOGISTIC_K): number {
  return 1 / (1 + Math.exp(-k * pawns))
}

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
  /** Classical Elo-naive expected score at this bin's center eval (see
   *  `expectedWinPct`) — the reference line `conversionDelta` is measured
   *  against. */
  expectedWhiteScore: number
  /** `avgWhiteScore - expectedWhiteScore` — how much this run over/under-
   *  performed the eval-naive prediction (spec 210 `conversion_delta`). */
  conversionDelta: number
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
    const center = binLo + binWidth / 2
    const avgWhiteScore = acc.scoreSum / acc.count
    const expectedWhiteScore = expectedWinPct(center)
    bins.push({
      lo: binLo,
      hi: binHi,
      center,
      count: acc.count,
      whiteWins: acc.w,
      draws: acc.d,
      blackWins: acc.b,
      avgWhiteScore,
      expectedWhiteScore,
      conversionDelta: avgWhiteScore - expectedWhiteScore,
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
    const center = binLo + binWidth / 2
    const avgWhiteScore = acc.scoreSum / acc.count
    const expectedWhiteScore = expectedWinPct(center)
    bins.push({
      lo: binLo,
      hi: binLo + binWidth,
      center,
      count: acc.count,
      whiteWins: acc.w,
      draws: acc.d,
      blackWins: acc.b,
      avgWhiteScore,
      expectedWhiteScore,
      conversionDelta: avgWhiteScore - expectedWhiteScore,
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

// ---------------------------------------------------------------------------
// JSON export of a completed run (spec 210 Phase 5 checklist item)
// ---------------------------------------------------------------------------

/** One bucket row of an exported result, matching spec 210's `EvalBucket`
 *  (`specs/210-engine-tournament.md:78-86`) field-for-field except
 *  `rangeMin`/`rangeMax` come straight off the bin's `lo`/`hi` (no re-parsing
 *  a "+1.25..+1.50" string) and the pct fields are 0..100, not 0..1. */
export type ExportedEvalBucket = {
  rangeMin: number
  rangeMax: number
  games: number
  winPct: number
  drawPct: number
  lossPct: number
  conversionDelta: number
}

/** A completed run, shaped for JSON export — matches spec 210's
 *  `TournamentResult` (`specs/210-engine-tournament.md:88-96`) except
 *  `startMode` uses this codebase's shipped `StartMode` union ("eval", not
 *  "eval-qualified"; plus "current", not in the original spec) rather than
 *  the spec's exact three-value union — see the Phase 3 tick-pass note on
 *  `StartMode`. */
export type ExportedTournamentResult = {
  engineA: string
  engineB: string
  totalGames: number
  startMode: StartMode
  evalRange: [number, number]
  buckets: ExportedEvalBucket[]
  completedAt: string
}

/**
 * Build the exportable shape of a completed `TournamentResult` from the
 * primary probability map (the advantaged-side, both-engines-pooled bins
 * rendered as the main chart) plus the run's config/labels. Pure — the caller
 * (`tournament-tab.tsx`'s Export button) hands the result to a Blob download,
 * same pattern `app/page.tsx`'s PGN export already uses.
 */
export function buildTournamentResultExport(
  labelA: string,
  labelB: string,
  totalGames: number,
  startMode: StartMode,
  evalRange: [number, number],
  bins: ProbBin[],
  completedAt: string = new Date().toISOString(),
): ExportedTournamentResult {
  return {
    engineA: labelA,
    engineB: labelB,
    totalGames,
    startMode,
    evalRange,
    buckets: bins.map((b) => ({
      rangeMin: b.lo,
      rangeMax: b.hi,
      games: b.count,
      winPct: b.count ? (b.whiteWins / b.count) * 100 : 0,
      drawPct: b.count ? (b.draws / b.count) * 100 : 0,
      lossPct: b.count ? (b.blackWins / b.count) * 100 : 0,
      conversionDelta: b.conversionDelta * 100,
    })),
    completedAt,
  }
}

// ---------------------------------------------------------------------------
// Round-robin tournament (spec 210 Phase 6)
// ---------------------------------------------------------------------------
//
// N participants (engines OR personas — the spec-218 dropdown roster), each
// unordered pair plays M games with color flip. The pairing logic lives here
// (like buildSpecs does) and emits ONE flat GameSpec[] batch — the existing
// runner's batch machinery + concurrency cap schedules it; nothing round-robin-
// specific exists on the Rust side.

/** Which round-robin pairing a game id belongs to: indices into the
 *  participants array. `a` is the pairing's FIRST participant; a spec's
 *  `flipped` means "participant `a` is Black" (mirrors buildSpecs' "engine A
 *  is Black" convention, per pairing). */
export type RoundRobinPairing = { a: number; b: number }

export type RoundRobinBatch = {
  specs: GameSpec[]
  evalById: EvalMap
  /** game id -> its pairing, for cross-table scoring. */
  pairingById: Map<number, RoundRobinPairing>
}

/**
 * Schedule a full round-robin: every unordered pair (i<j) of `participants`
 * plays `gamesPerPairing` games, colors alternating within the pairing
 * (game 1: i White, game 2: j White, ...). Seeds are drawn sequentially from
 * `seeds` (cycled if the pool is short — same reuse rule as buildSeeds); each
 * seed covers one color-flipped pair of games, so an odd `gamesPerPairing`
 * leaves its last seed half-used (participant i gets the extra White).
 * ids are assigned sequentially across the whole flat batch.
 */
export function buildRoundRobinSpecs(
  participants: Participant[],
  gamesPerPairing: number,
  seeds: Seed[],
  baseMs: number,
  incMs: number,
  maxPlies: number,
  adjudicateTb: boolean,
): RoundRobinBatch {
  const specs: GameSpec[] = []
  const evalById: EvalMap = new Map()
  const pairingById = new Map<number, RoundRobinPairing>()
  if (participants.length < 2 || gamesPerPairing <= 0) {
    return { specs, evalById, pairingById }
  }
  let id = 0
  let seedCursor = 0
  const nextSeed = (): Seed =>
    seeds.length > 0 ? seeds[seedCursor++ % seeds.length] : { fen: null, eval: 0 }

  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      for (let g = 0; g < gamesPerPairing; g += 2) {
        const seed = nextSeed()
        const gamesFromSeed = Math.min(2, gamesPerPairing - g)
        for (let k = 0; k < gamesFromSeed; k++) {
          const flipped = k === 1 // second game of the seed: i plays Black
          const white = flipped ? participants[j] : participants[i]
          const black = flipped ? participants[i] : participants[j]
          const spec: GameSpec = {
            id,
            white_path: white.kind === "uci" ? (white.enginePath ?? "") : "",
            black_path: black.kind === "uci" ? (black.enginePath ?? "") : "",
            start_fen: seed.fen,
            base_ms: baseMs,
            inc_ms: incMs,
            max_plies: maxPlies,
            flipped,
            adjudicate_tb: adjudicateTb,
            white,
            black,
          }
          evalById.set(id, { eval: seed.eval })
          pairingById.set(id, { a: i, b: j })
          specs.push(spec)
          id++
        }
      }
    }
  }
  return { specs, evalById, pairingById }
}

/** Total games a full round-robin schedules. */
export function roundRobinGameCount(nParticipants: number, gamesPerPairing: number): number {
  if (nParticipants < 2 || gamesPerPairing <= 0) return 0
  return ((nParticipants * (nParticipants - 1)) / 2) * gamesPerPairing
}

/** One directed cross-table cell: participant i's record against j. */
export type PairCell = {
  wins: number
  draws: number
  losses: number
  games: number
  /** wins + draws/2 */
  points: number
}

/** Full cross-table: `cells[i][j]` is i's record vs j (null on the diagonal).
 *  Symmetric by construction: cells[j][i] mirrors wins/losses. */
export type CrossTable = {
  n: number
  cells: (PairCell | null)[][]
}

function emptyCell(): PairCell {
  return { wins: 0, draws: 0, losses: 0, games: 0, points: 0 }
}

/**
 * Aggregate completed outcomes into the cross-table. Err games and aborted
 * games are excluded (consistent with every other stat in this module);
 * `flipped` means the pairing's first participant played Black.
 */
export function buildCrossTable(
  nParticipants: number,
  outcomes: GameOutcome[],
  pairingById: Map<number, RoundRobinPairing>,
): CrossTable {
  const cells: (PairCell | null)[][] = Array.from({ length: nParticipants }, (_, i) =>
    Array.from({ length: nParticipants }, (_, j) => (i === j ? null : emptyCell())),
  )
  for (const o of outcomes) {
    if (o.aborted) continue
    const g = gameResult(o)
    if (!g) continue
    const pairing = pairingById.get(o.id)
    if (!pairing) continue
    const { a, b } = pairing
    const ca = cells[a]?.[b]
    const cb = cells[b]?.[a]
    if (!ca || !cb) continue
    ca.games++
    cb.games++
    if (g.result === "1/2-1/2") {
      ca.draws++
      cb.draws++
    } else {
      // a is White unless flipped.
      const aWon = (g.result === "1-0") === !o.flipped
      if (aWon) {
        ca.wins++
        cb.losses++
      } else {
        ca.losses++
        cb.wins++
      }
    }
    ca.points = ca.wins + ca.draws / 2
    cb.points = cb.wins + cb.draws / 2
  }
  return { n: nParticipants, cells }
}

/** One standings row (totals across all of a participant's pairings). */
export type StandingRow = {
  idx: number
  games: number
  wins: number
  draws: number
  losses: number
  points: number
}

/** Standings from the cross-table, sorted by points desc, then wins desc,
 *  then index asc (stable for ties). */
export function buildStandings(table: CrossTable): StandingRow[] {
  const rows: StandingRow[] = []
  for (let i = 0; i < table.n; i++) {
    const row: StandingRow = { idx: i, games: 0, wins: 0, draws: 0, losses: 0, points: 0 }
    for (let j = 0; j < table.n; j++) {
      const c = table.cells[i][j]
      if (!c) continue
      row.games += c.games
      row.wins += c.wins
      row.draws += c.draws
      row.losses += c.losses
    }
    row.points = row.wins + row.draws / 2
    rows.push(row)
  }
  rows.sort((a, b) => b.points - a.points || b.wins - a.wins || a.idx - b.idx)
  return rows
}

/** One participant's Elo estimate relative to the anchor. */
export type EloEstimate = {
  idx: number
  /** Rating relative to the anchor participant (anchor = 0 by definition). */
  elo: number
  /** Approximate standard error (Elo). Infinity when the participant has no
   *  scored games; 0 for the anchor (fixed by definition). Ignores rating
   *  covariance, so it slightly understates joint uncertainty — labelled
   *  "approximate" wherever shown. */
  se: number
  /** Real games underlying the estimate (prior games not counted). */
  games: number
  anchored: boolean
}

/**
 * Maximum-likelihood Elo estimates over a cross-table, anchored to one named
 * participant (its rating is 0 by definition; every other rating is relative).
 *
 * Model: Bradley–Terry, which IS the Elo logistic — participant i beats j with
 * probability g_i/(g_i+g_j) where g = 10^(R/400). Draws count as half a win
 * for each side (the classical Elostat treatment; no separate draw parameter).
 * Fitted with the standard MM (minorization–maximization) iteration, which is
 * guaranteed to converge for this likelihood:
 *
 *     g_i <- W_i / sum_j n_ij / (g_i + g_j)
 *
 * where W_i is i's total points and n_ij the games between i and j.
 *
 * A BayesElo-style prior of `priorDraws` virtual draws is added to EVERY
 * pairing (default 1): it keeps a 100%-sweep finite and the player graph
 * connected, at the cost of shrinking extreme results slightly toward 0 —
 * set priorDraws: 0 for the raw MLE. Standard errors come from the Fisher
 * information of the REAL games only (evaluated at the fitted ratings), so
 * the ± honestly reflects the actual sample size.
 */
export function estimateElo(
  table: CrossTable,
  anchorIdx = 0,
  opts: { priorDraws?: number; maxIter?: number } = {},
): EloEstimate[] {
  const n = table.n
  const priorDraws = opts.priorDraws ?? 1
  const maxIter = opts.maxIter ?? 500
  if (n === 0) return []

  // Symmetric game counts and per-participant points, prior folded in.
  const games = (i: number, j: number) =>
    (table.cells[i][j]?.games ?? 0) + (i !== j ? priorDraws : 0)
  const points = (i: number, j: number) =>
    (table.cells[i][j]?.points ?? 0) + (i !== j ? priorDraws / 2 : 0)

  let gamma = Array.from({ length: n }, () => 1)
  for (let iter = 0; iter < maxIter; iter++) {
    const next = gamma.slice()
    let maxDelta = 0
    for (let i = 0; i < n; i++) {
      let w = 0
      let denom = 0
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        w += points(i, j)
        denom += games(i, j) / (gamma[i] + gamma[j])
      }
      if (denom > 0) {
        // Clamp so a 100% sweep with priorDraws:0 stays finite (±2400 Elo).
        next[i] = Math.min(1e6, Math.max(1e-6, w / denom))
      }
      maxDelta = Math.max(maxDelta, Math.abs(Math.log(next[i]) - Math.log(gamma[i])))
    }
    // Renormalize (geometric mean 1) so the free overall scale can't drift.
    const meanLog = next.reduce((s, g) => s + Math.log(g), 0) / n
    gamma = next.map((g) => g / Math.exp(meanLog))
    if (maxDelta < 1e-12) break
  }

  const toElo = (g: number) => (400 / Math.LN10) * Math.log(g)
  const anchorElo = toElo(gamma[Math.min(anchorIdx, n - 1)])
  const k = Math.LN10 / 400 // dP/dR slope factor of the Elo logistic

  return gamma.map((g, i) => {
    let info = 0
    let realGames = 0
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const nij = table.cells[i][j]?.games ?? 0
      if (nij === 0) continue
      realGames += nij
      const e = g / (g + gamma[j])
      info += k * k * nij * e * (1 - e)
    }
    const anchored = i === anchorIdx
    return {
      idx: i,
      elo: toElo(g) - anchorElo,
      se: anchored ? 0 : info > 0 ? 1 / Math.sqrt(info) : Infinity,
      games: realGames,
      anchored,
    }
  })
}

// ---------------------------------------------------------------------------
// Round-robin result persistence (spec 210 Phase 6 checklist item)
// ---------------------------------------------------------------------------

/** One participant as recorded in a saved result: stable id + the honest
 *  roster label ("engine: stockfish 18", "bot: kasparov (BT3, 64%
 *  move-match)") — persona entries keep their spec-216/218 strength labels
 *  in saved standings, same as live. */
export type SavedParticipant = { id: string; label: string }

/** One saved Elo row (fitted at save time; recomputable from crossTable). */
export type SavedEloRow = {
  id: string
  label: string
  elo: number
  /** Approximate ± (see EloEstimate.se); null when it was Infinity (no games)
   *  — JSON has no Infinity. */
  se: number | null
  games: number
  anchored: boolean
}

/**
 * A completed round-robin, shaped for JSON persistence. Follows the
 * spec-210-Phase-5 export conventions from `buildTournamentResultExport`
 * (camelCase fields, ISO `completedAt`), with `version`/`kind` so the
 * saved-results list can grow other shapes later without guessing.
 */
export type RoundRobinResultExport = {
  version: 1
  kind: "round-robin"
  name: string
  completedAt: string
  gamesPerPairing: number
  /** Games actually counted (completed, non-aborted). */
  totalGames: number
  timeControl: { baseMs: number; incMs: number }
  participants: SavedParticipant[]
  /** cells[i][j] = participants[i]'s record vs participants[j]. */
  crossTable: (PairCell | null)[][]
  elo: SavedEloRow[]
}

/** Shape a completed round-robin for persistence. Pure — the tab hands the
 *  result to the `save_tournament_result` Tauri command. */
export function buildRoundRobinExport(
  name: string,
  participants: SavedParticipant[],
  gamesPerPairing: number,
  timeControl: { baseMs: number; incMs: number },
  table: CrossTable,
  estimates: EloEstimate[],
  completedAt: string = new Date().toISOString(),
): RoundRobinResultExport {
  const totalGames = buildStandings(table).reduce((s, r) => s + r.games, 0) / 2
  return {
    version: 1,
    kind: "round-robin",
    name,
    completedAt,
    gamesPerPairing,
    totalGames,
    timeControl,
    participants,
    crossTable: table.cells,
    elo: estimates.map((e) => ({
      id: participants[e.idx]?.id ?? String(e.idx),
      label: participants[e.idx]?.label ?? `#${e.idx}`,
      elo: e.elo,
      se: Number.isFinite(e.se) ? e.se : null,
      games: e.games,
      anchored: e.anchored,
    })),
  }
}

/** Metadata row for one saved result file. Mirrors Rust `SavedTournamentMeta`
 *  (snake_case, no rename — matches the module's other event structs). */
export type SavedTournamentMeta = {
  file: string
  name: string
  completed_at: string
  total_games: number
  kind: string
}

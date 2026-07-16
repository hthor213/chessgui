// Beat-X training program generator (spec 225 Part 2).
//
// Given a target player's profile artifacts (the spec 225 Part-1 pipeline's
// <slug>.profile.json + <slug>.stats.json, plus the opening book when it's
// available), generate a spec 215 `Program` aimed at beating that player and
// a TRAINING_PLAN-style markdown doc (the data/rivals/TRAINING_PLAN.md
// precedent) to hand to whoever is doing the training:
//
//   - Anti-book lines (anti_line_drill): prepared lines that exit X's book
//     by ~move 6 — derived from X's most-played lines in the stats dossier
//     and the measured depth of X's book.
//   - Rake decks (rake_deck, spec 211): pointed at X's favorite opening
//     families/structures from the dossier.
//   - Conversion training (endgame_playout + phase drills): weighted toward
//     the phases X statistically wins and loses — attack where he leaks,
//     shore up where he grinds.
//   - Spar sessions (spar_rival): vs X's persona when one exists; when the
//     profile is dossier-only the program SAYS SO and substitutes
//     level-matched Maia with X's book lines (spec 225's honest fallback).
//
// Everything here is pure and dependency-free at runtime (all imports are
// type-only), so the same module runs inside the app AND under plain `node`
// (scripts/persona/generate_beat_plan.mjs) to emit <slug>.BEAT.md.
//
// Hard rules: the generated text names the target — that's fine, it only
// ever lives in gitignored data/rivals or runtime memory, never in committed
// code (spec 214/225). Nothing in here assumes the arena exists (spec 225:
// v1 is the LOCAL app).

import type {
  Chapter,
  DayBlock,
  ExerciseType,
  Program,
} from "@/lib/training-program"
import type {
  LocalPlayerProfile,
  OpeningFamilyRow,
  PhaseRow,
  PlayerProfileFile,
  PlayerStatsFile,
} from "@chessgui/core/player-profile-types"
import type { RivalBook } from "@chessgui/core/rival-book-types"

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface BeatTarget {
  profile: PlayerProfileFile
  stats: PlayerStatsFile | null
  /** Whether a persona config for this player actually LOADED (fields a
   *  bot) — the artifact-existence rule, not the profile's own claim. */
  hasPersona: boolean
  /** The honesty-gated Maia level that persona plays at, when hasPersona. */
  personaLevel?: number
  /** The player's opening book, when available — measures his book depth. */
  book?: RivalBook | null
}

export interface BeatPlan {
  program: Program
  markdown: string
}

/** Program id for a target slug — the picker key next to "road-to-1900". */
export function beatProgramId(slug: string): string {
  return `beat-${slug}`
}

// ---------------------------------------------------------------------------
// Derivations from the dossier
// ---------------------------------------------------------------------------

/** Published Maia bands (src-tauri/src/maia.rs BANDS). Local copy so this
 *  module stays runtime-dependency-free (node-runnable). */
const MAIA_MIN = 1100
const MAIA_MAX = 1900

/** Level-match a rating to the nearest published Maia band. `capped` means
 *  the target is outside the published set — the label must say so (spec
 *  216/214: no unmeasured realism claims). */
export function maiaBandForRating(rating: number | null | undefined): {
  level: number
  capped: boolean
} {
  if (rating == null || !Number.isFinite(rating)) return { level: 1500, capped: false }
  const nearest = Math.round(rating / 100) * 100
  if (nearest < MAIA_MIN) return { level: MAIA_MIN, capped: true }
  if (nearest > MAIA_MAX) return { level: MAIA_MAX, capped: true }
  return { level: nearest, capped: false }
}

/** The move by which prepared lines should have left X's book: one full move
 *  past his measured book depth, clamped to the spec's ~move-6 calibration
 *  range. Without a book artifact, the default is move 6 (the dad precedent:
 *  his book depth was ~3 plies). */
export function bookExitMove(book: RivalBook | null | undefined): number {
  if (!book || !Number.isFinite(book.max_ply)) return 6
  const depthMoves = Math.ceil(book.max_ply / 2)
  return Math.min(8, Math.max(4, depthMoves + 1))
}

interface PhaseRead {
  /** The phase X scores worst in (his leak — attack here), when measurable. */
  leak: { phase: string; row: PhaseRow; score: number } | null
  /** The phase X scores best in (his grind — shore up here), when measurable. */
  grind: { phase: string; row: PhaseRow; score: number } | null
}

function phaseScore(r: PhaseRow): number {
  return r.games > 0 ? (r.wins + 0.5 * r.draws) / r.games : 0
}

/** Read X's phase win/loss profile. Phases with fewer than 3 games are
 *  ignored — too small to call a leak. */
export function readPhaseProfile(stats: PlayerStatsFile | null): PhaseRead {
  const ended = stats?.phase_profile?.ended_in
  if (!ended) return { leak: null, grind: null }
  const rows = (Object.entries(ended) as [string, PhaseRow | undefined][])
    .filter((e): e is [string, PhaseRow] => !!e[1] && e[1].games >= 3)
    .map(([phase, row]) => ({ phase, row, score: phaseScore(row) }))
  if (rows.length === 0) return { leak: null, grind: null }
  const byScore = [...rows].sort((a, b) => a.score - b.score)
  const leak = byScore[0]
  const grind = byScore[byScore.length - 1]
  return { leak, grind: grind !== leak ? grind : null }
}

function topFamilies(rows: OpeningFamilyRow[] | undefined, n: number): OpeningFamilyRow[] {
  return [...(rows ?? [])].sort((a, b) => b.games - a.games).slice(0, n)
}

function topLines(
  rows: { line: string; games: number }[] | undefined,
  n: number,
): { line: string; games: number }[] {
  return [...(rows ?? [])].sort((a, b) => b.games - a.games).slice(0, n)
}

function familyNames(rows: OpeningFamilyRow[]): string {
  return rows.map((r) => r.family).join(", ")
}

const PHASE_LABELS: Record<string, string> = {
  opening: "the opening",
  middlegame: "the middlegame",
  endgame: "the endgame",
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

// ---------------------------------------------------------------------------
// The program
// ---------------------------------------------------------------------------

function block(
  id: string,
  day: number,
  type: ExerciseType,
  title: string,
  detail: string,
  minutes?: number,
): DayBlock {
  return { id, day, type, title, detail, minutes }
}

/** Build the spec 215 Program + the markdown plan for a target profile. */
export function buildBeatPlan(t: BeatTarget, generatedAt: Date = new Date()): BeatPlan {
  const name = t.profile.display_name
  const slug = t.profile.slug
  const sample = t.profile.sample
  const stats = t.stats
  const exitMove = bookExitMove(t.book)
  const phases = readPhaseProfile(stats)
  const band = maiaBandForRating(t.profile.rating?.value ?? null)

  const whiteFams = topFamilies(stats?.opening_families?.as_white, 2)
  const blackFams = topFamilies(stats?.opening_families?.as_black, 2)
  const whiteLines = topLines(stats?.top_lines?.as_white, 3)
  const blackLines = topLines(stats?.top_lines?.as_black, 3)

  const antiWhiteDetail =
    whiteLines.length > 0
      ? `As White he plays ${whiteFams.length ? familyNames(whiteFams) : "the lines below"} — most often ${whiteLines[0].line}. Prepare a Black reply that leaves his book by move ${exitMove}, and drill it until automatic.`
      : `No recorded White lines in the dossier — prepare one solid Black setup and drill leaving known theory by move ${exitMove}.`
  const antiBlackDetail =
    blackLines.length > 0
      ? `As Black he answers with ${blackFams.length ? familyNames(blackFams) : "the lines below"} — most often ${blackLines[0].line}. Pick a White move-order that sidesteps it by move ${exitMove}, and drill it until automatic.`
      : `No recorded Black lines in the dossier — pick one White system and drill an early deviation (by move ${exitMove}) from mainline theory.`

  const rakeDetail = `An Avoidance deck, then one rapid game steering toward his structures (${
    whiteFams.length || blackFams.length
      ? familyNames([...whiteFams, ...blackFams].slice(0, 3))
      : "the structures in his dossier"
  }). Don't step on the rake in HIS positions.`

  // Conversion weighting (spec 225): attack where he leaks, shore up where
  // he grinds — both phrased from the measured phase profile.
  const leakText = phases.leak
    ? `He scores ${pct(phases.leak.score)} in games ending in ${PHASE_LABELS[phases.leak.phase] ?? phases.leak.phase} (${phases.leak.row.wins}W/${phases.leak.row.draws}D/${phases.leak.row.losses}L) — steer games there and convert.`
    : "His phase profile is too thin to name a leak — train conversion broadly."
  const grindText = phases.grind
    ? `He scores ${pct(phases.grind.score)} when games end in ${PHASE_LABELS[phases.grind.phase] ?? phases.grind.phase} — don't drift into his strength unprepared.`
    : ""
  const conversionDetail = `Convert a winning position (+1.5 to +3) against the engine; replay any failure. ${leakText}`

  // Spar sessions: persona when one exists, otherwise the honest dossier-only
  // fallback (spec 225: "the program says so and substitutes level-matched
  // Maia with X's book if available").
  const sparDetail = t.hasPersona
    ? `Spar vs ${name}'s persona (his real openings, ~${t.personaLevel ?? band.level} Maia policy) with the clock on.`
    : `${name}'s profile is dossier-only — it fields no bot. Substitute: play Bot ${band.level}${
        band.capped ? ` (the top published Maia band — he averages ~${t.profile.rating?.value}, stronger than any published human-move model)` : ""
      } in Play vs Bot and steer the opening into his lines from the anti-book prep${
        t.book ? " (his book artifact exists and feeds this plan's lines)" : ""
      }.`

  const p = (s: string) => `beat-${slug}-${s}`

  const ch1: Chapter = {
    id: p("ch1-book-exit"),
    title: "Exit His Book",
    weekStart: 1,
    weekEnd: 4,
    objectives: [
      `Own two prepared lines — one per color — that leave ${name}'s book by move ${exitMove}.`,
      "Know his structures well enough to see the rakes coming.",
      "Calibrate: no invented advantages in positions he keeps level.",
    ],
    week: [
      block(p("c1-sun"), 0, "rest", "Rest", "Rest, or casual unrated only. Never play rated tired."),
      block(p("c1-mon"), 1, "anti_line_drill", "Anti-book: his White", antiWhiteDetail, 40),
      block(p("c1-tue"), 2, "rake_deck", "Rake deck in his structures", rakeDetail, 45),
      block(p("c1-wed"), 3, "calibration_session", "Calibration session", "Run a Learn calibration deck; write your eval before every reveal.", 20),
      block(p("c1-thu"), 4, "anti_line_drill", "Anti-book: his Black", antiBlackDetail, 40),
      block(p("c1-fri"), 5, "spar_rival", "Spar session", sparDetail, 45),
      block(p("c1-sat"), 6, "long_game_review", "Long game + review", "One slow game (30+20), then an engine-last review with rebuttal notes."),
    ],
    exitCriteria: [
      { metric: "calib_mae_level", cmp: "<", target: 0.7 },
      { metric: "spar_score", cmp: ">=", target: 0.35 },
    ],
  }

  const ch2: Chapter = {
    id: p("ch2-conversion"),
    title: "Win Where He Leaks",
    weekStart: 5,
    weekEnd: 10,
    objectives: [
      leakText,
      ...(grindText ? [grindText] : []),
      "Convert winning positions without drama — technique over brilliance.",
    ],
    week: [
      block(p("c2-sun"), 0, "rest", "Rest", "Rest, or casual unrated only. Never play rated tired."),
      block(p("c2-mon"), 1, "endgame_playout", "Conversion play-it-out", conversionDetail, 30),
      block(p("c2-tue"), 2, "rake_deck", "Rake deck in his structures", rakeDetail, 45),
      block(p("c2-wed"), 3, "other", "Phase fundamentals", phases.grind ? `Fundamentals for ${PHASE_LABELS[phases.grind.phase] ?? phases.grind.phase} — his strongest phase. ${grindText}` : "K+P and rook-endgame drills — opposition, Lucena/Philidor, the square rule.", 30),
      block(p("c2-thu"), 4, "endgame_playout", "Conversion play-it-out", conversionDetail, 30),
      block(p("c2-fri"), 5, "spar_rival", "Spar session", sparDetail, 45),
      block(p("c2-sat"), 6, "long_game_review", "Long game + review", "One slow game (30+20), then an engine-last review with rebuttal notes."),
    ],
    exitCriteria: [
      { metric: "eg_conversion", cmp: ">=", target: 0.5 },
      { metric: "spar_score", cmp: ">=", target: 0.45 },
    ],
  }

  const ch3: Chapter = {
    id: p("ch3-taper"),
    title: "Taper Onto Him",
    weekStart: 11,
    weekEnd: 14,
    objectives: [
      "Rehearse the prepared anti-lines under the clock until they cost no time.",
      "Spar above his weight so the real games feel slow.",
      "Match conditions: slow games, physical board if the match is OTB.",
    ],
    week: [
      block(p("c3-sun"), 0, "rest", "Rest", "Rest, or casual unrated only. Never play rated tired."),
      block(p("c3-mon"), 1, "anti_line_drill", "Anti-line rehearsal", `Drill both prepared lines against ${name}'s repertoire with the clock on — discomfort over theory.`, 45),
      block(
        p("c3-tue"),
        2,
        "spar_rival",
        "Spar above weight",
        (t.hasPersona ? t.personaLevel ?? band.level : band.level) < MAIA_MAX
          ? `${sparDetail} Play one strength band higher than the level-matched band when you can.`
          : `${sparDetail} Already at the top published band — add clock pressure (shorter control) instead of strength.`,
        45,
      ),
      block(p("c3-wed"), 3, "calibration_session", "Calibration session", "Run a Learn calibration deck; write your eval before every reveal.", 20),
      block(p("c3-thu"), 4, "spar_rival", "Spar session", sparDetail, 45),
      block(p("c3-fri"), 5, "other", "Match-simulation game", "A slow game under match conditions — OTB eyes differ from screen eyes."),
      block(p("c3-sat"), 6, "long_game_review", "Long game + review", "One slow game (30+20), then an engine-last review with rebuttal notes."),
    ],
    exitCriteria: [{ metric: "spar_score", cmp: ">=", target: 0.5 }],
  }

  const program: Program = {
    id: beatProgramId(slug),
    name: `Beat ${name}`,
    goal: `A 14-week program aimed at beating ${name}, built from his measured dossier (${sample.games} games, verdict: ${sample.verdict}).`,
    chapters: [ch1, ch2, ch3],
  }

  return { program, markdown: renderMarkdown(t, program, { exitMove, phases, band, whiteFams, blackFams, whiteLines, blackLines, sparDetail }, generatedAt) }
}

/** Convenience: build a BeatTarget from a loaded profile row + the loaded
 *  persona configs' slugs (artifact-existence, spec 218 precedent). */
export function beatTargetFor(
  p: LocalPlayerProfile,
  opts: { hasPersona: boolean; personaLevel?: number; book?: RivalBook | null },
): BeatTarget {
  return { profile: p.profile, stats: p.stats, ...opts }
}

// ---------------------------------------------------------------------------
// The markdown plan (data/rivals/TRAINING_PLAN.md precedent)
// ---------------------------------------------------------------------------

interface Derived {
  exitMove: number
  phases: PhaseRead
  band: { level: number; capped: boolean }
  whiteFams: OpeningFamilyRow[]
  blackFams: OpeningFamilyRow[]
  whiteLines: { line: string; games: number }[]
  blackLines: { line: string; games: number }[]
  sparDetail: string
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function famTable(rows: OpeningFamilyRow[]): string[] {
  return rows.map((f) => `| ${f.family} | ${f.games} | ${f.wins}W/${f.draws}D/${f.losses}L |`)
}

function renderMarkdown(
  t: BeatTarget,
  program: Program,
  d: Derived,
  generatedAt: Date,
): string {
  const name = t.profile.display_name
  const slug = t.profile.slug
  const s = t.profile.sample
  const stats = t.stats
  const res = stats?.results
  const lines: string[] = []
  const push = (...xs: string[]) => lines.push(...xs)

  push(
    `# Beat ${name} — training program`,
    "",
    `Generated ${generatedAt.toISOString().slice(0, 10)} by the Beat-X generator (spec 225) from the`,
    `\`data/rivals/${slug}.*\` artifacts. PRIVATE — lives in gitignored data/rivals, never committed`,
    `(spec 214 hard rule).`,
    "",
    `## The target, measured`,
    "",
    `- **Corpus**: ${s.games} games (${s.verified_games} verified${s.unverified_games ? `, ${s.unverified_games} unverified` : ""}).`,
    `- **Sample verdict: ${s.verdict.toUpperCase()}**${s.badge ? ` — badge ${s.badge}` : ""}.`,
    ...s.reasons.map((r) => `  - ${r}`),
  )
  if (t.profile.rating?.value != null) {
    push(`- **Rating**: ~${t.profile.rating.value} (${t.profile.rating.source}).`)
  }
  if (res) {
    push(
      `- **Results from his side**: ${res.wins}W/${res.draws}D/${res.losses}L${res.score_pct != null ? ` (${res.score_pct}%)` : ""}.`,
    )
  }
  if (stats?.date_range?.first) {
    push(`- **Span**: ${stats.date_range.first} → ${stats.date_range.last ?? "?"}.`)
  }
  push("")

  if (d.whiteFams.length || d.blackFams.length) {
    push(`## His repertoire`, "", `| Family | Games | Score |`, `|---|---|---|`)
    push(...famTable(d.whiteFams).map((r) => r.replace("| ", "| (W) ")))
    push(...famTable(d.blackFams).map((r) => r.replace("| ", "| (B) ")))
    push("")
  }

  push(
    `## Anti-book preparation`,
    "",
    `Target: your prepared lines leave his book by **move ${d.exitMove}**` +
      (t.book ? ` (his book artifact measures ${t.book.max_ply} plies deep)` : ` (default — no book artifact loaded)`) +
      `. His most-played lines:`,
    "",
  )
  const gameCount = (n: number) => `${n} game${n === 1 ? "" : "s"}`
  if (d.whiteLines.length) {
    push(`As White (you answer as Black):`, ...d.whiteLines.map((l) => `- \`${l.line}\` (${gameCount(l.games)})`), "")
  }
  if (d.blackLines.length) {
    push(`As Black (you choose the White move-order):`, ...d.blackLines.map((l) => `- \`${l.line}\` (${gameCount(l.games)})`), "")
  }
  if (!d.whiteLines.length && !d.blackLines.length) {
    push(`(No line data in the dossier — regenerate the profile with games present.)`, "")
  }

  push(`## Phase profile — where to take him`, "")
  if (d.phases.leak) {
    push(
      `- **He leaks in ${PHASE_LABELS[d.phases.leak.phase] ?? d.phases.leak.phase}**: ${pct(d.phases.leak.score)} score over ${d.phases.leak.row.games} games ending there (${d.phases.leak.row.wins}W/${d.phases.leak.row.draws}D/${d.phases.leak.row.losses}L). Steer games there and convert.`,
    )
  }
  if (d.phases.grind) {
    push(
      `- **He grinds in ${PHASE_LABELS[d.phases.grind.phase] ?? d.phases.grind.phase}**: ${pct(d.phases.grind.score)} score over ${d.phases.grind.row.games} games. Don't drift there unprepared.`,
    )
  }
  if (!d.phases.leak && !d.phases.grind) {
    push(`- Phase profile too thin to weight — conversion training stays general.`)
  }
  push("")

  push(`## Sparring`, "", d.sparDetail, "")

  push(`## The program (in-app: Training tab → "${program.name}")`, "")
  for (const ch of program.chapters) {
    push(`### ${ch.title} (weeks ${ch.weekStart}–${ch.weekEnd})`, "")
    push(...ch.objectives.map((o) => `- ${o}`), "")
    push(`| Day | Block | Detail |`, `|---|---|---|`)
    for (const b of ch.week) {
      push(`| ${DAY_NAMES[b.day]} | ${b.title}${b.minutes ? ` (${b.minutes}m)` : ""} | ${b.detail} |`)
    }
    push(
      "",
      `Exit criteria (measured, spec 215 — the gauge stays unmet until the number is real):`,
      ...ch.exitCriteria.map((c) => `- \`${c.metric}\` ${c.cmp} ${c.target}`),
      "",
    )
  }

  push(
    `## Honesty notes`,
    "",
    `- The sample verdict above is the pipeline's stored record — this plan does not upgrade it.`,
    `- ${t.hasPersona ? `Spar opponents are honest approximations (Maia policy + his real book), never "him".` : `No persona exists for ${name} yet (${s.verdict}); every spar block says exactly what substitutes.`}`,
    `- Exit criteria are measured metrics (spec 215). No vibes.`,
    "",
  )

  return lines.join("\n")
}

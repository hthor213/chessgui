// Any-player profile domain types (spec 225 Part 1) — the wire/file shapes
// produced by scripts/persona/build_player_profile.py and consumed by the
// roster (badges + dossier-only gating) and the Beat-X generator.
//
// Types only, like every *-types module here: nothing imports a platform SDK.

/** The three sample-honesty verdicts (spec 225): thresholds live in the
 *  pipeline as named constants; every consumer renders the STORED verdict,
 *  never re-derives its own. */
export type ProfileVerdict = "full" | "low-confidence" | "dossier-only"

/** Badge text as stored by the pipeline — null for a full profile. */
export type ProfileBadge = "LOW-CONFIDENCE" | "DOSSIER-ONLY"

/** The `sample` block of <slug>.profile.json — the single honesty record
 *  (count, thresholds applied, verdict, why). */
export interface ProfileSample {
  games: number
  verified_games: number
  unverified_games?: number
  unverified_rule?: string | null
  thresholds?: { full_persona_floor: number; persona_min_games: number }
  verdict: ProfileVerdict
  badge: ProfileBadge | null
  reasons: string[]
}

/** <slug>.profile.json (only the fields the app consumes; the file carries
 *  more — identity, artifact paths, generation provenance). Legacy
 *  data/rivals/*.profile.json files predating the pipeline (raw chess.com
 *  player dumps) lack `sample` — loaders filter on it. */
export interface PlayerProfileFile {
  version?: number
  generator?: string
  slug: string
  display_name: string
  relationship?: string
  identity?: { fide_id?: string | null; chesscom?: string | null; lichess?: string | null }
  sample: ProfileSample
  rating?: { value: number; source: string } | null
  artifacts?: {
    pgn?: string | null
    sources_md?: string | null
    stats?: string | null
    book?: string | null
    config?: string | null
  }
}

/** Per-family W/D/L row in the stats dossier. */
export interface OpeningFamilyRow {
  family: string
  wins: number
  draws: number
  losses: number
  games: number
}

/** Per-phase W/D/L row (games that ENDED in that phase). */
export interface PhaseRow {
  wins: number
  draws: number
  losses: number
  games: number
}

/** <slug>.stats.json — the stats dossier the Beat-X generator reads (colors,
 *  results, opening families, most-played lines, phase win/loss profile). */
export interface PlayerStatsFile {
  version?: number
  slug: string
  display_name?: string
  games?: { total: number; as_white: number; as_black: number }
  results?: {
    wins: number
    draws: number
    losses: number
    score_pct?: number
  }
  opening_families?: { as_white: OpeningFamilyRow[]; as_black: OpeningFamilyRow[] }
  top_lines?: {
    as_white: { line: string; games: number }[]
    as_black: { line: string; games: number }[]
  }
  phase_profile?: {
    boundaries?: { opening_max_ply: number; middlegame_max_ply: number }
    ended_in?: { opening?: PhaseRow; middlegame?: PhaseRow; endgame?: PhaseRow }
  }
  rating?: { value: number; source: string } | null
  date_range?: { first?: string; last?: string }
}

/** One pipeline-built player profile as delivered by the `rival_profiles`
 *  command: the profile record plus its stats dossier (null when the stats
 *  artifact is missing). Both live in gitignored data/rivals — never bundled
 *  (spec 214 hard rule: private individuals stay LOCAL). */
export interface LocalPlayerProfile {
  profile: PlayerProfileFile
  stats: PlayerStatsFile | null
}

/** Inputs to the profile pipeline run (spec 225 "Add player profile…" flow):
 *  a display name plus any of the identifier fields / PGN paths. */
export interface ProfileRunRequest {
  name: string
  /** Artifact slug override; the backend slugifies `name` when absent. */
  slug?: string
  fideId?: string
  chesscom?: string
  lichess?: string
  /** Absolute PGN file paths (the OTB import path). */
  pgns?: string[]
  /** Regex marking games whose attribution is unconfirmed (they stay in the
   *  dossier but don't count toward the persona floor). */
  unverifiedEvent?: string
  /** Block the persona outright and record why (corpus in review staging). */
  dossierOnly?: string
}

/** Final report of a profile pipeline run (mirrors MeasureReport). */
export interface ProfileRunReport {
  /** Pipeline exit code; null means killed by a signal (i.e. cancelled). */
  exit_code: number | null
  cancelled: boolean
  /** <slug>.profile.json text after a successful run — the verdict record
   *  the UI renders. Null on failure, cancellation, or an unreadable file. */
  profile_json: string | null
}

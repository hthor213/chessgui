// The bot roster (spec 218 "Roster" checklist item): one list of Participants
// consumed by Play vs Bot today, and — per spec:218's "The Participant"
// architecture — by the exhibition/tournament picker and the persona arena
// later (those surfaces are separate checklist items, not wired here).
//
//   { id, displayName, avatar?, kind: uci | persona, enginePath? | personaConfig? }
//
// Contents (spec 218 decision 4, "everything modeled so far"):
//   - the local player's OWN persona ("You" — spec 218 "Own-persona entry"),
//     ONLY when the self persona has been built locally (data/rivals/
//     self.config.json + self.book.json via scripts/persona/
//     build_self_persona.py — gitignored like every private persona; absent =
//     silently absent, same as the rivals below).
//   - the private rival ("dad"), ONLY when his local book has loaded
//     (data/rivals is gitignored — spec 214 hard rule: personas of private
//     individuals stay LOCAL, so this entry simply doesn't exist when the book
//     is absent, not an error state). Committed text about him stays generic
//     (spec 218 hard rule: "committed spec/UI text refers to the private rival
//     persona generically").
//   - every other private rival with a local config in data/rivals/ (loaded at
//     runtime via the `rival_personas` command — same hard rules: never
//     bundled, absent = silently absent, display names come from the LOCAL
//     config file, never from committed code).
//   - the 12 committed GM personas (data/personas/*.config.json, spec 214
//     Tier 2): real opening books (legitimately theirs, committed) and a BT3
//     policy backend (`runnable_in_engine_v1: false`) that persona_move now
//     drives via the gate-resolved `weights` selector when the net is present
//     (Maia fallback otherwise, spec 218 follow-up). Their CLAIM stays an
//     honest approximation — top-native-band label — gated by gatePersonaLevel
//     below (spec 216/214 hard rule: no unmeasured realism claims; the loader
//     owns honesty, persona_move cannot self-gate).
//   - the Maia strength bands (1100-1900, the full published-net set —
//     src-tauri/src/maia.rs BANDS) as generic bots, no persona/identity
//     attached.
//
// Avatars: every entry ships with none (spec 218 "Avatars" checklist item
// — the caricature pipeline is a later item; this ships with zero art). UI
// consumers fall back to an initials monogram (initialsFor below). A future
// private-rival avatar loads from local app data only, never bundled
// (spec 218 decision 1) — nothing here changes that when it lands.

import { getProviders } from "@/lib/platform"
import { BT3_NET_FILE, BT3_WEIGHTS_NAME, MAIA_MAX_NATIVE_BAND } from "@/lib/maia"
import type { RivalBook } from "@/lib/rival-book"
import type { ErrorModel } from "@chessgui/core/persona-types"

// The committed GM persona configs (spec 214 Tier 2 extraction pipeline).
// Static imports — these are small public JSON files; the multi-MB *.book.json
// files are NOT imported here, they load lazily via PERSONA_BOOK_IMPORTS below.
import fischerConfig from "@/data/personas/fischer.config.json"
import kasparovConfig from "@/data/personas/kasparov.config.json"
import karpovConfig from "@/data/personas/karpov.config.json"
import spasskyConfig from "@/data/personas/spassky.config.json"
import fridrikOlafssonConfig from "@/data/personas/fridrik-olafsson.config.json"
import helgiOlafssonConfig from "@/data/personas/helgi-olafsson.config.json"
import johannHjartarsonConfig from "@/data/personas/johann-hjartarson.config.json"
import jonLArnasonConfig from "@/data/personas/jon-l-arnason.config.json"
import margeirPeturssonConfig from "@/data/personas/margeir-petursson.config.json"
import hannesStefanssonConfig from "@/data/personas/hannes-stefansson.config.json"
import hedinnSteingrimssonConfig from "@/data/personas/hedinn-steingrimsson.config.json"
import sigurjonssonPeakConfig from "@/data/personas/sigurjonsson-peak.config.json"

export type ParticipantKind = "uci" | "persona"

/** Per-entry action set (spec 218 decision, "The Participant" surface 1): the
 *  private rival is the only entry with both play and improve; everyone else
 *  gets Play only. "beat" (spec 225) generates the Beat-X training program
 *  and exists exactly on the entries backed by a pipeline profile. */
export type ParticipantAction = "play" | "improve" | "beat"

/** Where a participant's move-by-move opening book lives:
 *  - "rival": the original private rival's book via the `rival_book` command
 *  - "persona": a committed data/personas/<bookSlug>.book.json (lazy import)
 *  - "local": a private rival's book delivered with its local config by the
 *    `rival_personas` command (gitignored data/rivals, never bundled) */
export type BookKind = "rival" | "persona" | "local"

/** spec 214's persona config payload — book source, policy backend (a Maia
 *  band, optionally overridden by a managed-net `weights` selector the gate
 *  resolved), and whether the strength label is a measured fact or an honest
 *  approximation. */
export interface PersonaConfig {
  /** Maia rating band used as the policy backend — and the fallback band when
   *  `weights` names a net that isn't available. The honesty gate guarantees
   *  this is always a real published band — never a BT3-strength number
   *  smuggled into persona_move. */
  level: number
  /** Managed-net policy backend selector for persona_move (e.g. "bt3"),
   *  present ONLY when gatePersonaLevel resolved the config's backend to a
   *  net the play path can actually drive (spec 218 follow-up: persona_move
   *  honors `weights` with a clean fallback to `level`'s Maia band). Never
   *  changes what the entry may CLAIM — level/approximate stay gated. */
  weights?: string
  /** True when the strength label is an honest approximation, not a
   *  measured fact about the modeled player (spec 216/214 hard rule). */
  approximate?: boolean
  /** Move-by-move book source (spec 214 "Move-by-move rival book"), if any. */
  book?: BookKind
  /** Config slug resolving the book for kinds "persona" and "local". */
  bookSlug?: string
  /** Optional per-persona sampling overrides from the config file (camelCase,
   *  matching the Rust wire shape in match_runner.rs). Absent = the spar
   *  loop's DEFAULT_PERSONA_PARAMS. */
  temperature?: number
  alpha?: number
  lambda?: number
  topK?: number
  topP?: number
  verifyDepth?: number
  /** Corpus error model (spec 214 step 5), from a config whose tuner run
   *  passed the held-out +2% bar; absent = OFF (the default everywhere). */
  errorModel?: ErrorModel
  /** Persona snapshot id (spec 214 "Persona snapshots") of the loaded bundle,
   *  computed Rust-side where the persona's files load (`rival_personas`):
   *  config JSON + book file hash + weights reference + sampling params,
   *  content-hashed — so a config edit or book rebuild is a new id with no
   *  registry. Present only for local-file-backed personas; the spar decision
   *  log records it per game (frontend-imported GM/band entries fall back to
   *  the engine-side id on each decision). */
  snapshotId?: string
}

export interface Participant {
  id: string
  displayName: string
  /** Local file/data URL for a caricature portrait. Undefined for every entry
   *  (ships with zero art) — consumers render initialsFor() instead. */
  avatar?: string
  kind: ParticipantKind
  /** kind: "uci" only — a named binary path. No roster entry uses this; the
   *  type exists so the exhibition/tournament picker (later checklist item)
   *  can mix engines and personas in the same list. */
  enginePath?: string
  /** kind: "persona" only. */
  personaConfig?: PersonaConfig
  /** Honest strength label for the roster card and in-game (spec 216: every
   *  roster card shows measured strength, or says plainly that it doesn't). */
  strengthLabel: string
  actions: ParticipantAction[]
  /** Sample-size honesty badge (spec 225): the verdict STORED by the profile
   *  pipeline in <slug>.profile.json — never re-derived here, so every
   *  surface (roster card, in-game header) renders the same honesty. */
  verdictBadge?: ProfileBadge
  /** The stored verdict reasons, for the badge tooltip. */
  badgeTitle?: string
  /** The pipeline profile this entry is backed by (spec 225), when one
   *  exists — the Beat-X generator's lookup key. */
  profileSlug?: string
}

// ---------------------------------------------------------------------------
// Persona config files (data/personas committed; data/rivals local-only)
// ---------------------------------------------------------------------------

// Extracted to @chessgui/core (spec 220 step 5); re-exported so existing
// importers keep working.
import type { LocalRivalPersona, PersonaConfigFile } from "@chessgui/core/roster-types"
export type { LocalRivalPersona, PersonaConfigFile }
import type {
  LocalPlayerProfile,
  PlayerProfileFile,
  ProfileBadge,
} from "@chessgui/core/player-profile-types"
export type { LocalPlayerProfile, PlayerProfileFile, ProfileBadge }

/** All 12 committed GM persona configs, exported for tests and for the
 *  exhibition/tournament surface to reuse. sigurjonsson-peak is Guðmundur
 *  Sigurjónsson at peak strength (1975-78 slice). */
export const GM_PERSONA_CONFIGS: PersonaConfigFile[] = [
  fischerConfig,
  kasparovConfig,
  karpovConfig,
  spasskyConfig,
  fridrikOlafssonConfig,
  helgiOlafssonConfig,
  johannHjartarsonConfig,
  jonLArnasonConfig,
  margeirPeturssonConfig,
  hannesStefanssonConfig,
  hedinnSteingrimssonConfig,
  sigurjonssonPeakConfig,
] as unknown as PersonaConfigFile[]

// Lazy book loaders: each committed GM book is its own dynamically-imported
// chunk (0.2-3 MB of JSON each), loaded only when a game against that persona
// actually starts — never at roster-build time.
const PERSONA_BOOK_IMPORTS: Record<string, () => Promise<unknown>> = {
  fischer: () => import("@/data/personas/fischer.book.json"),
  kasparov: () => import("@/data/personas/kasparov.book.json"),
  karpov: () => import("@/data/personas/karpov.book.json"),
  spassky: () => import("@/data/personas/spassky.book.json"),
  "fridrik-olafsson": () => import("@/data/personas/fridrik-olafsson.book.json"),
  "helgi-olafsson": () => import("@/data/personas/helgi-olafsson.book.json"),
  "johann-hjartarson": () => import("@/data/personas/johann-hjartarson.book.json"),
  "jon-l-arnason": () => import("@/data/personas/jon-l-arnason.book.json"),
  "margeir-petursson": () => import("@/data/personas/margeir-petursson.book.json"),
  "hannes-stefansson": () => import("@/data/personas/hannes-stefansson.book.json"),
  "hedinn-steingrimsson": () => import("@/data/personas/hedinn-steingrimsson.book.json"),
  "sigurjonsson-peak": () => import("@/data/personas/sigurjonsson-peak.book.json"),
}

/** A committed GM persona's opening book (same format as the rival book —
 *  both come from build_rival_book.py), or null for an unknown slug. */
export async function loadPersonaBook(slug: string): Promise<RivalBook | null> {
  const load = PERSONA_BOOK_IMPORTS[slug]
  if (!load) return null
  const mod = (await load()) as { default: unknown }
  return mod.default as RivalBook
}

/** The private-rival personas present on THIS machine (gitignored
 *  data/rivals/*.config.json + books), via the `rival_personas` command.
 *  Degrades silently to [] off-desktop, when the dir is absent, or on any
 *  error — a missing private persona is never an error state (spec 214). */
export async function loadLocalRivalPersonas(): Promise<LocalRivalPersona[]> {
  try {
    const rivals = await getProviders().engine.rivalPersonas()
    return Array.isArray(rivals) ? rivals : []
  } catch {
    return []
  }
}

/** True for a profile record the spec 225 pipeline wrote — it carries the
 *  stored sample verdict. Legacy data/rivals/*.profile.json files (raw
 *  chess.com player dumps from the hand-built era) lack `sample` and are
 *  filtered out here, not surfaced with a made-up verdict. */
export function isPipelineProfile(v: unknown): v is PlayerProfileFile {
  if (typeof v !== "object" || v === null) return false
  const p = v as Record<string, unknown>
  const sample = p.sample as Record<string, unknown> | undefined
  return (
    typeof p.slug === "string" &&
    typeof p.display_name === "string" &&
    typeof sample === "object" &&
    sample !== null &&
    typeof sample.verdict === "string"
  )
}

/** The pipeline-built player profiles present on THIS machine (gitignored
 *  data/rivals/*.profile.json + stats), via the `rival_profiles` command.
 *  Same degradation contract as loadLocalRivalPersonas: [] everywhere a
 *  profile can't exist — never an error state (spec 214/225). */
export async function loadPlayerProfiles(): Promise<LocalPlayerProfile[]> {
  try {
    const rows = await getProviders().engine.rivalProfiles()
    if (!Array.isArray(rows)) return []
    return rows.filter((r) => isPipelineProfile(r?.profile))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// The honesty gate (spec 216/214 hard rule: no unmeasured realism claims)
// ---------------------------------------------------------------------------

/** The Maia bands persona_move v1 can actually drive. */
const MAIA_MIN_NATIVE_BAND = 1100

export interface GatedLevel {
  level: number
  approximate: boolean
  /** persona_move `weights` selector, present ONLY when the config's backend
   *  resolves to the known managed net the play path can actually drive.
   *  Absent = the Maia band at `level` serves alone. */
  weights?: string
}

/**
 * HONESTY GATE. persona_move takes `level` + tunables straight from the
 * frontend and CANNOT self-gate — so this loader decides what a config may
 * claim in the Play vs Bot surface:
 *
 * - A config that is runnable as a plain Maia band (`runnable_in_engine_v1:
 *   true`, backend kind "maia", level within the published 1100-1900 set)
 *   plays at its configured band, as configured.
 * - EVERYTHING else — `runnable_in_engine_v1: false` (the BT3-backed GM
 *   personas), a non-Maia backend, or an out-of-band level — is clamped to
 *   the top native Maia band and marked `approximate`. Its real book still
 *   plays (the book is legitimately the player's own recorded moves); the
 *   policy strength claim does not.
 *
 * BACKEND vs CLAIM (spec 218 follow-up, 2026-07-17): persona_move now honors
 * a managed-net `weights` selector with a clean fallback to `level`'s Maia
 * band when the net is absent — so a gated config whose backend resolves to
 * the known managed net additionally gets `weights`, letting its real policy
 * actually serve when the net is present. That changes nothing about the
 * CLAIM: level stays clamped (it is the fallback band) and `approximate`
 * stays true, because whether BT3 serves is a runtime fact the decision
 * log's `policy_backend` reports, not a promise this label may make. A
 * config whose backend does NOT resolve (unknown net, unknown kind) gets no
 * `weights` and keeps plain Maia.
 */
export function gatePersonaLevel(cfg: PersonaConfigFile): GatedLevel {
  const level = cfg.sampling.level
  const runnableAsMaiaBand =
    cfg.runnable_in_engine_v1 === true &&
    cfg.backend?.kind === "maia" &&
    level >= MAIA_MIN_NATIVE_BAND &&
    level <= MAIA_MAX_NATIVE_BAND
  if (runnableAsMaiaBand) return { level, approximate: false }
  const clamped = Math.min(Math.max(level, MAIA_MIN_NATIVE_BAND), MAIA_MAX_NATIVE_BAND)
  const managedNet =
    cfg.backend?.kind === "lc0-policy" && cfg.backend?.net?.file === BT3_NET_FILE
  return {
    level: clamped,
    approximate: true,
    ...(managedNet ? { weights: BT3_WEIGHTS_NAME } : {}),
  }
}

/** camelCase sampling overrides for the spar loop, from a config file's
 *  snake_case `sampling` block (level is handled by gatePersonaLevel). */
function samplingOverrides(cfg: PersonaConfigFile): Partial<PersonaConfig> {
  const s = cfg.sampling
  return {
    ...(s.temperature !== undefined ? { temperature: s.temperature } : {}),
    ...(s.alpha !== undefined ? { alpha: s.alpha } : {}),
    ...(s.lambda !== undefined ? { lambda: s.lambda } : {}),
    ...(s.top_k !== undefined ? { topK: s.top_k } : {}),
    ...(s.top_p !== undefined ? { topP: s.top_p } : {}),
    ...(s.verify_depth !== undefined ? { verifyDepth: s.verify_depth } : {}),
    // null in the file means measured-and-rejected — same as absent: OFF.
    ...(s.error_model ? { errorModel: s.error_model } : {}),
  }
}

export const PRIVATE_RIVAL_ID = "rival"
/** Generic by design (spec 214/218 hard rule) — never the rival's name. */
export const PRIVATE_RIVAL_DISPLAY_NAME = "Private rival"

export const SELF_PERSONA_ID = "self"
/** The `kind` field that marks a local config as the player's own persona
 *  (scripts/persona/build_self_persona.py writes it); every other local
 *  config is kind "private-rival". */
export const SELF_PERSONA_KIND = "self"
export const SELF_PERSONA_DISPLAY_NAME = "You"

/** Every published Maia-1 net (src-tauri/src/maia.rs BANDS), surfaced as
 *  generic strength-band bots. */
export const MAIA_ROSTER_BANDS = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900] as const

/** Initials for the avatar monogram fallback: up to two characters, from the
 *  first letters of up to two words ("Fischer" -> "FI", "Private rival" ->
 *  "PR", "Bot 1500" -> "B1"). */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

function maiaBandBot(level: number): Participant {
  return {
    id: `maia-${level}`,
    displayName: `Bot ${level}`,
    kind: "persona",
    personaConfig: { level },
    strengthLabel: `~${level} (Maia policy)`,
    actions: ["play"],
  }
}

/** A committed GM persona (spec 218 decision 3: best fidelity currently
 *  available in THIS surface, always with an honest strength label). All 12
 *  are BT3-backed (`runnable_in_engine_v1: false`): the gate resolves their
 *  backend to the `weights` selector — persona_move drives the BT3 net when
 *  it's present, falling back to the top native Maia band otherwise — while
 *  the CLAIM stays an approximation: real opening book, gated top-band label
 *  pointing at the Tournament surface for the measured full-strength entry. */
function gmPersonaParticipant(cfg: PersonaConfigFile): Participant {
  const gate = gatePersonaLevel(cfg)
  return {
    id: cfg.slug,
    displayName: cfg.display_name,
    kind: "persona",
    personaConfig: {
      level: gate.level,
      ...(gate.weights ? { weights: gate.weights } : {}),
      ...(gate.approximate ? { approximate: true } : {}),
      book: "persona",
      bookSlug: cfg.slug,
      ...samplingOverrides(cfg),
    },
    strengthLabel: gate.approximate
      ? `${cfg.display_name} — his openings, ~${gate.level} policy approximation; full-strength persona available in Tournament`
      : `${cfg.display_name} — his openings, ~${gate.level} (Maia policy)`,
    actions: ["play"],
  }
}

/** A private rival from a LOCAL config (never bundled; the display name comes
 *  from the local file, so committed code stays generic — spec 214/218 hard
 *  rule). Book entries play move-by-move like the original rival's; strength
 *  is the config's Maia band, honestly labeled unmeasured. */
function localRivalParticipant(rp: LocalRivalPersona, profile?: PlayerProfileFile): Participant {
  const cfg = rp.config
  const gate = gatePersonaLevel(cfg)
  const hasBook = rp.book !== null && rp.book !== undefined
  return {
    id: `rival-${cfg.slug}`,
    displayName: cfg.display_name || PRIVATE_RIVAL_DISPLAY_NAME,
    kind: "persona",
    personaConfig: {
      level: gate.level,
      ...(gate.weights ? { weights: gate.weights } : {}),
      ...(gate.approximate ? { approximate: true } : {}),
      ...(hasBook ? { book: "local" as const, bookSlug: cfg.slug } : {}),
      ...samplingOverrides(cfg),
      // Spec 214 snapshot id, Rust-computed when this persona's files loaded.
      ...(rp.snapshotId ? { snapshotId: rp.snapshotId } : {}),
    },
    strengthLabel: hasBook
      ? `~${gate.level} (Maia policy) playing his real openings — unmeasured`
      : `~${gate.level} (Maia policy) — unmeasured`,
    actions: ["play"],
    // Spec 225: a pipeline profile behind this config adds the stored
    // sample-honesty badge (LOW-CONFIDENCE under the ~30-game floor) and
    // arms the Beat-X generator.
    ...(profile ? profileAnnotations(profile) : {}),
  }
}

/** The spec 225 annotations a pipeline profile adds to a roster entry: the
 *  stored verdict badge (rendered verbatim — never re-derived) and the
 *  Beat-X action. */
function profileAnnotations(
  profile: PlayerProfileFile,
): Pick<Participant, "verdictBadge" | "badgeTitle" | "profileSlug"> & {
  actions: ParticipantAction[]
} {
  return {
    profileSlug: profile.slug,
    actions: ["play", "beat"],
    ...(profile.sample.badge
      ? {
          verdictBadge: profile.sample.badge,
          badgeTitle: profile.sample.reasons.join(" · "),
        }
      : {}),
  }
}

/** A dossier-only profile (spec 225): its artifacts exist (pgn/stats/book)
 *  but the sample failed the persona gates, so it appears in the roster —
 *  same artifact-existence gating as everything else — and fields NO bot:
 *  no personaConfig, no Play action, only the Beat-X generator. */
function dossierProfileParticipant(p: LocalPlayerProfile): Participant {
  const s = p.profile.sample
  const rating = p.profile.rating?.value
  return {
    id: `profile-${p.profile.slug}`,
    displayName: p.profile.display_name,
    kind: "persona",
    strengthLabel: `${rating != null ? `~${rating} (corpus Elo) — ` : ""}dossier only, ${s.games} game${s.games === 1 ? "" : "s"} (${s.verified_games} verified) — fields no bot`,
    actions: ["beat"],
    verdictBadge: "DOSSIER-ONLY",
    badgeTitle: s.reasons.join(" · "),
    profileSlug: p.profile.slug,
  }
}

/** The local player's own persona (spec 218 "Own-persona entry": "the
 *  logged-in/local player's OWN persona appears in their roster when one
 *  exists" — in the local app, "You"). Arrives through the same local-config
 *  channel as the private rivals (gitignored data/rivals, never bundled), but
 *  is its own roster card: fixed "You" display name, and — unlike the
 *  friends/family configs — its Maia band is the self-report's MEASURED
 *  move-quality estimate, so the label says "Maia-estimated", not
 *  "unmeasured". */
function selfParticipant(rp: LocalRivalPersona): Participant {
  const gate = gatePersonaLevel(rp.config)
  return {
    id: SELF_PERSONA_ID,
    displayName: SELF_PERSONA_DISPLAY_NAME,
    kind: "persona",
    personaConfig: {
      level: gate.level,
      ...(gate.weights ? { weights: gate.weights } : {}),
      ...(gate.approximate ? { approximate: true } : {}),
      book: "local",
      bookSlug: rp.config.slug,
      ...samplingOverrides(rp.config),
      // Spec 214 snapshot id, Rust-computed when this persona's files loaded.
      ...(rp.snapshotId ? { snapshotId: rp.snapshotId } : {}),
    },
    strengthLabel: `~${gate.level} (Maia policy) playing your real openings — Maia-estimated self-model`,
    actions: ["play"],
  }
}

/** The original private rival ("dad") — the only dial-able, improvable entry;
 *  his book still arrives via the legacy `rival_book` command. */
function privateRivalParticipant(): Participant {
  return {
    id: PRIVATE_RIVAL_ID,
    displayName: PRIVATE_RIVAL_DISPLAY_NAME,
    kind: "persona",
    personaConfig: { level: 1700, book: "rival" },
    strengthLabel: "~1500–1900 (dial-able) — plays his real opening book",
    actions: ["play", "improve"],
  }
}

/**
 * Build the roster. `book` is whatever the caller already has from
 * `loadRivalBook()` (or null if it hasn't loaded / doesn't exist);
 * `localRivals` is whatever `loadLocalRivalPersonas()` returned ([] when
 * absent); `profiles` is whatever `loadPlayerProfiles()` returned (spec 225
 * — same artifact-existence gating). Pure, so it's trivially unit-testable
 * without mocking Tauri.
 */
export function buildRoster(
  book: RivalBook | null,
  localRivals: LocalRivalPersona[] = [],
  profiles: LocalPlayerProfile[] = [],
): Participant[] {
  const roster: Participant[] = []
  const profileBySlug = new Map(profiles.map((p) => [p.profile.slug, p]))
  // The self persona leads the roster, gated on its book artifact existing
  // (spec 218 "Own-persona entry": appears only when a self-persona has been
  // built; a config without its book is not a playable self-model yet).
  const self = localRivals.find((rp) => rp.config.kind === SELF_PERSONA_KIND)
  if (self?.book) roster.push(selfParticipant(self))
  if (book) roster.push(privateRivalParticipant())
  for (const rp of localRivals) {
    if (rp.config.kind === SELF_PERSONA_KIND) continue
    roster.push(localRivalParticipant(rp, profileBySlug.get(rp.config.slug)?.profile))
  }
  // Pipeline profiles with no persona config loaded (spec 225): dossier-only
  // cards — visible because their artifacts exist, fielding no bot. The self
  // profile never doubles as an opponent card.
  const configSlugs = new Set(localRivals.map((rp) => rp.config.slug))
  for (const p of profiles) {
    if (configSlugs.has(p.profile.slug)) continue
    roster.push(dossierProfileParticipant(p))
  }
  for (const cfg of GM_PERSONA_CONFIGS) roster.push(gmPersonaParticipant(cfg))
  for (const level of MAIA_ROSTER_BANDS) roster.push(maiaBandBot(level))
  return roster
}

/**
 * Resolve a participant's opening book for the spar loop: the already-loaded
 * private-rival book, a committed GM book (lazy chunk), or a local rival's
 * book delivered with its config. Null when the participant has no book or
 * the source can't provide one.
 */
export async function resolveParticipantBook(
  config: PersonaConfig | undefined,
  deps: { rivalBook: RivalBook | null; localRivals: LocalRivalPersona[] },
): Promise<RivalBook | null> {
  switch (config?.book) {
    case "rival":
      return deps.rivalBook
    case "persona":
      return config.bookSlug ? loadPersonaBook(config.bookSlug) : null
    case "local":
      return deps.localRivals.find((r) => r.config.slug === config.bookSlug)?.book ?? null
    default:
      return null
  }
}

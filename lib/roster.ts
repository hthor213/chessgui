// The bot roster (spec 218 "Roster" checklist item): one list of Participants
// consumed by Play vs Bot today, and — per spec:218's "The Participant"
// architecture — by the exhibition/tournament picker and the persona arena
// later (those surfaces are separate checklist items, not wired here).
//
//   { id, displayName, avatar?, kind: uci | persona, enginePath? | personaConfig? }
//
// v1 contents (spec 218 decision 4, "everything modeled so far"):
//   - the private rival, ONLY when his local book has loaded (data/rivals is
//     gitignored — spec 214 hard rule: personas of private individuals stay
//     LOCAL, so this entry simply doesn't exist when the book is absent, not
//     an error state). Committed text about him stays generic (spec 218 hard
//     rule: "committed spec/UI text refers to the private rival persona
//     generically").
//   - Fischer and Kasparov, backed by Maia-band policy at the top native
//     band — an honest APPROXIMATION, not their real strength (spec 216/214
//     hard rule: no unmeasured realism claims). data/personas/ has extracted
//     PGNs but not yet the position -> weighted-reply book format
//     build_rival_book.py produces, so these two have no move-by-move book
//     in v1 — they start from the standard position like any other bot.
//   - the Maia strength bands (1100-1900, the full published-net set —
//     src-tauri/src/maia.rs BANDS) as generic bots, no persona/identity
//     attached.
//
// Avatars: every v1 entry ships with none (spec 218 "Avatars" checklist item
// — the caricature pipeline is a later item; this ships with zero art). UI
// consumers fall back to an initials monogram (initialsFor below). A future
// private-rival avatar loads from local app data only, never bundled
// (spec 218 decision 1) — nothing here changes that when it lands.

import { MAIA_MAX_NATIVE_BAND } from "@/lib/maia"
import type { RivalBook } from "@/lib/rival-book"

export type ParticipantKind = "uci" | "persona"

/** Per-entry action set (spec 218 decision, "The Participant" surface 1): the
 *  private rival is the only entry with both; everyone else gets Play only. */
export type ParticipantAction = "play" | "improve"

/** spec 214's persona config payload — book source, policy backend
 *  (Maia band in v1; BT3/stronger backends are a later tier), and whether the
 *  strength label is a measured fact or an honest approximation. */
export interface PersonaConfig {
  /** Maia rating band used as the policy backend (persona engine v1). */
  level: number
  /** True when the strength label is an honest approximation, not a
   *  measured fact about the modeled player (spec 216/214 hard rule). */
  approximate?: boolean
  /** Move-by-move book id this entry starts from (spec 214 "Move-by-move
   *  rival book"), if any. Only the private rival has one in v1; loaded via
   *  the existing `rival_book` Tauri command exactly as before — his data
   *  stays local. */
  book?: "rival"
}

export interface Participant {
  id: string
  displayName: string
  /** Local file/data URL for a caricature portrait. Undefined in v1 for
   *  every entry (ships with zero art) — consumers render initialsFor()
   *  instead. */
  avatar?: string
  kind: ParticipantKind
  /** kind: "uci" only — a named binary path. No v1 roster entry uses this;
   *  the type exists so the exhibition/tournament picker (later checklist
   *  item) can mix engines and personas in the same list. */
  enginePath?: string
  /** kind: "persona" only. */
  personaConfig?: PersonaConfig
  /** Honest strength label for the roster card and in-game (spec 216: every
   *  roster card shows measured strength, or says plainly that it doesn't). */
  strengthLabel: string
  actions: ParticipantAction[]
}

export const PRIVATE_RIVAL_ID = "rival"
/** Generic by design (spec 214/218 hard rule) — never the rival's name. */
export const PRIVATE_RIVAL_DISPLAY_NAME = "Private rival"

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

/** Fischer/Kasparov v1 (spec 218 decision 3: "start with Fischer and
 *  Kasparov at the best fidelity currently available ... always with honest
 *  strength labels — 'to be updated' is acceptable and expected"). */
function historicalApproxBot(id: string, displayName: string): Participant {
  const level = MAIA_MAX_NATIVE_BAND
  return {
    id,
    displayName,
    kind: "persona",
    personaConfig: { level, approximate: true },
    strengthLabel: `${displayName} — approximation, ~${level} policy; full persona pending`,
    actions: ["play"],
  }
}

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
 * `loadRivalBook()` (or null if it hasn't loaded / doesn't exist) — this
 * function is pure so it's trivially unit-testable without mocking Tauri.
 */
export function buildRoster(book: RivalBook | null): Participant[] {
  const roster: Participant[] = []
  if (book) roster.push(privateRivalParticipant())
  roster.push(historicalApproxBot("fischer", "Fischer"))
  roster.push(historicalApproxBot("kasparov", "Kasparov"))
  for (const level of MAIA_ROSTER_BANDS) roster.push(maiaBandBot(level))
  return roster
}

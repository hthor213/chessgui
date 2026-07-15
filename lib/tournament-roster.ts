// The tournament/exhibition Participant dropdown roster (spec 218 "Exhibition
// & tournament" checklist item 1; decision 5 picker style — "one simple
// dropdown, kind-prefixed labels ... no separate roster-browser screen in the
// tournament tab").
//
// This is DELIBERATELY separate from lib/roster.ts's `buildRoster`. That
// module builds the UI-facing roster (displayName/avatar/strengthLabel/
// actions) for Play vs Bot's card browser; this module builds the wire-format
// `Participant`/`PersonaConfig` (lib/tournament.ts, matching
// src-tauri/src/match_runner.rs's camelCase contract exactly) that the
// tournament runner actually deserializes off `play_batch`'s `specs`. The two
// shapes serve different surfaces and are not unified — but the PRIVATE
// RIVAL gating is one fact, not two: this file imports `buildRoster` and
// `PRIVATE_RIVAL_ID` from lib/roster.ts and reuses its "book loaded or not"
// gate rather than re-deriving it, so the two rosters can never disagree on
// whether he's in scope.
//
// GM-strength personas (Fischer, Kasparov, Karpov, Spassky, the Icelandic
// roster) reach this dropdown via lib/persona-manifest.ts, a generated
// snapshot of data/personas/*.config.json — see that file's header and
// scripts/generate-persona-manifest.mjs for why a snapshot exists (nothing in
// the Next.js app reads data/personas/ at runtime) and what it filters
// (public-figure only, BT3-backed only, measured-harness only).
//
// HONESTY GATE (spec 218 item 1, hard rule): every GM persona entry here
// carries `weights: "bt3"` and a measured harness move-match label — never
// level-only. The persona arm DOES support the BT3 managed net (spec 218
// "Managed weights" checklist item, 2026-07-15), so these are real, runnable
// entries, not "coming soon" placeholders, despite each config.json's
// `runnable_in_engine_v1: false` (that flag describes the OLDER Maia-band-
// only engine, superseded by the managed-net arm — see
// scripts/generate-persona-manifest.mjs's header for the full argument). The
// `disabled` field below exists for a FUTURE persona that has no runnable
// backend at all (e.g. a config with no BT3 net); none of today's entries use
// it.

import { buildRoster, MAIA_ROSTER_BANDS, PRIVATE_RIVAL_ID } from "@/lib/roster"
import type { RivalBook } from "@/lib/rival-book"
import { DEFAULT_PERSONA_PARAMS } from "@/lib/persona"
import { GM_PERSONAS, type GmPersonaManifestEntry } from "@/lib/persona-manifest"
import type { Participant } from "@/lib/tournament"

/** One dropdown option: a ready-to-send wire `Participant` plus its exact
 *  decision-5 label ("engine: …" / "bot: …"). */
export type TournamentRosterEntry = {
  participant: Participant
  label: string
  /** True for an entry that cannot actually be sent to the runner yet (kept
   *  visible but non-selectable, per spec 218's "disabled/coming soon" honesty
   *  gate) — unused by any entry as of 2026-07-15 (every entry here is real). */
  disabled?: boolean
  disabledReason?: string
}

/** The two MVP tournament engines (spec:210). No "Add-engine UI" yet
 *  (spec:210 Phase 6, unstarted) — the dropdown is fixed to these two, not a
 *  free-text path. `label` is supplied by the caller so it can fold in the
 *  live-detected UCI version (tournament-tab.tsx already resolves this via
 *  `engine_id`) without this pure function depending on Tauri. */
export type EngineOption = {
  id: string
  displayName: string
  enginePath: string
  /** Exact dropdown text, e.g. "engine: stockfish 18". */
  label: string
}

function uciEntry(e: EngineOption): TournamentRosterEntry {
  return {
    participant: { id: e.id, displayName: e.displayName, kind: "uci", enginePath: e.enginePath },
    label: e.label,
  }
}

/** A Maia strength-band bot (spec 218 decision 4's "generic bots"): pure
 *  policy sampling, no verification net override. Mirrors lib/roster.ts's
 *  `maiaBandBot` sampling intent (same `DEFAULT_PERSONA_PARAMS` the private
 *  rival and every other persona uses out of book) at the wire shape the
 *  runner actually reads. */
function maiaBandEntry(level: number): TournamentRosterEntry {
  return {
    participant: {
      id: `maia-${level}`,
      displayName: `Bot ${level}`,
      kind: "persona",
      personaConfig: {
        level,
        temperature: DEFAULT_PERSONA_PARAMS.temperature,
        alpha: DEFAULT_PERSONA_PARAMS.alpha,
        lambda: DEFAULT_PERSONA_PARAMS.lambda,
        topK: DEFAULT_PERSONA_PARAMS.top_k,
        verifyDepth: DEFAULT_PERSONA_PARAMS.verify_depth,
      },
    },
    label: `bot: maia ${level}`,
  }
}

/** The private rival ("bot: dad" — generic id/label per spec 214/218's hard
 *  rule that committed text never names him). `level` is his dial-able
 *  strength from lib/roster.ts's own participant, so the two rosters stay in
 *  sync on his default band without duplicating the number. Honest
 *  limitation, recorded rather than hidden: the tournament runner's persona
 *  arm (match_runner.rs `PersonaConfig`) has no `book` field, so this entry
 *  plays Maia-band policy at his level — NOT his real move-by-move opening
 *  book (that stays spar-tab-only, via the separate `rival_book` command).
 */
function rivalEntry(level: number): TournamentRosterEntry {
  return {
    participant: {
      id: PRIVATE_RIVAL_ID,
      displayName: "Private rival",
      kind: "persona",
      personaConfig: {
        level,
        temperature: DEFAULT_PERSONA_PARAMS.temperature,
        alpha: DEFAULT_PERSONA_PARAMS.alpha,
        lambda: DEFAULT_PERSONA_PARAMS.lambda,
        topK: DEFAULT_PERSONA_PARAMS.top_k,
        verifyDepth: DEFAULT_PERSONA_PARAMS.verify_depth,
      },
    },
    label: "bot: dad",
  }
}

/** A BT3-backed GM persona (spec 218 item 1's honesty-gate entries): real
 *  sampling params, `weights: "bt3"`, and the measured harness label —
 *  "bot: kasparov (BT3, 64% move-match)", never level-only. */
function gmPersonaEntry(p: GmPersonaManifestEntry): TournamentRosterEntry {
  const pct = Math.round(p.matchAt1 * 100)
  return {
    participant: {
      id: p.slug,
      displayName: p.displayName,
      kind: "persona",
      personaConfig: {
        level: p.level,
        temperature: p.temperature,
        alpha: p.alpha,
        lambda: p.lambda,
        topK: p.topK,
        verifyDepth: p.verifyDepth,
        weights: p.weights,
      },
    },
    label: `bot: ${p.slug} (BT3, ${pct}% move-match)`,
  }
}

/**
 * Build the tournament/exhibition dropdown roster: the two fixed engines,
 * then every BT3 GM persona, the private rival (only when his local book
 * loaded — gated by literally reusing lib/roster.ts's `buildRoster`, not a
 * re-derived condition), and the Maia strength bands. Pure and unit-testable
 * without Tauri, same as lib/roster.ts's `buildRoster`.
 */
export function buildTournamentRoster(
  book: RivalBook | null,
  engines: EngineOption[],
): TournamentRosterEntry[] {
  const roster: TournamentRosterEntry[] = engines.map(uciEntry)

  const uiRoster = buildRoster(book)
  const rival = uiRoster.find((p) => p.id === PRIVATE_RIVAL_ID)
  if (rival) roster.push(rivalEntry(rival.personaConfig?.level ?? DEFAULT_RIVAL_LEVEL))

  for (const g of GM_PERSONAS) roster.push(gmPersonaEntry(g))
  for (const level of MAIA_ROSTER_BANDS) roster.push(maiaBandEntry(level))
  return roster
}

/** Fallback if lib/roster.ts's private-rival participant ever omits a level
 *  (it doesn't today — belt-and-suspenders only). */
const DEFAULT_RIVAL_LEVEL = 1700

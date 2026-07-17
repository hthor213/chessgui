// The Persona Arena lobby's roster (spec 217 Tier 0). DELIBERATELY consumes
// spec 218's source-of-truth files rather than redefining persona identity
// here:
//
//   - lib/persona-manifest.ts's `GM_PERSONAS` — NOT lib/roster.ts's
//     `GM_PERSONA_CONFIGS`/`buildRoster`. That distinction matters and
//     mirrors lib/tournament-roster.ts's exact precedent (see that file's
//     header): lib/roster.ts's honesty gate clamps every GM persona down to
//     an approximate Maia-band label because ITS engine (Play vs Bot's
//     `persona_move`) only best-efforts the BT3 managed net — it falls back
//     to the Maia band when the net is absent (spec 218 follow-up), so that
//     surface may not promise BT3 strength. The arena's backend
//     (spec 217 architecture: "move API wrapping lc0 (Maia nets + BT3)")
//     genuinely does run BT3 for these personas — same capability as the
//     Tournament/Exhibition surface — so the honest label here is the
//     measured harness move-match percentage from persona-manifest.ts, not
//     roster.ts's "approximation" framing. Two surfaces, two honestly
//     different backends, two derived labels from one JSON source.
//   - lib/roster.ts's `initialsFor` for the avatar-monogram fallback (spec
//     217 Tier 0: "initials avatars v1") — reused, not reimplemented.
//
// Tier gating (spec 217 Tiers): Tier 0 shipped the trio (Gudmundur peak,
// Fischer, Kasparov); Tier 1 unlocks "Karpov + more Icelandic GMs" — plus
// Spassky (v1 roster, the strength anchor's chair). Every Tier-1 slug below
// was artifact-verified (config + book present and loadable in
// data/personas, 2026-07-15) before being listed; a manifest persona in
// neither tier still renders greyed "coming soon" rather than hidden — the
// roster is a living museum (spec 217 Cultural context) even before every
// entry is playable.

import { GM_PERSONAS, type GmPersonaManifestEntry } from "@/lib/persona-manifest"
import { initialsFor } from "@/lib/roster"
import type { ArenaPersonaInfo } from "@chessgui/core/arena-api"

/** Tier-0 playable slugs, in the order spec 217 lists them. */
export const TIER0_PERSONA_SLUGS: readonly string[] = [
  "sigurjonsson-peak",
  "fischer",
  "kasparov",
]

/** Tier-1 unlock (spec 217): Karpov, Spassky, then the Icelandic canon in
 *  the spec's own listing order. Server twin: config.py ROSTER_SLUGS. */
export const TIER1_PERSONA_SLUGS: readonly string[] = [
  "karpov",
  "spassky",
  "fridrik-olafsson",
  "margeir-petursson",
  "johann-hjartarson",
  "hannes-stefansson",
  "helgi-olafsson",
  "hedinn-steingrimsson",
  "jon-l-arnason",
]

/** Every unlocked slug, lobby order: Tier 0 first, then Tier 1. */
export const UNLOCKED_PERSONA_SLUGS: readonly string[] = [
  ...TIER0_PERSONA_SLUGS,
  ...TIER1_PERSONA_SLUGS,
]

export interface ArenaRosterEntry {
  slug: string
  displayName: string
  initials: string
  /** Honest strength label (spec 216 hard rule: no unmeasured realism
   *  claims) — the measured held-out move-match rate against the BT3 policy
   *  backend, same basis as the Tournament dropdown's "(BT3, 64% move-match)"
   *  labels (lib/tournament-roster.ts's `gmPersonaEntry`). */
  strengthLabel: string
  /** Tier-0 gate: false renders as "coming soon" in the lobby, never as a
   *  Play button that would silently fail. */
  available: boolean
  /** Spec 217 Promise 1: true for the logged-in player's OWN persona.
   *  Server-gated — this card exists only in its owner's lobby. */
  isPrivate?: boolean
}

function strengthLabelFor(p: GmPersonaManifestEntry): string {
  const pct = Math.round(p.matchAt1 * 100)
  return `BT3 policy — ${pct}% move-match (held-out${p.harnessN ? `, n=${p.harnessN}` : ""})`
}

/**
 * Build the lobby roster: unlocked personas first (Tier 0 then Tier 1, in
 * the spec's listed order), then any other committed GM persona as "coming
 * soon". Pure — no network/Tauri — so it's trivially unit-testable.
 */
export function buildArenaRoster(): ArenaRosterEntry[] {
  const entries = GM_PERSONAS.map(
    (p): ArenaRosterEntry => ({
      slug: p.slug,
      displayName: p.displayName,
      initials: initialsFor(p.displayName),
      strengthLabel: strengthLabelFor(p),
      available: UNLOCKED_PERSONA_SLUGS.includes(p.slug),
    }),
  )
  const rank = (slug: string) => {
    const i = UNLOCKED_PERSONA_SLUGS.indexOf(slug)
    return i === -1 ? UNLOCKED_PERSONA_SLUGS.length : i
  }
  return entries.sort((a, b) => rank(a.slug) - rank(b.slug))
}

/**
 * Merge the backend's per-user persona list (GET /api/personas) into the
 * static manifest roster. GM slugs the manifest already knows keep their
 * measured client-side labels; anything the server adds beyond the manifest
 * is per-user — the player's own private persona (spec 217 Promise 1) —
 * and renders as a playable card with the server's honest label. Private
 * cards lead the lobby (the "play against yourself" hook); any other
 * server-only persona trails it. Pure — no network — so the fetch-failure
 * path (empty `apiPersonas`) trivially degrades to the static roster.
 */
export function mergeApiPersonas(
  roster: ArenaRosterEntry[],
  apiPersonas: ArenaPersonaInfo[],
): ArenaRosterEntry[] {
  const known = new Set(roster.map((e) => e.slug))
  const extras = apiPersonas
    .filter((p) => !known.has(p.slug))
    .map(
      (p): ArenaRosterEntry => ({
        slug: p.slug,
        displayName: p.displayName,
        initials: initialsFor(p.displayName),
        // Server-only personas carry the server's label (spec 216 hard rule:
        // never invent a strength the backend didn't state).
        strengthLabel: p.strengthLabel ?? "unmeasured",
        available: true,
        isPrivate: p.isPrivate,
      }),
    )
  return [
    ...extras.filter((e) => e.isPrivate),
    ...roster,
    ...extras.filter((e) => !e.isPrivate),
  ]
}

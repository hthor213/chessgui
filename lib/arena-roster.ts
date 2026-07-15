// The Persona Arena lobby's roster (spec 217 Tier 0). DELIBERATELY consumes
// spec 218's source-of-truth files rather than redefining persona identity
// here:
//
//   - lib/persona-manifest.ts's `GM_PERSONAS` — NOT lib/roster.ts's
//     `GM_PERSONA_CONFIGS`/`buildRoster`. That distinction matters and
//     mirrors lib/tournament-roster.ts's exact precedent (see that file's
//     header): lib/roster.ts's honesty gate clamps every GM persona down to
//     an approximate Maia-band label because ITS engine (Play vs Bot's
//     `persona_move`) cannot drive the BT3 managed net. The arena's backend
//     (spec 217 architecture: "move API wrapping lc0 (Maia nets + BT3)")
//     genuinely does run BT3 for these personas — same capability as the
//     Tournament/Exhibition surface — so the honest label here is the
//     measured harness move-match percentage from persona-manifest.ts, not
//     roster.ts's "approximation" framing. Two surfaces, two honestly
//     different backends, two derived labels from one JSON source.
//   - lib/roster.ts's `initialsFor` for the avatar-monogram fallback (spec
//     217 Tier 0: "initials avatars v1") — reused, not reimplemented.
//
// Tier-0 gating (spec 217 Tiers: "lobby with 3 personas — Gudmundur peak,
// Fischer, Kasparov"): every other committed GM persona (Karpov, Spassky, the
// Icelandic canon) appears in the lobby greyed "coming soon" rather than
// hidden, per this task's explicit instruction — the roster is a living
// museum (spec 217 Cultural context) even before every entry is playable.

import { GM_PERSONAS, type GmPersonaManifestEntry } from "@/lib/persona-manifest"
import { initialsFor } from "@/lib/roster"

/** Tier-0 playable slugs, in the order spec 217 lists them. */
export const TIER0_PERSONA_SLUGS: readonly string[] = [
  "sigurjonsson-peak",
  "fischer",
  "kasparov",
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
}

function strengthLabelFor(p: GmPersonaManifestEntry): string {
  const pct = Math.round(p.matchAt1 * 100)
  return `BT3 policy — ${pct}% move-match (held-out${p.harnessN ? `, n=${p.harnessN}` : ""})`
}

/**
 * Build the lobby roster: Tier-0 playable personas first (in the spec's
 * listed order), then every other committed GM persona as "coming soon".
 * Pure — no network/Tauri — so it's trivially unit-testable.
 */
export function buildArenaRoster(): ArenaRosterEntry[] {
  const entries = GM_PERSONAS.map(
    (p): ArenaRosterEntry => ({
      slug: p.slug,
      displayName: p.displayName,
      initials: initialsFor(p.displayName),
      strengthLabel: strengthLabelFor(p),
      available: TIER0_PERSONA_SLUGS.includes(p.slug),
    }),
  )
  const rank = (slug: string) => {
    const i = TIER0_PERSONA_SLUGS.indexOf(slug)
    return i === -1 ? TIER0_PERSONA_SLUGS.length : i
  }
  return entries.sort((a, b) => rank(a.slug) - rank(b.slug))
}

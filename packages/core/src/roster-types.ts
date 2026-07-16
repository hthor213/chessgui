// Roster domain types (spec 218) — extracted to @chessgui/core
// (spec 220 step 5).

import type { RivalBook } from "./rival-book-types"

/** The on-disk persona config shape (scripts/persona/build_persona_configs.py)
 *  — only the fields this loader consumes; files carry more (harness numbers,
 *  net pins, extraction provenance). */
export interface PersonaConfigFile {
  slug: string
  display_name: string
  /** "public-figure" (committed GM personas) or "private-rival" (local). */
  kind: string
  /** The persona-engine contract flag: false means "persona_move v1 drives
   *  Maia bands only — this config's real backend is NOT runnable here".
   *  persona_move takes level + tunables from the frontend and cannot
   *  self-gate; the loader owns honesty (gatePersonaLevel below). */
  runnable_in_engine_v1: boolean
  backend?: { kind: string; level?: number }
  sampling: {
    level: number
    temperature?: number
    alpha?: number
    lambda?: number
    top_k?: number
    top_p?: number
    verify_depth?: number
  }
  book?: { path?: string; positions?: number; games?: number }
}

/** A private rival persona as delivered by the `rival_personas` command:
 *  its local config plus its opening book (null when the book file is
 *  missing/unbuilt). Both live in gitignored data/rivals — never bundled. */
export interface LocalRivalPersona {
  config: PersonaConfigFile
  book: RivalBook | null
}

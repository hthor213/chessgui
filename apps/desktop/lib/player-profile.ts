// "Add player profile…" glue (spec 225 Part 1, desktop UI step).
//
// Pure helpers between the platform seam (EngineProvider.playerProfileRun)
// and the add-profile screen — same split as lib/training-measure.ts for the
// monthly pipeline: the component owns state, this module owns parsing and
// messages, so the honest-verdict rendering is unit-testable without Tauri.

import type {
  PlayerProfileFile,
  ProfileRunReport,
  ProfileRunRequest,
} from "@chessgui/core/player-profile-types"
import { isPipelineProfile } from "@/lib/roster"

export type { PlayerProfileFile, ProfileRunReport, ProfileRunRequest }

/**
 * Failure/cancel message for a finished run, or null when the run succeeded
 * with a readable profile record — the caller then parses `profile_json` and
 * shows the verdict instead (measureRunMessage's contract).
 */
export function profileRunMessage(report: ProfileRunReport): string | null {
  if (report.cancelled) return "Profile build cancelled — nothing was written past the artifacts already on disk."
  if (report.exit_code !== 0) {
    return `Profile pipeline failed (exit code ${report.exit_code ?? "?"}) — see the log above.`
  }
  if (!report.profile_json) {
    return "The pipeline finished but its profile record couldn't be read back — check data/rivals."
  }
  return null
}

/** Parse the run's <slug>.profile.json text. Throws a plain-language message
 *  (shown verbatim) when the record isn't a pipeline profile. */
export function parseProfileJson(text: string): PlayerProfileFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error("The profile record isn't valid JSON.")
  }
  if (!isPipelineProfile(data)) {
    throw new Error("The profile record is missing its sample verdict — not a pipeline profile.")
  }
  return data
}

/** The artifacts a finished profile actually produced, as display rows —
 *  read from the STORED record (never guessed from the inputs). */
export function artifactRows(profile: PlayerProfileFile): { label: string; path: string }[] {
  const a = profile.artifacts
  if (!a) return []
  const rows: { label: string; key: keyof NonNullable<PlayerProfileFile["artifacts"]> }[] = [
    { label: "Corpus (PGN)", key: "pgn" },
    { label: "Provenance", key: "sources_md" },
    { label: "Stats dossier", key: "stats" },
    { label: "Opening book", key: "book" },
    { label: "Persona config", key: "config" },
  ]
  return rows.flatMap((r) => {
    const path = a[r.key]
    return path ? [{ label: r.label, path }] : []
  })
}

/** Can this request run at all? Name plus at least one game source — FIDE ID
 *  is identity metadata only (FIDE publishes no game archive). */
export function canRunProfile(req: ProfileRunRequest): boolean {
  const has = (s?: string) => !!s && s.trim() !== ""
  return has(req.name) && (has(req.chesscom) || has(req.lichess) || (req.pgns ?? []).length > 0)
}

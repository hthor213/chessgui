// Persona Arena disclosure (spec 217 Transparency, wording decided
// 2026-07-15). Shown once before a player's first game.
//
// Per the spec's explicit user decision this is NOT consent paperwork ("no
// consent paperwork — this is an app for the user, then dad... A formal ToU
// is deliberately deferred"), so acknowledgement is a plain client-side
// localStorage flag, not a server-recorded consent record. A formal ToU only
// becomes a question if the app is ever published beyond family (spec 217).

/** The family sticker, near-verbatim (spec 217 Transparency — do not reword). */
export const ARENA_DISCLOSURE_TEXT =
  "note: your son may use your games — study them in order to try to beat you in chess at Christmas."

/** The tournament-chess-norm addendum from the same spec paragraph. */
export const ARENA_DISCLOSURE_NOTE = "(Tournament-chess norm: moves are recorded.)"

import { getProviders } from "@/lib/platform"

const STORAGE_KEY = "arena-disclosure-acked"

/** Whether this browser has already seen and acknowledged the disclosure.
 *  False (not an error) on the server, in a fresh browser, or if
 *  storage is unavailable (StorageProvider returns null then) — the safe
 *  failure direction for a disclosure is to show it again, never to skip it. */
export function hasAckedDisclosure(): boolean {
  return getProviders().storage.get(STORAGE_KEY) === "1"
}

export function ackDisclosure(): void {
  // Storage unavailable — the screen simply reappears next load.
  getProviders().storage.set(STORAGE_KEY, "1")
}

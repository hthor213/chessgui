// Native file-open dialog seam (spec 220 step 1 — the DialogProvider seed).
// Components call pickFile(); only this module may touch
// @tauri-apps/plugin-dialog. Off-Tauri it resolves null (cancelled) — the web
// shell supplies a real browser implementation when the providers are
// formalized in spec 220 step 2.

export interface PickFileOptions {
  /** Window title for the picker. */
  title?: string
  /** Extension filters, e.g. [{ name: "PGN", extensions: ["pgn"] }]. */
  filters?: { name: string; extensions: string[] }[]
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

/**
 * Open a native single-file picker. Resolves the absolute filesystem path,
 * or null when the user cancelled or no native picker exists on this shell.
 */
export async function pickFile(options: PickFileOptions = {}): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import("@tauri-apps/plugin-dialog")
  const picked = await open({ multiple: false, directory: false, ...options })
  return typeof picked === "string" && picked ? picked : null
}

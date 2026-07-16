// File-dialog facade (spec 220: DialogProvider, seeded in step 1,
// provider-backed since step 2). Components call these; the platform
// plugin import lives in lib/platform/tauri.ts, and the browser provider
// covers each contract honestly: pickFile resolves null (no native picker,
// callers fall back to <input type=file>), openTextFile drives a
// programmatic file input, saveTextFile downloads a Blob (spec 013).

import { getProviders, type PickFileOptions } from "@/lib/platform"
import type {
  OpenedTextFile,
  SaveTextFileOptions,
  SaveTextFileResult,
} from "@chessgui/core/platform-types"

export type { OpenedTextFile, PickFileOptions, SaveTextFileOptions, SaveTextFileResult }

/**
 * Open a native single-file picker. Resolves the absolute filesystem path,
 * or null when the user cancelled or no native picker exists on this shell.
 */
export async function pickFile(options: PickFileOptions = {}): Promise<string | null> {
  return getProviders().dialog.pickFile(options)
}

/**
 * Open a text file and return its contents (spec 013 PGN import). Native
 * picker + Rust read on desktop, programmatic <input type=file> in the
 * browser. Null means the user cancelled — there is no unsupported case.
 */
export async function openTextFile(
  options: PickFileOptions = {},
): Promise<OpenedTextFile | null> {
  return getProviders().dialog.openTextFile(options)
}

/**
 * Save text to a user-chosen destination (spec 013 PGN export). Native save
 * dialog + Rust write on desktop, Blob download in the browser. saved:false
 * means the user cancelled the native dialog.
 */
export async function saveTextFile(options: SaveTextFileOptions): Promise<SaveTextFileResult> {
  return getProviders().dialog.saveTextFile(options)
}

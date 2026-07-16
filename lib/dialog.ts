// Native file-open dialog facade (spec 220: DialogProvider, seeded in step 1,
// provider-backed since step 2). Components call pickFile(); the platform
// plugin import lives in lib/platform/tauri.ts, and the browser provider
// resolves null (no native picker) so callers fall back to <input type=file>.

import { getProviders, type PickFileOptions } from "@/lib/platform"

export type { PickFileOptions }

/**
 * Open a native single-file picker. Resolves the absolute filesystem path,
 * or null when the user cancelled or no native picker exists on this shell.
 */
export async function pickFile(options: PickFileOptions = {}): Promise<string | null> {
  return getProviders().dialog.pickFile(options)
}

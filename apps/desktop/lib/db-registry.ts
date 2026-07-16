// Multi-database registry (spec 200: "Multiple databases can be open
// simultaneously" — the backend's DbManager already keeps one connection per
// path; this is the UI-side list of databases the user has opened, persisted
// so the switcher survives restarts).
//
// The default database (games.db in the app data dir) is represented by
// `undefined` and is always available; the registry stores only extra paths.

import { getProviders } from "@/lib/platform"

const STORAGE_KEY = "chessgui-db-registry"
const MAX_ENTRIES = 12

/** Pure: add a path to the front of the list, deduped, capped. */
export function addDbPath(list: string[], path: string): string[] {
  const next = [path, ...list.filter((p) => p !== path)]
  return next.slice(0, MAX_ENTRIES)
}

/** Short display name for a database path (its file name). */
export function dbDisplayName(path: string | undefined): string {
  if (!path) return "Default"
  const base = path.split("/").pop() ?? path
  return base
}

export function loadDbPaths(): string[] {
  try {
    const raw = getProviders().storage.get(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : []
  } catch {
    return []
  }
}

export function saveDbPaths(list: string[]): void {
  // StorageProvider absorbs unavailability — the list just won't persist.
  getProviders().storage.set(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)))
}

// localStorage-backed StorageProvider (spec 220 step 2). Both current shells
// (Tauri webview and plain browser) persist settings the same way, so they
// share this implementation; a shell without reliable localStorage (mobile
// WebViews, spec 223) registers its own instead of praying.

import type { StorageProvider } from "./types"

export const localStorageKV: StorageProvider = {
  get(key: string): string | null {
    if (typeof window === "undefined") return null
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {
      // storage unavailable — the value just won't persist
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key)
    } catch {
      // ignore
    }
  },
}

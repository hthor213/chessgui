"use client"

// Service-worker registration (spec 223) — web shell only; the desktop
// shell serves from tauri:// and neither needs nor supports a SW. Skipped
// in dev: a caching worker on localhost makes hot-reload debugging lie.

import { useEffect } from "react"

export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return
    if (!("serviceWorker" in navigator)) return
    navigator.serviceWorker
      .register(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/sw.js`)
      .catch(() => {
        // Offline shell is progressive enhancement — a failed registration
        // (private mode, unsupported browser) must never break the app.
      })
  }, [])
  return null
}

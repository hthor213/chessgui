// Browser Clipboard-API readers shared by both DialogProvider implementations
// (spec 220 step 2): the browser stub uses them directly; TauriProviders falls
// back to them when the native clipboard plugin has no matching content —
// preserving the dual-path behavior lib/recognize-position.ts always had.

import type { ClipboardImage } from "@/lib/recognize-position"

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(",")[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** Read an image via the browser Clipboard API; null when there is none or
 *  the API is unavailable / permission-denied. */
export async function readBrowserClipboardImage(): Promise<ClipboardImage | null> {
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"))
      if (!type) continue
      const blob = await item.getType(type)
      return { base64: await blobToBase64(blob), mediaType: type }
    }
  } catch {
    // Clipboard API unavailable or permission denied.
  }
  return null
}

/** Read non-empty text via the browser Clipboard API; null when there is none. */
export async function readBrowserClipboardText(): Promise<string | null> {
  try {
    const text = await navigator.clipboard.readText()
    if (text && text.trim()) return text
  } catch {
    // Clipboard API unavailable or permission denied.
  }
  return null
}

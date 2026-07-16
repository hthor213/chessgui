// Engine session ids (spec 900 multi-engine comparison). The desktop shell's
// Rust UCI manager keys engine processes by session id so two engines can
// analyze the same position side by side; each session's stdout arrives on
// its own event. This module is the TS mirror of the id/event rules in
// src-tauri/src/uci.rs (`session_key` / `output_event`) — keep them in sync.

/** The untagged callers' session: the main analysis engine. Pre-900 behavior
 *  (one engine, the `engine-output` event) is exactly this session. */
export const DEFAULT_ENGINE_SESSION = "default"

/** The comparison panel's second-engine session (spec 900). */
export const COMPARE_ENGINE_SESSION = "compare"

/**
 * Whether an id is safe to embed in a per-session Tauri event name (which
 * only allows alphanumeric + `-` `/` `:` `_`; we stay stricter). Mirrors
 * uci.rs `session_key`'s acceptance rule.
 */
export function isValidEngineSessionId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id)
}

/**
 * The stdout event a session's lines arrive on. The default session keeps
 * the historical `engine-output` name verbatim so pre-900 listeners stay
 * untouched; any other session gets `engine-output:<id>`. Mirrors uci.rs
 * `output_event`.
 */
export function engineOutputEvent(sessionId?: string): string {
  if (!sessionId || sessionId === DEFAULT_ENGINE_SESSION) return "engine-output"
  return `engine-output:${sessionId}`
}

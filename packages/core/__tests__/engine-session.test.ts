import { describe, it, expect } from "vitest"
import {
  COMPARE_ENGINE_SESSION,
  DEFAULT_ENGINE_SESSION,
  engineOutputEvent,
  isValidEngineSessionId,
} from "@chessgui/core/engine-session"

// Spec 900 session plumbing. These pin the TS mirror of uci.rs's
// `session_key`/`output_event` — if either side changes, a session's lines
// would silently land on an event nobody listens to.
describe("engine sessions (spec 900 multi-engine comparison)", () => {
  it("keeps the pre-900 event name for the default session", () => {
    // Verbatim: existing listeners (main analysis engine) must not move.
    expect(engineOutputEvent()).toBe("engine-output")
    expect(engineOutputEvent(undefined)).toBe("engine-output")
    expect(engineOutputEvent(DEFAULT_ENGINE_SESSION)).toBe("engine-output")
  })

  it("gives every other session its own suffixed event", () => {
    expect(engineOutputEvent(COMPARE_ENGINE_SESSION)).toBe("engine-output:compare")
    expect(engineOutputEvent("engine_2")).toBe("engine-output:engine_2")
  })

  it("accepts the ids the Rust side accepts", () => {
    expect(isValidEngineSessionId(DEFAULT_ENGINE_SESSION)).toBe(true)
    expect(isValidEngineSessionId(COMPARE_ENGINE_SESSION)).toBe(true)
    expect(isValidEngineSessionId("a-b_3")).toBe(true)
    expect(isValidEngineSessionId("x".repeat(64))).toBe(true)
  })

  it("refuses ids unsafe for Tauri event names (mirrors uci.rs session_key)", () => {
    expect(isValidEngineSessionId("")).toBe(false)
    expect(isValidEngineSessionId("has space")).toBe(false)
    expect(isValidEngineSessionId("semi;colon")).toBe(false)
    expect(isValidEngineSessionId("colon:inside")).toBe(false)
    expect(isValidEngineSessionId("x".repeat(65))).toBe(false)
  })
})

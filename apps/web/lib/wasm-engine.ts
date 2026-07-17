// Browser EngineProvider engine half (spec 221 "Engine: hybrid"): stockfish
// WASM (lila-stockfish-web, sf16-7 build) in a module Worker, speaking the
// same UCI line protocol the desktop shell gets from Tauri's engine-output
// event — hooks/use-engine.ts's debounce/pace logic is untouched.
//
// The worker is a static file (public/engine/sf-worker.js), NOT a bundled
// module: the emscripten glue resolves its .wasm and its pthread helper
// workers relative to import.meta.url, which webpack rewriting would break.
// scripts/prepare-engine.mjs stages the glue + wasm + NNUE net next to it.

import type { EngineStartResult } from "@chessgui/core/platform-types"

/** Sentinel "path" for the WASM engine — shown where the desktop shell shows
 *  the engine binary path; startWasmEngine ignores it. */
export const WASM_ENGINE_PATH = "wasm:sf16-7"

/**
 * Multi-threaded stockfish WASM needs SharedArrayBuffer, which needs the
 * COOP/COEP headers of spec 221. Without them (bare file server, dev server)
 * the engine is honestly unavailable and the shell boots without it.
 */
export function wasmEngineAvailable(): boolean {
  return typeof window !== "undefined" && typeof SharedArrayBuffer !== "undefined"
}

type WorkerMsg =
  | { type: "line"; line: string }
  | { type: "ready" }
  | { type: "error"; text: string }

const listeners = new Set<(line: string) => void>()
let worker: Worker | null = null

function emit(line: string): void {
  for (const fn of listeners) fn(line)
}

/** Subscribe to the engine's output line stream. Registration is independent
 *  of engine lifetime (use-engine subscribes on mount, before any start). */
export async function onWasmEngineLine(onLine: (line: string) => void): Promise<() => void> {
  listeners.add(onLine)
  return () => {
    listeners.delete(onLine)
  }
}

export async function sendWasmCommand(command: string): Promise<void> {
  // Silently dropped when nothing is running — commands racing an unmount's
  // stopEngine are expected, same contract as the browser stub's no-ops.
  worker?.postMessage({ type: "uci", command })
}

export async function stopWasmEngine(): Promise<void> {
  if (!worker) return
  const w = worker
  worker = null
  // Best-effort clean shutdown, then hard-kill. Terminating the parent
  // worker also tears down the pthread helper workers it spawned.
  w.postMessage({ type: "uci", command: "quit" })
  w.terminate()
}

// `chess960` (spec 011): assert UCI_Chess960 right after the handshake —
// before any position/go — because a 960 game's castling moves ride as
// king-takes-rook UCI, which stockfish only parses with the option set.
export async function startWasmEngine(chess960 = false): Promise<EngineStartResult> {
  if (!wasmEngineAvailable()) {
    throw new Error(
      "Engine unavailable: this page is not cross-origin isolated, so " +
        "stockfish WASM cannot run (SharedArrayBuffer requires the COOP/COEP " +
        "headers of spec 221 — analysis works on the deployed site and in the desktop app)",
    )
  }
  await stopWasmEngine() // start-over-running restarts, like the desktop shell

  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? ""
  const w = new Worker(`${base}/engine/sf-worker.js`, { type: "module" })
  worker = w

  let engineName = "Stockfish (WASM)"
  let onHandshakeLine: ((line: string) => void) | null = null
  let resolveBoot: (() => void) | null = null
  let rejectBoot: ((err: Error) => void) | null = null

  w.onerror = (e) => {
    rejectBoot?.(new Error(e.message || "Engine worker failed to load"))
  }
  w.onmessage = (e: MessageEvent<WorkerMsg>) => {
    const msg = e.data
    if (msg.type === "line") {
      onHandshakeLine?.(msg.line)
      emit(msg.line)
    } else if (msg.type === "ready") {
      resolveBoot?.()
    } else if (msg.type === "error") {
      // Boot failures reject startEngine; later errors just get logged (the
      // stream consumers treat silence as "search over", nothing to unwedge).
      rejectBoot?.(new Error(msg.text))
      console.error("[wasm-engine]", msg.text)
    }
  }

  try {
    // Phase 1 — worker boots the module and loads the NNUE net.
    await new Promise<void>((resolve, reject) => {
      resolveBoot = resolve
      rejectBoot = reject
      w.postMessage({ type: "start" })
    })
    // Phase 2 — the uci handshake for the engine name, mirroring the desktop
    // Rust side. Handshake lines also reach subscribers; the parser ignores them.
    await new Promise<void>((resolve, reject) => {
      rejectBoot = reject // an engine error mid-handshake must not hang the start
      onHandshakeLine = (line) => {
        if (line.startsWith("id name ")) engineName = line.slice("id name ".length)
        if (line === "uciok") {
          onHandshakeLine = null
          resolve()
        }
      }
      w.postMessage({ type: "uci", command: "uci" })
    })
  } catch (err) {
    await stopWasmEngine()
    throw err
  } finally {
    resolveBoot = null
    rejectBoot = null
  }

  // Post-handshake, pre-search startup option (mirrors the desktop Rust
  // side's startup_option_commands). Absent = the engine default, false.
  if (chess960) {
    w.postMessage({ type: "uci", command: "setoption name UCI_Chess960 value true" })
  }

  return { name: engineName, ready: true }
}

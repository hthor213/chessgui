// Stockfish WASM host worker (spec 221). Served as a static file so the
// emscripten glue (./sf16-7.js, staged by scripts/prepare-engine.mjs) can
// resolve its .wasm and spawn its pthread helper workers relative to its own
// URL — bundling would break both. Protocol with lib/wasm-engine.ts:
//   in:  { type: "start" } | { type: "uci", command: string }
//   out: { type: "ready" } | { type: "line", line: string }
//        | { type: "error", text: string }

let sf = null
const queued = [] // uci commands arriving while the module still boots

async function start() {
  const mod = await import("./sf16-7.js")
  const instance = await mod.default({})
  instance.listen = (line) => self.postMessage({ type: "line", line })
  instance.onError = (text) => self.postMessage({ type: "error", text })

  // The build carries no embedded net — fetch the one it asks for from the
  // same directory (staged at build time; lazy, so first analysis pays it
  // once and HTTP caching covers the rest — spec 221 "NNUE nets lazy-load").
  const nnue = instance.getRecommendedNnue()
  const res = await fetch(new URL(nnue, import.meta.url))
  if (!res.ok) throw new Error(`NNUE net ${nnue} missing (HTTP ${res.status})`)
  instance.setNnueBuffer(new Uint8Array(await res.arrayBuffer()))

  sf = instance
  for (const command of queued.splice(0)) sf.uci(command)
  self.postMessage({ type: "ready" })
}

self.onmessage = (e) => {
  const msg = e.data
  if (msg.type === "start") {
    start().catch((err) => {
      self.postMessage({ type: "error", text: String(err?.message ?? err) })
    })
  } else if (msg.type === "uci") {
    if (sf) sf.uci(msg.command)
    else queued.push(msg.command)
  }
}

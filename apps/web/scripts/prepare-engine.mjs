// Stages the WASM engine's static assets into public/engine/ (spec 221):
// the lila-stockfish-web glue + wasm are copied out of node_modules (they
// must sit next to public/engine/sf-worker.js — the glue resolves its wasm
// and pthread workers relative to its own URL), and the NNUE net is
// downloaded once and cached (gitignored, like engines/). Runs before every
// build/dev via the package scripts; all steps are idempotent.

import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "..", "public", "engine")
const pkgDir = dirname(createRequire(import.meta.url).resolve("lila-stockfish-web/package.json"))

// The sf16-7 build's net (pinned from lila-stockfish-web's README; if a
// package bump changes it, the worker's fetch 404s with the new name in the
// error and this constant is the one place to update).
const NNUE = "nn-ecb35f70ff2a.nnue"
const NNUE_URL = `https://tests.stockfishchess.org/api/nn/${NNUE}`

mkdirSync(outDir, { recursive: true })

for (const file of ["sf16-7.js", "sf16-7.wasm"]) {
  copyFileSync(join(pkgDir, file), join(outDir, file))
}

const nnuePath = join(outDir, NNUE)
if (!existsSync(nnuePath)) {
  console.log(`[prepare-engine] downloading ${NNUE_URL} ...`)
  const res = await fetch(NNUE_URL)
  if (!res.ok) throw new Error(`NNUE download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  // Write-then-rename so an interrupted download never leaves a truncated
  // net behind for the existsSync check to trust.
  writeFileSync(`${nnuePath}.part`, buf)
  renameSync(`${nnuePath}.part`, nnuePath)
  console.log(`[prepare-engine] saved ${NNUE} (${(buf.length / 1e6).toFixed(1)} MB)`)
} else {
  console.log(`[prepare-engine] ${NNUE} already present (${(statSync(nnuePath).size / 1e6).toFixed(1)} MB)`)
}

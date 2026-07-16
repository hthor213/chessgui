// The "no Tauri deps" gate of spec 220 step 8 / spec 221, enforced instead
// of trusted: fails the build if anything Tauri-shaped reaches this shell.
// Two checks — the dependency manifest (no @tauri-apps/* may ever be
// declared here) and the built bundle (no Tauri module specifier or IPC
// global survived into the JS actually shipped to browsers).

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const failures = []

const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"))
for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
  for (const name of Object.keys(pkg[section] ?? {})) {
    if (name.startsWith("@tauri-apps/")) failures.push(`package.json ${section}: ${name}`)
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}

// __TAURI_INTERNALS__ is the IPC global the desktop shell's isTauri() sniffs
// for; its presence would mean the desktop provider registry got bundled.
const needles = ["@tauri-apps/", "__TAURI_INTERNALS__"]
const bundleDir = join(appDir, "dist", "_next")
for (const path of walk(bundleDir)) {
  if (!/\.(js|mjs)$/.test(path)) continue
  const text = readFileSync(path, "utf8")
  for (const needle of needles) {
    if (text.includes(needle)) failures.push(`${path.slice(appDir.length + 1)}: contains "${needle}"`)
  }
}

if (failures.length > 0) {
  console.error("[check-no-tauri] FAILED — Tauri leaked into the web shell:")
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
console.log("[check-no-tauri] OK — no @tauri-apps deps, bundle is Tauri-free")

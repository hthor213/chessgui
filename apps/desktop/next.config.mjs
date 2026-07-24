import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
const gitHash = (() => {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim()
  } catch {
    return "dev"
  }
})()
// "-dirty" when TRACKED files differ from HEAD — i.e. the build carries
// uncommitted code, which is exactly why the hash can look unchanged across
// two different builds. Untracked files are excluded on purpose: the repo
// always has untracked persona data, and counting it would pin "-dirty" on.
const dirty = (() => {
  try {
    return execSync("git status --porcelain --untracked-files=no").toString().trim().length > 0
      ? "-dirty"
      : ""
  } catch {
    return ""
  }
})()
// Full timestamp (to the second), so every build is visibly distinct even when
// the commit has not moved — the answer to "did it actually rebuild?".
const buildStamp = new Date().toISOString().slice(0, 19).replace("T", " ")

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  distDir: 'dist',
  images: { unoptimized: true },
  env: {
    // Shown in the header so you can tell which build is running.
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_BUILD_INFO: `${gitHash}${dirty} · ${buildStamp}`,
  },
}
export default nextConfig

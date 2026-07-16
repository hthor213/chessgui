import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"

// Git-info shell-out duplicated per shell by design (spec 220 step 7 note).
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
const gitHash = (() => {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim()
  } catch {
    return "dev"
  }
})()
const buildDate = new Date().toISOString().slice(0, 10)

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export is the portability contract for every shell (spec 220
  // "Risks"): no API routes, no server components doing IO, ever.
  output: 'export',
  distDir: 'dist',
  // Served at https://www.spliffdonk.com/chess behind Caddy (spec 221:
  // assets/links emit as /chess/...; Caddy strips the prefix).
  basePath: '/chess',
  images: { unoptimized: true },
  env: {
    // Shown in the header so you can tell which build is running.
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_BUILD_INFO: `${gitHash} ${buildDate}`,
  },
}
export default nextConfig

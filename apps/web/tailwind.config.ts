import type { Config } from "tailwindcss"
import preset from "@chessgui/ui/tailwind-preset"

// All theme tokens live in the shared preset (spec:220) — a shell may not
// declare a color, piece asset, or board style locally. Content globs reach
// into apps/desktop because the shared lib/hooks surface still physically
// lives there (see lib/platform.ts for the seam note).
const config: Config = {
  presets: [preset as Config],
  content: [
    "./app/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "../desktop/app/**/*.{ts,tsx}",
    "../desktop/hooks/**/*.{ts,tsx}",
    "../desktop/lib/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
}
export default config

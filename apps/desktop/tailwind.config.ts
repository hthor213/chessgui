import type { Config } from "tailwindcss"
import preset from "@chessgui/ui/tailwind-preset"

// All theme tokens live in the shared preset (spec:220) — a shell may not
// declare a color, piece asset, or board style locally.
const config: Config = {
  presets: [preset as Config],
  content: [
    "./app/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
}
export default config

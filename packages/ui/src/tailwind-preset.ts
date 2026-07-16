import type { Config } from "tailwindcss"
import plugin from "tailwindcss/plugin"

/**
 * Single-source app theme tokens (spec:220). Shells extend this preset and
 * MUST NOT declare colors locally — a shell-specific look becomes a variable
 * here, so one token change reaches every client.
 *
 * Values are space-separated RGB triplets so Tailwind's `<alpha-value>` slot
 * keeps opacity modifiers (e.g. `bg-secondary/40`) working.
 */
const tokens: Record<string, string> = {
  "--background": "10 10 10", // #0a0a0a
  "--foreground": "246 246 246", // #f6f6f6
  "--card": "30 28 25", // #1e1c19
  "--card-foreground": "186 186 186", // #bababa
  "--secondary": "42 40 37", // #2a2825
  "--secondary-foreground": "186 186 186", // #bababa
  "--muted": "42 40 37", // #2a2825
  // Lightened from #666666 — that was too dark to read on the near-black
  // background (e.g. the "Draws" label and other secondary text).
  "--muted-foreground": "155 155 155", // #9b9b9b
  "--accent": "119 149 86", // #779556
  "--accent-foreground": "255 255 255", // #ffffff
  "--border": "42 40 37", // #2a2825
  "--input": "42 40 37", // #2a2825
  "--ring": "119 149 86", // #779556
  "--destructive": "224 85 85", // #e05555
  "--destructive-foreground": "255 255 255", // #ffffff
  "--primary": "127 186 58", // #7fba3a
  "--primary-foreground": "255 255 255", // #ffffff
  "--popover": "30 28 25", // #1e1c19
  "--popover-foreground": "186 186 186", // #bababa
}

const rgb = (name: string) => `rgb(var(${name}) / <alpha-value>)`

const preset: Partial<Config> = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: rgb("--background"),
        foreground: rgb("--foreground"),
        card: {
          DEFAULT: rgb("--card"),
          foreground: rgb("--card-foreground"),
        },
        secondary: {
          DEFAULT: rgb("--secondary"),
          foreground: rgb("--secondary-foreground"),
        },
        muted: {
          DEFAULT: rgb("--muted"),
          foreground: rgb("--muted-foreground"),
        },
        accent: {
          DEFAULT: rgb("--accent"),
          foreground: rgb("--accent-foreground"),
        },
        border: rgb("--border"),
        input: rgb("--input"),
        ring: rgb("--ring"),
        destructive: {
          DEFAULT: rgb("--destructive"),
          foreground: rgb("--destructive-foreground"),
        },
        primary: {
          DEFAULT: rgb("--primary"),
          foreground: rgb("--primary-foreground"),
        },
        popover: {
          DEFAULT: rgb("--popover"),
          foreground: rgb("--popover-foreground"),
        },
      },
      borderRadius: {
        lg: "0.5rem",
        md: "calc(0.5rem - 2px)",
        sm: "calc(0.5rem - 4px)",
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({ ":root": tokens })
    }),
  ],
}

export default preset

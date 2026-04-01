import type { Config } from "tailwindcss"

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#0a0a0a",
        foreground: "#f6f6f6",
        card: {
          DEFAULT: "#1e1c19",
          foreground: "#bababa",
        },
        secondary: {
          DEFAULT: "#2a2825",
          foreground: "#bababa",
        },
        muted: {
          DEFAULT: "#2a2825",
          foreground: "#666666",
        },
        accent: {
          DEFAULT: "#779556",
          foreground: "#ffffff",
        },
        border: "#2a2825",
        input: "#2a2825",
        ring: "#779556",
        destructive: {
          DEFAULT: "#e05555",
          foreground: "#ffffff",
        },
        primary: {
          DEFAULT: "#7fba3a",
          foreground: "#ffffff",
        },
        popover: {
          DEFAULT: "#1e1c19",
          foreground: "#bababa",
        },
      },
      borderRadius: {
        lg: "0.5rem",
        md: "calc(0.5rem - 2px)",
        sm: "calc(0.5rem - 4px)",
      },
    },
  },
  plugins: [],
}
export default config

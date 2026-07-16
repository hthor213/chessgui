import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: [
      "apps/desktop/__tests__/**/*.test.ts",
      "packages/core/__tests__/**/*.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@chessgui/core": path.resolve(__dirname, "packages/core/src"),
      "@chessgui/ui": path.resolve(__dirname, "packages/ui/src"),
      // Order matters: prefix matches are tried in insertion order, so the
      // repo-root data alias must precede the shell-root "@" catch-all.
      "@/data": path.resolve(__dirname, "data"),
      "@": path.resolve(__dirname, "apps/desktop"),
    },
  },
});

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: [
      "__tests__/**/*.test.ts",
      "packages/core/__tests__/**/*.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@chessgui/core": path.resolve(__dirname, "packages/core/src"),
      "@chessgui/ui": path.resolve(__dirname, "packages/ui/src"),
      "@": path.resolve(__dirname, "."),
    },
  },
});

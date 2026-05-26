import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}", "server/**/*.{test,spec}.{ts,tsx}", "electron/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["server/**/*.ts"],
      exclude: ["server/scripts/**", "server/__tests__/**"],
      thresholds: {
        lines: 50,
      },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});

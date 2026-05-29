import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { visualizer } from "rollup-plugin-visualizer";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
    mode === "analyze" && visualizer({ open: true, gzipSize: true, brotliSize: true }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          // Shiki ships per-language grammars that Rollup splits into
          // individual lazy chunks; leave them alone so they aren't merged
          // into one oversized bundle.
          if (id.includes("@shikijs/langs") || id.includes("shiki/dist/langs"))
            return;
          const parts = id.split("node_modules/").pop()!.split("/");
          const pkg = parts[0].startsWith("@")
            ? `${parts[0]}/${parts[1]}`
            : parts[0];
          return `vendor-${pkg.replace("@", "").replace("/", "-")}`;
        },
      },
    },
  },
}));

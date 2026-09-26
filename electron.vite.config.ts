import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react-swc'
import { shoelaceAssetsPlugin } from './vite-plugin-shoelace-assets'

// Bake build-time secrets into the main process bundle.
// CLOUDCHAT_UPDATE_TOKEN is a fine-grained read-only PAT with `contents: read`
// scope on the cloud-chat-hub repo, used by electron-updater to fetch releases
// from the private repository. Injected by the GitHub Actions release workflow.
const buildTimeDefines = {
  'process.env.CLOUDCHAT_UPDATE_TOKEN': JSON.stringify(process.env.CLOUDCHAT_UPDATE_TOKEN || '')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: buildTimeDefines,
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/index.ts')
      },
      rollupOptions: {
        // Externalize server code so it loads at runtime from the packaged app
        external: [
          'electron', 'express', 'cors', '@ai-sdk/openai', '@ai-sdk/anthropic', 'ai', 'zod', 'node-pty'
        ]
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/preload.ts'),
        // Sandboxed preload scripts can't run ESM — always emit CommonJS.
        // With "type": "module" in package.json, Vite names the output
        // preload.cjs (unambiguous CJS regardless of package type).
        formats: ['cjs'],
      },
    },
  },
  renderer: {
    root: '.',
    // Dedicated port so the electron dev renderer never collides with other
    // projects' vite servers on the default 5173 — a collision shifts the
    // renderer to a random port and breaks the server's CORS allowlist.
    // strictPort: fail loudly instead of silently drifting.
    server: {
      port: 5175,
      strictPort: true
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html')
      }
    },
    plugins: [react(), shoelaceAssetsPlugin()],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src')
      }
    }
    // Note: PostCSS/Tailwind auto-discovered from project root
    // lovable-tagger intentionally omitted — dev convenience for web workflow only
  }
})

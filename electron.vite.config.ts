import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Externalize server code so it loads at runtime from the packaged app
        external: [
          'express', 'cors', '@ai-sdk/openai', '@ai-sdk/anthropic', 'ai', 'zod',
          /\.\.\/server\/.*/
        ]
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: '.',
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html')
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src')
      }
    }
    // Note: PostCSS/Tailwind auto-discovered from project root
    // lovable-tagger intentionally omitted — dev convenience for web workflow only
  }
})

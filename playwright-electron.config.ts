import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // screenshots.spec.ts is a manual README-asset generator (needs a fresh build
  // + seeds demo data), not a CI test — run it explicitly by path.
  testIgnore: '**/screenshots.spec.ts',
  timeout: 60_000,
  retries: 1,
  workers: 1, // Electron tests must run serially
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'e2e-results' }],
  ],
  use: {
    trace: 'on',
    screenshot: 'on',
  },
})

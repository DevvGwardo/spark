import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // These are manual asset/verification generators (need a fresh build + seeded
  // or mocked data), not CI tests — run them explicitly by path.
  testIgnore: ['**/screenshots.spec.ts', '**/cron-deployments.spec.ts'],
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

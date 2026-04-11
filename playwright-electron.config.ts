import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  retries: 0,
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

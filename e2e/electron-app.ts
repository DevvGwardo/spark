/**
 * Electron app launcher helper for Playwright E2E tests.
 * Launches the built Electron app and exposes the main window.
 */
import { ElectronApplication, Page, _electron as electron } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface ElectronAppFixture {
  app: ElectronApplication
  window: Page
  close: () => Promise<void>
}

/**
 * Launch the built Electron app for testing.
 * Run `npx electron-vite build` first to produce out/main/index.js
 */
export async function launchElectronApp(): Promise<ElectronAppFixture> {
  const mainEntry = path.resolve(__dirname, '../out/main/index.js')

  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ELECTRON_IS_DEV: '0',
      ELECTRON_DISABLE_GPU: '1',
    },
    timeout: 30_000,
  })

  // Wait for the main window
  const window = await app.firstWindow({ timeout: 30_000 })
  await window.waitForLoadState('domcontentloaded')

  return {
    app,
    window,
    async close() {
      try { await app.close() } catch { /* already gone */ }
    },
  }
}

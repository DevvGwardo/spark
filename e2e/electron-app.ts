/**
 * Electron app launcher helper for Playwright E2E tests.
 * Launches the built Electron app and exposes the main window.
 *
 * Every launch is isolated from the developer's real profile:
 *  - a throwaway `--user-data-dir` is created per launch, so setup state,
 *    conversations, and API keys from the real profile can never leak into
 *    (or corrupt) test results;
 *  - first-run setup is marked complete so specs exercise the real main UI
 *    instead of the onboarding wizard.
 *
 * The fixture also records renderer errors and the main-document CSP header
 * from the very first load, so specs can assert on them deterministically
 * instead of attaching listeners late or sleeping.
 */
import { ElectronApplication, Page, _electron as electron } from '@playwright/test'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Shape of the preload bridge (`window.electronAPI`) exposed by
 * src/preload/index.ts. Shared by all specs that evaluate against it.
 *
 * `browser`/`terminal` themselves are optional (a browser-only build might not
 * expose them), but once present their methods are always defined — the
 * preload exposes the full set, which the app-basics spec asserts.
 */
export interface ElectronAPI {
  apiPort?: number
  versions?: { electron?: string; node?: string; chrome?: string }
  platform?: string
  browser?: {
    create: (...a: unknown[]) => unknown
    navigate: (...a: unknown[]) => unknown
    close: () => unknown
    resize: (...a: unknown[]) => unknown
    show: () => unknown
    hide: () => unknown
    goBack: () => unknown
    goForward: () => unknown
    reload: () => unknown
    getUrl: () => unknown
    findInPage: (query: string, options?: { forward?: boolean; findNext?: boolean }) => unknown
    stopFindInPage: (action?: 'clearSelection' | 'keepSelection') => unknown
    onFoundInPage: (
      cb: (r: { requestId: number; activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void,
    ) => () => void
  }
  terminal?: {
    spawn: (...a: unknown[]) => unknown
    write: (...a: unknown[]) => unknown
    resize: (...a: unknown[]) => unknown
    kill: () => unknown
    onData: (...a: unknown[]) => unknown
    onExit: (...a: unknown[]) => unknown
  }
}

export interface ElectronAppFixture {
  app: ElectronApplication
  window: Page
  /** Uncaught renderer error messages collected since launch (main window). */
  windowErrors: string[]
  /** `Content-Security-Policy` header of the main document, if one was sent. */
  cspHeader: string | null
  close: () => Promise<void>
}

const SETTINGS_KEY = 'cloudchat-settings'

/**
 * Mark first-run setup as complete (mirrors the seed used by
 * screenshots.spec.ts) so tests hit the real chat UI, not the wizard overlay.
 */
async function completeSetup(window: Page): Promise<void> {
  await window.evaluate((key) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        state: {
          isSetupComplete: true,
          theme: 'dark',
          colorTheme: 'default',
          activeProvider: 'anthropic',
        },
        version: 21,
      }),
    )
  }, SETTINGS_KEY)
  await window.reload()
  await window.waitForLoadState('domcontentloaded')
}

/**
 * Launch the built Electron app for testing.
 * Run `npx electron-vite build` first to produce out/main/index.js
 */
export async function launchElectronApp(): Promise<ElectronAppFixture> {
  const mainEntry = path.resolve(__dirname, '../out/main/index.js')

  // Isolate user data — never run against the developer's real profile.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-e2e-'))

  const app = await electron.launch({
    // --no-sandbox: headless CI runners (GitHub Actions) deny unprivileged
    // user namespaces, which can crash the renderer. The specs that matter
    // (contextIsolation, webSecurity, CSP) are unaffected — the OS sandbox
    // is not what they assert.
    args: [`--user-data-dir=${userDataDir}`, '--no-sandbox', mainEntry],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ELECTRON_IS_DEV: '0',
      ELECTRON_DISABLE_GPU: '1',
    },
    timeout: 30_000,
  })

  // Collect errors / headers from the FIRST load (attached before waiting for
  // the page to settle, so load-time failures are captured, not missed).
  const windowErrors: string[] = []
  let cspHeader: string | null = null
  const window = await app.firstWindow({ timeout: 30_000 })
  window.on('pageerror', (err) => windowErrors.push(err.message))
  window.on('response', (response) => {
    if (cspHeader === null && response.request().resourceType() === 'document') {
      cspHeader = response.headers()['content-security-policy'] ?? null
    }
  })

  await window.waitForLoadState('domcontentloaded')
  await completeSetup(window)

  return {
    app,
    window,
    windowErrors,
    cspHeader,
    async close() {
      // app.close() waits for the app process to exit; on headless Linux the
      // app can linger (quit-handler/tray quirks) and blow the worker's 60s
      // teardown budget. Bound the wait, then hard-kill if still alive.
      try {
        await Promise.race([
          app.close(),
          new Promise((resolve) => setTimeout(resolve, 10_000)),
        ])
      } catch { /* already gone */ }
      try {
        const proc = app.process()
        if (proc && proc.exitCode === null && !proc.killed) {
          proc.kill('SIGKILL')
        }
      } catch { /* already exited */ }
      try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* best effort */ }
    },
  }
}

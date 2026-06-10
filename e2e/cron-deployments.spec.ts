/**
 * Verification screenshots for the Scheduled Deployments (cron) integration:
 * authoritative archive + deployment-style detail view (next-runs chips +
 * run-history sparkline).
 *
 * Cron data normally comes from Hermes; here we mock the Hermes cron endpoints
 * via Playwright routing so the new UI renders deterministically without a live
 * Hermes bridge. The /api/cron-archive store is the real CloudChat server.
 *
 * Run: npx playwright test e2e/cron-deployments.spec.ts --config playwright-electron.config.ts
 */
import { test, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../docs/screenshots')
const MAIN = path.resolve(__dirname, '../out/main/index.js')
const SCALE = Number(process.env.SHOT_SCALE ?? 2)

let app: ElectronApplication
let win: Page

const JOBS = [
  {
    id: 'depl_competitor_intel',
    name: 'Competitive Intel Analyst',
    schedule: '0 7 * * 1-5',
    schedule_display: 'Weekdays at 7:00 AM',
    prompt: "Run today's intel sweep. Follow your phase protocol. Compare findings against Acme Agent and title the section '## Acme Agent comparison'.",
    status: 'active',
    created_at: new Date(Date.now() - 86_400_000 * 30).toISOString(),
    last_run: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    next_run: new Date(Date.now() + 19 * 3_600_000).toISOString(),
    last_status: 'ok',
    conversation_title: null,
  },
  {
    id: 'depl_nightly_security',
    name: 'Nightly Security Scan',
    schedule: '0 3 * * *',
    schedule_display: 'Daily at 3:00 AM',
    prompt: 'Scan the codebase for hardcoded secrets, injection risks, and exposed keys. Report findings by severity.',
    status: 'active',
    created_at: new Date(Date.now() - 86_400_000 * 12).toISOString(),
    last_run: new Date(Date.now() - 9 * 3_600_000).toISOString(),
    next_run: new Date(Date.now() + 6 * 3_600_000).toISOString(),
    last_status: 'ok',
    conversation_title: null,
  },
]

function mockHistory(jobId: string) {
  const statuses = ['success', 'success', 'success', 'error', 'success', 'success', 'success', 'success', 'success', 'success', 'success', 'success']
  return statuses.map((status, i) => ({
    run_id: `${jobId}-run-${i}`,
    started_at: new Date(Date.now() - (i + 1) * 86_400_000).toISOString(),
    status,
    duration_ms: 12_000 + i * 1500,
    output: status === 'success' ? 'Completed sweep. 3 findings written to memory store.' : undefined,
    error: status === 'error' ? 'Upstream rate limit (429) — retried next cycle.' : undefined,
  }))
}

async function shot(name: string) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await win.screenshot({ path: path.join(OUT_DIR, `${name}.png`) })
  console.log(`[shot] ${name}.png`)
}

test.beforeAll(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudchat-cron-shots-'))
  app = await electron.launch({
    args: [`--force-device-scale-factor=${SCALE}`, `--user-data-dir=${userDataDir}`, MAIN],
    env: { ...process.env, NODE_ENV: 'test', ELECTRON_IS_DEV: '0', ELECTRON_DISABLE_GPU: '1' },
    timeout: 30_000,
  })
  win = await app.firstWindow({ timeout: 30_000 })
  await win.waitForLoadState('domcontentloaded')

  // Patch window.fetch in the renderer (runs before page scripts on every load)
  // to serve mock Hermes cron data — guaranteed to intercept renderer fetches
  // regardless of origin scheme. The /api/cron-archive store is left real.
  await win.addInitScript((payload: { jobs: unknown[]; history: Record<string, unknown> }) => {
    const realFetch = window.fetch.bind(window)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/api/hermes/cron')) {
        const histMatch = url.match(/\/cron\/([^/?]+)\/history/)
        if (histMatch) return Promise.resolve(json({ runs: payload.history[histMatch[1]] ?? payload.history['_default'] }))
        const actMatch = url.match(/\/cron\/([^/?]+)\/(pause|resume|run)/)
        if (actMatch) {
          const isPause = actMatch[2] === 'pause'
          const job = (payload.jobs as Array<{ id: string }>).find((j) => j.id === actMatch[1]) ?? payload.jobs[0]
          return Promise.resolve(json({ job: { ...(job as object), status: isPause ? 'paused' : 'active' } }))
        }
        return Promise.resolve(json({ jobs: payload.jobs }))
      }
      return realFetch(input as RequestInfo, init)
    }) as typeof window.fetch
  }, { jobs: JOBS, history: { [JOBS[0].id]: mockHistory(JOBS[0].id), [JOBS[1].id]: mockHistory(JOBS[1].id), _default: mockHistory('x') } })

  await win.waitForTimeout(800)
})

test.afterAll(async () => {
  try { await app.close() } catch { /* ignore */ }
})

test('capture deployments screenshots', async () => {
  test.setTimeout(120_000)

  // Mark setup complete, force dark theme, select the Hermes provider, and open
  // the sidebar on the Cron sub-tab.
  await win.evaluate(() => {
    localStorage.setItem('cloudchat-settings', JSON.stringify({
      state: { isSetupComplete: true, theme: 'dark', colorTheme: 'default', activeProvider: 'hermes' },
      version: 21,
    }))
    // tourSeen IS persisted (activeSubTab is not), so dismiss the first-run tour
    // here and select the Cron tab by clicking after load.
    const ui = JSON.parse(localStorage.getItem('ui-store') || '{"state":{},"version":0}')
    ui.state = { ...ui.state, sidebarOpen: true, tourSeen: true }
    localStorage.setItem('ui-store', JSON.stringify(ui))
  })
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(() => { window.location.hash = '#/' })
  await win.waitForTimeout(2500)

  // Open the sidebar if collapsed.
  try {
    const btn = win.locator('[aria-label="Open sidebar"], [title="Open sidebar"]').first()
    if (await btn.count()) { await btn.click({ timeout: 3000 }); await win.waitForTimeout(600) }
  } catch { /* already open */ }

  // Dismiss any lingering first-run tour popover.
  try {
    const close = win.locator('[aria-label="Close tour"], [aria-label="Close"]').first()
    if (await close.count()) { await close.click({ timeout: 2000 }) }
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
  } catch { /* no tour */ }

  // Ensure the Cron sub-tab is active.
  try {
    await win.getByRole('button', { name: 'Cron' }).first().click({ timeout: 5000 })
    await win.waitForTimeout(1000)
  } catch (e) { console.log('cron tab click failed:', String(e).split('\n')[0]) }

  await shot('cron-01-list')

  // Expand the first deployment to reveal the schedule, next-runs chips, and
  // run-history sparkline.
  try {
    await win.getByText('Competitive Intel Analyst').first().click({ timeout: 6000 })
    await win.waitForTimeout(1500)
    await shot('cron-02-detail')
  } catch (e) { console.log('expand failed:', String(e).split('\n')[0]) }

  // Archive the deployment (hover to reveal the row actions, then click Archive).
  try {
    const row = win.getByText('Nightly Security Scan').first()
    await row.hover()
    await win.waitForTimeout(400)
    await win.locator('[title="Archive"]').first().click({ timeout: 5000 })
    await win.waitForTimeout(1200)
    await shot('cron-03-after-archive')
  } catch (e) { console.log('archive failed:', String(e).split('\n')[0]) }

  // Switch to the Archived view via the header Archive toggle.
  try {
    await win.locator('[title^="Show archived"]').first().click({ timeout: 5000 })
    await win.waitForTimeout(1000)
    await shot('cron-04-archived-view')
  } catch (e) { console.log('archived view failed:', String(e).split('\n')[0]) }
})

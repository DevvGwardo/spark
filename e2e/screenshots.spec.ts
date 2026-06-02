/**
 * README screenshot harness.
 *
 * Launches the built Electron app with an ISOLATED, throwaway user-data dir so
 * no real conversations / API keys can leak into committed images. Seeds a few
 * realistic demo conversations via the embedded server's import API, marks setup
 * complete, then captures full-window PNGs of the key product surfaces into
 * docs/screenshots/.
 *
 * Run: npx playwright test e2e/screenshots.spec.ts --config playwright-electron.config.ts
 */
import { test, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../docs/screenshots')
const MAIN = path.resolve(__dirname, '../out/main/index.js')
// Render at 2x so captured PNGs are retina-crisp for the web showcase.
const SCALE = Number(process.env.SHOT_SCALE ?? 2)

let app: ElectronApplication
let win: Page
let apiBase = ''

const now = Date.now()
const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString()

function conv(over: Record<string, unknown>) {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    systemPrompt: 'You are CloudChat, a fast autonomous coding agent.',
    createdAt: iso(180),
    updatedAt: iso(2),
    pinned: false,
    tags: [],
    ...over,
  }
}
function msg(conversationId: string, over: Record<string, unknown>) {
  return { conversationId, timestamp: iso(5), ...over }
}

// The hero conversation: an agent run with tool calls + a code answer.
const HERO_ID = 'demo-agent-auth'
const heroConv = conv({
  id: HERO_ID,
  title: 'Fix auth middleware bug',
  tags: ['agent', 'github'],
  linesAdded: 12,
  linesRemoved: 4,
})
const heroMessages = [
  msg(HERO_ID, {
    id: 'h1',
    role: 'user',
    content: 'Read `src/api/routes.ts`, find why the auth middleware rejects valid tokens, and fix it.',
    timestamp: iso(9),
  }),
  msg(HERO_ID, {
    id: 'h2',
    role: 'assistant',
    content:
      "I'll inspect the middleware, reproduce the failure, then patch it.",
    timestamp: iso(8),
    toolInvocations: [
      {
        toolCallId: 'c1',
        toolName: 'files',
        state: 'result',
        args: { path: 'src/api/routes.ts' },
        result:
          'export function requireAuth(req, res, next) {\n  const token = req.headers.authorization?.split(" ")[1]\n  if (!verify(token, SECRET)) return res.status(401).end()\n  next()\n}',
      },
      {
        toolCallId: 'c2',
        toolName: 'terminal',
        state: 'result',
        args: { command: 'npm test -- auth.spec.ts' },
        result:
          'FAIL  auth.spec.ts\n  ✕ accepts a valid bearer token (12 ms)\n    expected 200, got 401\n\nTests: 1 failed, 5 passed',
      },
    ],
  }),
  msg(HERO_ID, {
    id: 'h3',
    role: 'assistant',
    content:
      "Found it. `verify()` throws on a valid-but-expired clock skew, and the throw is swallowed as a falsy result. The header split also breaks on lowercase `bearer`. Here's the fix:\n\n```ts\nexport function requireAuth(req, res, next) {\n  const header = req.headers.authorization ?? ''\n  const [scheme, token] = header.split(' ')\n  if (scheme?.toLowerCase() !== 'bearer' || !token) {\n    return res.status(401).json({ error: 'missing bearer token' })\n  }\n  try {\n    req.user = verify(token, SECRET, { clockTolerance: 30 })\n    next()\n  } catch {\n    res.status(401).json({ error: 'invalid token' })\n  }\n}\n```\n\nThe suite is green now — **1 file changed, +12 −4**. Want me to open a PR?",
    timestamp: iso(2),
    toolInvocations: [
      {
        toolCallId: 'c3',
        toolName: 'files',
        state: 'result',
        args: { path: 'src/api/routes.ts', action: 'edit' },
        result: '1 file changed, 12 insertions(+), 4 deletions(-)',
      },
    ],
  }),
]

// Filler conversations so the sidebar reads like a real workspace.
const SIDE = [
  conv({ id: 'd2', title: 'Refactor Zustand stores', tags: ['refactor'], updatedAt: iso(34) }),
  conv({ id: 'd3', title: 'Explain the SSE reconnect flow', tags: ['question'], updatedAt: iso(95) }),
  conv({ id: 'd4', title: 'Generate a sortable table component', tags: ['ui'], updatedAt: iso(140) }),
  conv({ id: 'd5', title: 'Triage open GitHub issues', tags: ['agent', 'github'], updatedAt: iso(220) }),
]

async function shot(name: string) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await win.screenshot({ path: path.join(OUT_DIR, `${name}.png`) })
  console.log(`[shot] ${name}.png`)
}

// The app lives at the root route. Ensure we're there before capturing.
async function gotoApp() {
  await win.evaluate(() => { window.location.hash = '#/' })
  await win.waitForTimeout(1800)
}

// The sidebar is collapsed on a fresh profile; open it so conversations and the
// GitHub/tree buttons are reachable.
async function openSidebar() {
  try {
    const btn = win.locator('[aria-label="Open sidebar"], [title="Open sidebar"]').first()
    if (await btn.count()) { await btn.click({ timeout: 3000 }); await win.waitForTimeout(700) }
  } catch { /* already open */ }
}

async function seed() {
  const port = await win.evaluate(() => (window as any).electronAPI?.apiPort)
  apiBase = `http://localhost:${port}`
  const post = async (body: unknown) => {
    const r = await fetch(`${apiBase}/functions/v1/chat-store/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok && r.status !== 409) throw new Error(`seed failed ${r.status}: ${await r.text()}`)
  }
  for (const c of SIDE) await post({ conversation: c, messages: [] })
  await post({ conversation: heroConv, messages: heroMessages })
}

async function settleSetup() {
  // Force dark theme first (setup still incomplete) so the wizard renders dark,
  // capture it, then mark setup complete and reload into the app.
  const persist = (state: Record<string, unknown>) =>
    win.evaluate((s) => localStorage.setItem('cloudchat-settings', JSON.stringify({ state: s, version: 21 })), state)

  await persist({ isSetupComplete: false, theme: 'dark', colorTheme: 'default', activeProvider: 'anthropic' })
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await gotoApp()
  try {
    await win.waitForSelector('[aria-label="CloudChat Setup Wizard"]', { timeout: 4000 })
    await shot('06-setup-wizard')
  } catch { /* wizard may not appear */ }

  await persist({ isSetupComplete: true, theme: 'dark', colorTheme: 'default', activeProvider: 'anthropic' })
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await gotoApp()
}

test.beforeAll(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudchat-shots-'))
  app = await electron.launch({
    // --force-device-scale-factor renders the window at 2x so captured PNGs are
    // retina-crisp (2800x1800 for the 1400x900 window) for the web showcase.
    args: [`--force-device-scale-factor=${SCALE}`, `--user-data-dir=${userDataDir}`, MAIN],
    env: { ...process.env, NODE_ENV: 'test', ELECTRON_IS_DEV: '0', ELECTRON_DISABLE_GPU: '1' },
    timeout: 30_000,
  })
  win = await app.firstWindow({ timeout: 30_000 })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(1500)
  console.log('[boot-url]', win.url())
})

test.afterAll(async () => {
  try { await app.close() } catch { /* ignore */ }
})

test('capture product screenshots', async () => {
  test.setTimeout(180_000)

  await settleSetup()
  await seed()
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await gotoApp()
  await win.waitForTimeout(2000)

  // Debug: confirm the seed landed and the sidebar is reachable.
  const count = await win.evaluate(async () => {
    const port = (window as any).electronAPI?.apiPort
    const r = await fetch(`http://localhost:${port}/functions/v1/chat-store/conversations?includeArchived=1`)
    const j = await r.json()
    return j.total ?? (j.conversations?.length ?? -1)
  })
  console.log('[seeded-conversations]', count)

  await openSidebar()

  // One-time discovery: list interactive labels so we can target panels reliably.
  const labels = await win.evaluate(() =>
    Array.from(document.querySelectorAll('[aria-label],[title]'))
      .map((el) => el.getAttribute('aria-label') || el.getAttribute('title'))
      .filter(Boolean),
  )
  console.log('[labels]', JSON.stringify([...new Set(labels)]))

  // Hero: open the agent conversation.
  try {
    await win.getByText('Fix auth middleware bug').first().click({ timeout: 8000 })
    await win.waitForTimeout(1500)
    await shot('01-agent-chat')
  } catch (e) { console.log('hero failed:', String(e).split('\n')[0]) }

  // Command palette (Cmd/Ctrl+K).
  try {
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
    await win.waitForTimeout(1500)
    await shot('02-command-palette')
    await win.keyboard.press('Escape')
    await win.waitForTimeout(500)
  } catch (e) { console.log('palette failed:', String(e).split('\n')[0]) }

  // GitHub repo/issue browser.
  try {
    await win.locator('[aria-label="Browse repo issues"]').first().click({ timeout: 6000 })
    await win.waitForTimeout(1400)
    await shot('04-github')
    await win.keyboard.press('Escape')
    await win.waitForTimeout(500)
  } catch (e) { console.log('github failed:', String(e).split('\n')[0]) }

  // Terminal panel (Ctrl+`).
  try {
    await win.keyboard.press('Control+`')
    await win.waitForTimeout(1400)
    await shot('05-terminal')
    await win.keyboard.press('Control+`')
    await win.waitForTimeout(500)
  } catch (e) { console.log('terminal failed:', String(e).split('\n')[0]) }

  // Conversation tree overlay.
  try {
    await win.locator('[aria-label="Open conversation tree"]').first().click({ timeout: 6000 })
    await win.waitForTimeout(1400)
    await shot('07-conversation-tree')
    await win.keyboard.press('Escape')
    await win.waitForTimeout(500)
  } catch (e) { console.log('tree failed:', String(e).split('\n')[0]) }

  // Settings LAST — its modal doesn't dismiss on Escape, so anything after it
  // would be blocked. No need to close it; the run ends here.
  try {
    await win.locator('[aria-label="Open settings"]').first().click({ timeout: 6000 })
    await win.waitForTimeout(1400)
    await shot('03-settings')
  } catch (e) { console.log('settings failed:', String(e).split('\n')[0]) }
})

import { app, BrowserView, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Notification, Tray, nativeImage, net, protocol, session, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { extname, join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import { startEmbeddedServer } from './server'
import {
  startBridge,
  stopBridge,
  getBridgeSetupStatus,
  installBridgeDeps,
  installHermesAgent,
} from './bridge'
import { startOpenRouterOAuth } from './oauth-openrouter'
import { parseSparkUrl } from './deep-links'
import { McpWorkerManager } from './mcp-worker-manager'
import { validateSpawnCommand, validateWorkerCwd, filterWorkerEnv, checkSpawnRateLimit } from '../server/lib/mcp-worker-policy'

let mainWindow: BrowserWindow | null = null
let quickWindow: BrowserWindow | null = null
let tray: Tray | null = null
let apiPort: number = 3001
let dockBounceId: number | null = null
let miniBrowserView: BrowserView | null = null
let lastMiniBrowserBounds: Electron.Rectangle | null = null
// Runtime icon paths: packaged builds receive icons via extraResources at
// process.resourcesPath/icons; dev uses the repo's build/ directory.
function resolveIconPath(name: string): string {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'icons')
    : join(__dirname, '../../build')
  return join(base, name)
}
const CLOUDCHAT_ASSET_PROTOCOL = 'cloudchat-asset'
const CLOUDCHAT_ASSET_ROOTS = {
  hermes: join(homedir(), '.hermes/images'),
  tmp: '/tmp',
} as const
const SNAPSHOT_FILENAME_RE = /^[0-9a-f]{64}\.(png|jpe?g|gif|webp|svg|avif|bmp)$/

protocol.registerSchemesAsPrivileged([
  {
    scheme: CLOUDCHAT_ASSET_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
    },
  },
])

interface AttentionRequestPayload {
  title?: string
  body?: string
}

const preloadPathCandidates = [
  // Sandboxed renderers can't run ESM preloads, so electron.vite.config.ts emits
  // a CommonJS bundle (.cjs). Older builds produced .mjs/.js — kept as fallbacks.
  join(__dirname, '../preload/preload.cjs'),
  join(__dirname, '../preload/index.cjs'),
  join(__dirname, '../preload/preload.mjs'),
  join(__dirname, '../preload/preload.js'),
  join(__dirname, '../preload/index.mjs'),
  join(__dirname, '../preload/index.js')
]

async function resolvePreloadPath() {
  const timeoutMs = is.dev ? 5000 : 500
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    const resolved = preloadPathCandidates.find((file) => existsSync(file))
    if (resolved) {
      return resolved
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  if (!is.dev) {
    // A missing preload silently disables the entire privileged bridge in
    // packaged builds — fail loudly instead of limping along.
    throw new Error(
      'Preload bundle not found. Looked for: ' + preloadPathCandidates.join(', ')
    )
  }

  console.warn(
    'Preload bundle was not ready before BrowserWindow creation. Falling back to the expected output path.',
    preloadPathCandidates
  )
  return preloadPathCandidates[0]
}

// ── Trust boundaries (navigation + IPC) ─────────────────────────────────────
// The only pages allowed in the main window's webContents are the app's own
// renderer: the Vite dev server (localhost) in dev, out/renderer/index.html in
// production. Everything else — arbitrary http(s) hosts, any file:, data:,
// javascript: URL, and the mini BrowserView's webContents — is untrusted.
function isTrustedRendererUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      // Exact hostname match — never startsWith: 'http://localhost.evil.com'
      // would otherwise pass.
      return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    }
    if (parsed.protocol === 'file:') {
      // Only the app's own renderer bundle may load from disk.
      const expected = join(__dirname, '../renderer/index.html')
      return resolve(decodeURIComponent(parsed.pathname)) === resolve(expected)
    }
  } catch {
    // Malformed URL — treat as untrusted.
  }
  return false
}

/**
 * Every privileged IPC handler must verify the caller: only the main window's
 * own webContents, loaded from the app origin, may invoke it. Any other
 * webContents in the shared session (e.g. the mini BrowserView showing
 * arbitrary remote sites) is rejected.
 */
function isTrustedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  // Phase 4: the quick-capture window loads the same renderer bundle (?quick=1)
  // and is equally trusted. The mini BrowserView (arbitrary remote sites) stays
  // untrusted.
  const fromMain = !!mainWindow && event.sender === mainWindow.webContents
  const fromQuick = !!quickWindow && !quickWindow.isDestroyed() && event.sender === quickWindow.webContents
  if (!fromMain && !fromQuick) {
    return false
  }
  const frameUrl = event.senderFrame?.url
  if (!frameUrl) {
    return false
  }
  return isTrustedRendererUrl(frameUrl)
}

function assertTrustedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (!isTrustedSender(event)) {
    throw new Error('Untrusted IPC sender')
  }
}

function trustedHandle(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  // eslint-disable-next-line no-restricted-syntax -- trustedHandle IS the sanctioned wrapper; all other call sites are banned
  ipcMain.handle(channel, (event, ...args) => { assertTrustedSender(event); return handler(event, ...args); })
}

function assetTextResponse(status: number, body: string) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  })
}

function getAssetRoot(host: string) {
  if (host === 'snapshot') return getSnapshotDir()
  if (host === 'hermes') return CLOUDCHAT_ASSET_ROOTS.hermes
  if (host === 'tmp') return CLOUDCHAT_ASSET_ROOTS.tmp
  return null
}

function getSnapshotDir() {
  return join(app.getPath('userData'), 'image-snapshots')
}

function ensureSnapshotDir() {
  const snapshotDir = getSnapshotDir()
  mkdirSync(snapshotDir, { recursive: true })
  return snapshotDir
}

function isWithinRoot(path: string, root: string) {
  const resolvedPath = resolve(path)
  const resolvedRoot = resolve(root)
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`)
}

function resolveAllowedImagePath(inputPath: string) {
  if (!inputPath || !inputPath.startsWith('/')) {
    return null
  }

  let resolvedPath: string
  try {
    resolvedPath = realpathSync(inputPath)
  } catch {
    return null
  }
  const allowedRoots = [
    CLOUDCHAT_ASSET_ROOTS.tmp,
    CLOUDCHAT_ASSET_ROOTS.hermes,
  ]

  return allowedRoots.some((root) => isWithinRoot(resolvedPath, root))
    ? resolvedPath
    : null
}

function getAssetBasename(host: string, pathname: string) {
  const rawBasename = pathname.startsWith('/') ? pathname.slice(1) : pathname
  if (!rawBasename) return null

  let basename: string
  try {
    basename = decodeURIComponent(rawBasename)
  } catch {
    return null
  }

  if (!basename || basename.includes('..') || basename.includes('/') || basename.includes('\\')) {
    return null
  }

  if (host === 'snapshot' && !SNAPSHOT_FILENAME_RE.test(basename)) {
    return null
  }

  return basename
}

function registerLocalAssetProtocol() {
  protocol.handle(CLOUDCHAT_ASSET_PROTOCOL, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return assetTextResponse(400, 'Bad Request')
    }

    const root = getAssetRoot(url.hostname)
    const basename = getAssetBasename(url.hostname, url.pathname)
    if (!root || !basename) {
      return assetTextResponse(400, 'Bad Request')
    }

    const resolvedPath = join(root, basename)

    try {
      if (!statSync(resolvedPath).isFile()) {
        return assetTextResponse(404, 'Not Found')
      }
    } catch {
      return assetTextResponse(404, 'Not Found')
    }

    return net.fetch(pathToFileURL(resolvedPath).toString())
  })
}

trustedHandle('cloudchat:snapshotLocalImage', async (_event, inputPath: string) => {
  if (typeof inputPath !== 'string') {
    throw new Error('Invalid image path')
  }

  const resolvedPath = resolveAllowedImagePath(inputPath)
  if (!resolvedPath) {
    throw new Error('Image path is outside allowed roots')
  }

  let fileData: Buffer
  try {
    if (!statSync(resolvedPath).isFile()) {
      throw new Error('Image path is not a file')
    }
    fileData = readFileSync(resolvedPath)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Unable to read image file')
  }

  const hash = createHash('sha256').update(fileData).digest('hex')
  const extension = extname(resolvedPath).toLowerCase()
  const snapshotBasename = `${hash}${extension}`
  if (!SNAPSHOT_FILENAME_RE.test(snapshotBasename)) {
    throw new Error('Unsupported image extension')
  }

  const snapshotDir = ensureSnapshotDir()
  const snapshotPath = join(snapshotDir, snapshotBasename)

  if (!existsSync(snapshotPath)) {
    copyFileSync(resolvedPath, snapshotPath)
  }

  return {
    url: `${CLOUDCHAT_ASSET_PROTOCOL}://snapshot/${snapshotBasename}`,
    hash,
    path: snapshotPath,
  }
})

// The embedded Express server is process-wide. createWindow() can run more than
// once (macOS `activate`), but the server must start exactly once — otherwise
// each activate leaks another server on an ephemeral port with fresh DBs.
let embeddedServerPromise: Promise<number> | null = null

function startEmbeddedServerOnce(): Promise<number> {
  if (!embeddedServerPromise) {
    embeddedServerPromise = startEmbeddedServer().catch((err) => {
      embeddedServerPromise = null
      throw err
    })
  }
  return embeddedServerPromise
}

// Content Security Policy — injected via response headers on the shared
// (default) session. Registered exactly once in app.whenReady: createWindow()
// can run more than once on macOS (activate), and a registration inside it
// would stack a duplicate onHeadersReceived listener per window. The
// webContentsId checks below scope the injection to the current main window.
function registerCspHeaders() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Skip CSP injection for BrowserView (mini browser) — it needs full web access for sites like YouTube
    if (miniBrowserView && details.webContentsId === miniBrowserView.webContents.id) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    // Also skip for any non-main-window webContents (safety net).
    // Phase 4: the quick-capture window shares the session and loads the same
    // renderer bundle, so it receives the same CSP injection as the main window.
    const isQuickTarget =
      !!quickWindow && !quickWindow.isDestroyed() && details.webContentsId === quickWindow.webContents.id
    if ((!mainWindow || details.webContentsId !== mainWindow.webContents.id) && !isQuickTarget) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self';" +
          // Hash of the inline FOUC-prevention theme script in index.html.
          // If that script changes, regenerate this hash from the CSP console error.
          // Dev (electron-vite) injects an inline React-refresh preamble and uses
          // eval for HMR, so script-src is relaxed in dev only — production keeps
          // the strict hash-based policy.
          (is.dev
            ? " script-src 'self' 'unsafe-inline' 'unsafe-eval';"
            : " script-src 'self' 'sha256-0vw5FNYeotOv1pKtYDJoVY1QPOJ7d3jJvy4jR5P0U2Q=';") +
          " style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;" +
          " font-src 'self' https://fonts.gstatic.com data:;" +
          // blob: allows local object-URL previews (pasted image thumbnails)
          " img-src 'self' data: blob: https: http: file: cloudchat-asset:;" +
          " media-src 'self' blob:;" +
          " connect-src 'self' data: http://localhost:* http://127.0.0.1:* " + (is.dev ? "ws://localhost:* ws://127.0.0.1:* " : "") + "https://api.github.com https://api.anthropic.com https://api.openai.com https://api.deepseek.com https://generativelanguage.googleapis.com https://api.minimax.chat https://api.moonshot.cn https://api.x.ai https://openrouter.ai https://api.together.xyz https://api.groq.com https://api.mistral.ai https://api.perplexity.ai;" +
          " worker-src 'self' blob:;"
        ]
      }
    })
  })
}

async function createWindow() {
  process.env.CLOUDCHAT_USER_DATA_DIR = app.getPath('userData')
  process.env.CLOUDCHAT_IMAGE_SNAPSHOT_DIR = getSnapshotDir()

  // Serve the bundled frontend over HTTP so remote devices (phone via the
  // Remote Access QR / tunnel) can load the full Spark UI, not just the API.
  // This also enables the /api/remote/* QR + tunnel endpoints. In dev the
  // renderer is served by Vite, so this only activates in packaged builds.
  const rendererDir = join(__dirname, '../renderer')
  if (existsSync(join(rendererDir, 'index.html'))) {
    process.env.SERVE_FRONTEND = 'true'
    process.env.FRONTEND_DIST_DIR = rendererDir
  }

  // Start embedded Express server (once per process — see startEmbeddedServerOnce)
  apiPort = await startEmbeddedServerOnce()
  console.log(`Embedded server started on port ${apiPort}`)

  // Set port in env so preload can read it synchronously
  process.env.ELECTRON_API_PORT = String(apiPort)
  const preloadPath = await resolvePreloadPath()
  console.log(`Using preload script: ${preloadPath}`)

  const appIconPath = resolveIconPath('spark-icon.png')

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    ...(existsSync(appIconPath) ? { icon: appIconPath } : {}),
    title: 'Spark',
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      // Sandbox the renderer. The preload only needs process.argv, process.platform
      // and process.versions — all available in the sandboxed preload polyfill.
      // Values that used to travel via process.env (unreliable under sandbox)
      // are passed through additionalArguments instead (see electron/preload.ts).
      sandbox: true,
      additionalArguments: [
        `--electron-api-port=${apiPort}`,
        `--cloudchat-snapshot-dir=${getSnapshotDir()}`,
        `--electron-home-dir=${homedir()}`,
      ],
    }
  })

  // Grant microphone + clipboard permission requests from the renderer.
  // Only the main window's own webContents is trusted: the mini BrowserView
  // loads arbitrary remote sites and must never receive mic/camera access.
  mainWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      if (webContents !== mainWindow?.webContents) {
        callback(false)
        return
      }
      if (permission === 'media' || permission === 'clipboard-sanitized-write' || permission === 'clipboard-read') {
        callback(true)
      } else {
        callback(false)
      }
    }
  )

  // Content Security Policy is registered once for the whole process in
  // registerCspHeaders() (called from app.whenReady) — it scopes itself to
  // the main window via webContentsId checks, so nothing per-window is needed.

  // Open external links (e.g. "View on GitHub") in the system browser.
  // window.open() with any non-http(s) URL (data:, javascript:, about:, …) is
  // denied outright.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url)
      }
    } catch {
      // Malformed URL — denied below.
    }
    return { action: 'deny' }
  })

  // Catch <a target="_blank"> and any navigation away from the app. Trusted
  // URLs are only the app's own renderer (localhost in dev / out/renderer in
  // prod). The previous prefix matching was unsafe: 'http://localhost' also
  // matched http://localhost.evil.com and 'file://' allowed ANY local HTML file.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) {
      event.preventDefault()
      // Open legitimate external links in the system browser; drop everything
      // else (file:, data:, javascript:, …).
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          shell.openExternal(url)
        }
      } catch {
        // Malformed URL — already prevented.
      }
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    rendererUrl.searchParams.set('apiPort', String(apiPort))
    mainWindow.loadURL(rendererUrl.toString())
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: {
        apiPort: String(apiPort),
      },
    })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    // The mini BrowserView is attached to this window's webContents — destroy
    // it with the window so a recreated window never inherits a dead view
    // (or its listeners), and browser:create starts fresh.
    if (miniBrowserView) {
      miniBrowserView.webContents.close()
      miniBrowserView = null
      lastMiniBrowserBounds = null
    }
  })

  mainWindow.on('focus', () => {
    clearAttentionRequest()
  })

  mainWindow.on('show', () => {
    clearAttentionRequest()
  })

  // When the app enters or exits fullscreen, force the renderer to recalculate
  // BrowserView bounds by sending it a synthetic resize event.
  // HTML5 fullscreen (e.g. a video element going fullscreen)
  mainWindow.on('enter-html-full-screen', () => {
    mainWindow?.webContents.send('browser:force-resize')
  })
  mainWindow.on('leave-html-full-screen', () => {
    mainWindow?.webContents.send('browser:force-resize')
  })
  // Native macOS fullscreen (green traffic light button) — separate events from HTML5 fullscreen.
  // Without these, the BrowserView overlay keeps stale bounds after entering/exiting fullscreen,
  // causing the right sidebar to not stick to the right edge.
  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send('browser:force-resize')
  })
  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send('browser:force-resize')
  })
}

function applyAppIcon() {
  const appIconPath = resolveIconPath('spark-icon.png')
  if (!existsSync(appIconPath)) {
    return
  }

  try {
    const icon = nativeImage.createFromPath(appIconPath)
    if (icon.isEmpty()) {
      return
    }

    if (process.platform === 'darwin') {
      app.dock?.setIcon(icon)
    }
  } catch (error) {
    console.warn('Failed to apply app icon:', error)
  }
}

function clearAttentionRequest() {
  if (process.platform !== 'darwin' || dockBounceId === null) {
    return
  }

  app.dock?.cancelBounce(dockBounceId)
  dockBounceId = null
}

async function focusMainWindow() {
  if (!mainWindow) {
    // On macOS the app stays alive after the window closes (window-all-closed
    // keeps running), so tray "Show Spark" / "New Chat" and the global
    // shortcut must recreate the window instead of silently no-oping.
    await createWindow()
  }

  if (!mainWindow) {
    return
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show()
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }

  mainWindow.focus()
  clearAttentionRequest()
}

// ── Quick-capture window + spark:// deep links (Phase 4) ──────────────────
// The quick window loads the SAME renderer bundle with `?quick=1` (the
// renderer gates on that flag in main.tsx — no vite config change). It shares
// the session, preload, and sandbox shape with the main window.

function quickWebPreferences(preloadPath: string): Electron.WebPreferences {
  return {
    preload: preloadPath,
    nodeIntegration: false,
    contextIsolation: true,
    backgroundThrottling: false,
    sandbox: true,
    additionalArguments: [
      `--electron-api-port=${apiPort}`,
      `--cloudchat-snapshot-dir=${getSnapshotDir()}`,
      `--electron-home-dir=${homedir()}`,
    ],
  }
}

async function createQuickWindow(): Promise<BrowserWindow | null> {
  if (quickWindow && !quickWindow.isDestroyed()) {
    return quickWindow
  }

  const preloadPath = await resolvePreloadPath()

  quickWindow = new BrowserWindow({
    width: 560,
    height: 150,
    center: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: 'Spark Quick Capture',
    backgroundColor: '#1a1a1a',
    webPreferences: quickWebPreferences(preloadPath),
  })

  // Same navigation lockdown as the main window: only the app's own renderer
  // may load here; external links open in the system browser.
  quickWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url)
      }
    } catch {
      // Malformed URL — denied below.
    }
    return { action: 'deny' }
  })
  quickWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) {
      event.preventDefault()
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          shell.openExternal(url)
        }
      } catch {
        // Malformed URL — already prevented.
      }
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    rendererUrl.searchParams.set('apiPort', String(apiPort))
    rendererUrl.searchParams.set('quick', '1')
    await quickWindow.loadURL(rendererUrl.toString())
  } else {
    await quickWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: {
        apiPort: String(apiPort),
        quick: '1',
      },
    })
  }

  quickWindow.on('closed', () => {
    quickWindow = null
  })

  return quickWindow
}

async function toggleQuickWindow() {
  if (quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()) {
    quickWindow.hide()
    return
  }
  const win = await createQuickWindow()
  if (!win || win.isDestroyed()) {
    return
  }
  if (!win.isVisible()) {
    win.show()
  }
  win.focus()
}

// Route an incoming spark:// URL: ensure the main window exists, then forward
// to the renderer. OAuth is forward-only — the working localhost OAuth flow is
// untouched.
async function handleSparkUrl(raw: string) {
  const parsed = parseSparkUrl(raw)
  if (!parsed) {
    console.warn('[deep-link] ignoring invalid spark:// URL')
    return
  }
  await focusMainWindow()
  if (!mainWindow) {
    return
  }
  switch (parsed.kind) {
    case 'capture':
      mainWindow.webContents.send('quick:capture', parsed.text)
      break
    case 'chat':
      mainWindow.webContents.send('deep-link:navigate', { kind: 'chat', id: parsed.id })
      break
    case 'skill':
      mainWindow.webContents.send('deep-link:navigate', { kind: 'skill', name: parsed.name })
      break
    case 'oauth':
      mainWindow.webContents.send('deep-link:navigate', { kind: 'oauth' })
      break
  }
}

trustedHandle('quick:submit', async (_event, text: string) => {
  const clamped = typeof text === 'string' ? text.slice(0, 4000) : ''
  await focusMainWindow()
  if (clamped && mainWindow) {
    mainWindow.webContents.send('quick:capture', clamped)
  }
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.hide()
  }
  return { ok: true as const }
})

function notifyAttentionRequest(payload: AttentionRequestPayload = {}) {
  if (!mainWindow) {
    return
  }

  const isWindowVisible = mainWindow.isVisible() && !mainWindow.isMinimized()
  if (isWindowVisible && mainWindow.isFocused()) {
    return
  }

  const title = payload.title?.trim() || 'Spark needs your attention'
  const body = payload.body?.trim() || 'A conversation is waiting for your confirmation.'

  if (process.platform === 'darwin' && dockBounceId === null) {
    dockBounceId = app.dock?.bounce('informational') ?? null
  }

  if (!Notification.isSupported()) {
    return
  }

  const notification = new Notification({
    title,
    body,
  })

  notification.on('click', () => {
    focusMainWindow()
  })

  notification.show()
}

trustedHandle('app:notify-attention', (_event, payload?: AttentionRequestPayload) => {
  notifyAttentionRequest(payload)
})

trustedHandle('app:clear-attention', () => {
  clearAttentionRequest()
})

trustedHandle('app:get-version', () => {
  return app.getVersion()
})

// ── Hermes Bridge & first-run setup ────────────────────────────────────────
trustedHandle('bridge:status', () => {
  return getBridgeSetupStatus()
})
trustedHandle('bridge:start', () => {
  return startBridge()
})
trustedHandle('bridge:install-deps', async (event) => {
  const send = (line: string) =>
    event.sender.send('bridge:install-progress', line)
  return installBridgeDeps(send)
})
trustedHandle('bridge:install-hermes-agent', async (event) => {
  const send = (line: string) =>
    event.sender.send('bridge:install-progress', line)
  return installHermesAgent(send)
})
trustedHandle('openrouter:oauth', () => {
  return startOpenRouterOAuth()
})

// ── MCP worker pool (isolated server children) ──────────────────────────
// All handlers go through trustedHandle (deny-by-default sender gate).
const mcpWorkerManager = new McpWorkerManager()

trustedHandle('mcp-worker:spawn', async (_event, payload: { serverId?: unknown; command?: unknown; args?: unknown; cwd?: unknown; env?: unknown }) => {
  const serverId = payload?.serverId
  const command = payload?.command
  if (typeof serverId !== 'string' || serverId.length === 0) {
    throw new Error('Invalid serverId')
  }
  if (!checkSpawnRateLimit(serverId)) {
    throw new Error('Spawn rate limited')
  }
  if (typeof command !== 'string' || !validateSpawnCommand(command)) {
    throw new Error('Rejected spawn command')
  }
  const args = payload?.args
  const cwd = payload?.cwd
  const env = payload?.env
  if (args !== undefined && (!Array.isArray(args) || !args.every((a) => typeof a === 'string'))) {
    throw new Error('Invalid args')
  }
  if (cwd !== undefined && (typeof cwd !== 'string' || !validateWorkerCwd(cwd))) {
    throw new Error('Rejected worker cwd')
  }
  if (typeof cwd === 'string') {
    // resolve() does not resolve symlinks: a ~/safe/link → /outside escape
    // would pass validateWorkerCwd. Canonicalize first (fail closed).
    try {
      if (!validateWorkerCwd(realpathSync(cwd))) {
        throw new Error('Rejected worker cwd')
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'Rejected worker cwd') throw err
      throw new Error('Rejected worker cwd')
    }
  }
  let safeEnv: Record<string, string> | undefined
  if (env !== undefined) {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      throw new Error('Invalid env')
    }
    for (const value of Object.values(env as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new Error('Invalid env')
      }
    }
    // Allowlist gate: unlisted keys (LD_PRELOAD, NODE_OPTIONS, …) are dropped.
    safeEnv = filterWorkerEnv(env as Record<string, string>)
  }
  return mcpWorkerManager.add({
    serverId,
    options: {
      command,
      ...(args !== undefined ? { args } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(safeEnv !== undefined ? { env: safeEnv } : {}),
    },
  })
})

trustedHandle('mcp-worker:status', () => {
  return mcpWorkerManager.status()
})

trustedHandle('mcp-worker:stop', async (_event, serverId: unknown) => {
  if (typeof serverId !== 'string' || serverId.length === 0) {
    throw new Error('Invalid serverId')
  }
  await mcpWorkerManager.remove(serverId)
  return { stopped: true }
})

trustedHandle('file:save-dialog', async (_event, payload: { defaultFilename?: string; content?: string }) => {
  const defaultFilename = typeof payload?.defaultFilename === 'string' ? payload.defaultFilename : 'export.txt'
  const content = typeof payload?.content === 'string' ? payload.content : ''
  const parent = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined
  const result = parent
    ? await dialog.showSaveDialog(parent, { defaultPath: defaultFilename })
    : await dialog.showSaveDialog({ defaultPath: defaultFilename })
  if (result.canceled || !result.filePath) return { saved: false as const }
  try {
    writeFileSync(result.filePath, content, 'utf-8')
    return { saved: true as const, path: result.filePath }
  } catch (error) {
    return { saved: false as const, error: error instanceof Error ? error.message : String(error) }
  }
})

trustedHandle('shell:open-external', async (_event, url: string) => {
  if (typeof url !== 'string') return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  // https:// only (http:// additionally in dev); never file:, data:, etc.
  const allowed = parsed.protocol === 'https:' || (is.dev && parsed.protocol === 'http:')
  if (!allowed) return false
  try {
    await shell.openExternal(url)
    return true
  } catch {
    return false
  }
})

// ── Mini Browser (BrowserView) management ───────────────────────────
const MINI_BROWSER_TOOLBAR_HEIGHT = 36

function isAllowedBrowserUrl(url: string, allowBlank = false): boolean {
  if (allowBlank && (url === 'about:blank' || url.startsWith('about:blank'))) {
    return true
  }
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function emitBrowserNavState() {
  if (!mainWindow || !miniBrowserView) return
  const wc = miniBrowserView.webContents
  mainWindow.webContents.send('browser:nav-state', {
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward(),
  })
}

function attachMiniBrowserListeners(view: BrowserView) {
  const wc = view.webContents

  wc.on('will-navigate', (event, url) => {
    if (!isAllowedBrowserUrl(url, true)) {
      event.preventDefault()
      console.warn('Blocked will-navigate to non-http URL:', url)
    }
  })

  wc.setWindowOpenHandler(({ url }) => {
    if (isAllowedBrowserUrl(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  wc.on('did-navigate', (_event, url) => {
    mainWindow?.webContents.send('browser:navigated', url)
    emitBrowserNavState()
  })

  wc.on('did-navigate-in-page', (_event, url) => {
    mainWindow?.webContents.send('browser:navigated', url)
    emitBrowserNavState()
  })

  wc.on('did-start-loading', () => {
    mainWindow?.webContents.send('browser:loading', true)
  })

  wc.on('did-stop-loading', () => {
    mainWindow?.webContents.send('browser:loading', false)
    emitBrowserNavState()
  })

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 = ERR_ABORTED (common on redirects / cancelled loads)
    if (!isMainFrame || errorCode === -3) return
    mainWindow?.webContents.send('browser:fail-load', {
      url: validatedURL,
      errorCode,
      errorDescription,
    })
    mainWindow?.webContents.send('browser:loading', false)
  })
}

trustedHandle('browser:create', (_event, url?: string) => {
  if (!mainWindow) return false
  const initialUrl = url || 'about:blank'
  if (!isAllowedBrowserUrl(initialUrl, true)) {
    console.warn('Blocked creation with non-http URL:', initialUrl)
    return false
  }

  // Reuse existing view — navigate instead of destroy/recreate
  if (miniBrowserView) {
    // The window may have been closed and recreated (macOS); the closed
    // handler destroys the view, but guard anyway so a stale reference can
    // never be silently re-attached to a new window.
    if (miniBrowserView.webContents.isDestroyed()) {
      miniBrowserView = null
      lastMiniBrowserBounds = null
    } else {
      if (initialUrl !== 'about:blank') {
        void miniBrowserView.webContents.loadURL(initialUrl).catch((err) => {
          console.warn('[mini-browser] loadURL failed:', err)
        })
      }
      return true
    }
  }

  miniBrowserView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      // Sandbox the mini browser: it loads arbitrary remote sites and must not
      // gain Node/IPC capabilities. (The previous `sandbox: false` comment
      // claimed sandbox blocks media playback — it does not; autoplay policies
      // are independent of the process sandbox.)
      sandbox: true,
      plugins: true,
    }
  })
  attachMiniBrowserListeners(miniBrowserView)
  mainWindow.addBrowserView(miniBrowserView)
  // Use getContentBounds() — BrowserView coords are relative to content area, not window frame
  const bounds = mainWindow.getContentBounds()
  // Default: bottom-right corner, 600x400, with some padding from edges
  lastMiniBrowserBounds = {
    x: bounds.width - 620,
    y: bounds.height - 460 + MINI_BROWSER_TOOLBAR_HEIGHT,
    width: 600,
    height: 400 - MINI_BROWSER_TOOLBAR_HEIGHT,
  }
  miniBrowserView.setBounds(lastMiniBrowserBounds)
  miniBrowserView.setAutoResize({ width: false, height: false })
  void miniBrowserView.webContents.loadURL(initialUrl).catch((err) => {
  console.warn('[mini-browser] loadURL failed:', err)
})
  return true
})

trustedHandle('browser:navigate', (_event, url: string) => {
  if (!isAllowedBrowserUrl(url)) {
    console.warn('Blocked navigation to non-http URL:', url)
    return
  }
  void miniBrowserView?.webContents.loadURL(url).catch((err) => {
    console.warn('[mini-browser] loadURL failed:', err)
  })
})

trustedHandle('browser:go-back', () => {
  if (miniBrowserView?.webContents.canGoBack()) {
    miniBrowserView.webContents.goBack()
  }
})

trustedHandle('browser:go-forward', () => {
  if (miniBrowserView?.webContents.canGoForward()) {
    miniBrowserView.webContents.goForward()
  }
})

trustedHandle('browser:reload', () => {
  miniBrowserView?.webContents.reload()
})

trustedHandle('browser:get-url', () => {
  return miniBrowserView?.webContents.getURL() ?? null
})

trustedHandle('browser:close', () => {
  if (miniBrowserView && mainWindow) {
    mainWindow.removeBrowserView(miniBrowserView)
    miniBrowserView.webContents.close()
    miniBrowserView = null
    lastMiniBrowserBounds = null
  }
})

trustedHandle('browser:resize', (_event, bounds: { x: number; y: number; width: number; height: number }) => {
  if (!miniBrowserView || !mainWindow) return;
  const winBounds = mainWindow.getContentBounds();
  // BrowserView y must account for the 36px toolbar — never let it overlap the URL bar.
  // bounds.y is already the BrowserView's y (passed from renderer as position.y + TOOLBAR_HEIGHT).
  // Just clamp to stay below toolbar area and within window.
  const clamped = {
    x: Math.max(0, Math.min(bounds.x, winBounds.width - bounds.width)),
    y: Math.max(MINI_BROWSER_TOOLBAR_HEIGHT, Math.min(bounds.y, winBounds.height - 100)),
    width: Math.max(200, Math.min(bounds.width, winBounds.width)),
    height: Math.max(150, Math.min(bounds.height, winBounds.height - MINI_BROWSER_TOOLBAR_HEIGHT)),
  };
  if (
    lastMiniBrowserBounds &&
    lastMiniBrowserBounds.x === clamped.x &&
    lastMiniBrowserBounds.y === clamped.y &&
    lastMiniBrowserBounds.width === clamped.width &&
    lastMiniBrowserBounds.height === clamped.height
  ) {
    return;
  }
  lastMiniBrowserBounds = clamped;
  miniBrowserView.setBounds(clamped);
})

trustedHandle('browser:show', () => {
  if (miniBrowserView && mainWindow) {
    mainWindow.addBrowserView(miniBrowserView)
  }
})

trustedHandle('browser:hide', () => {
  if (miniBrowserView && mainWindow) {
    mainWindow.removeBrowserView(miniBrowserView)
  }
})

// ── Terminal PTY management ──────────────────────────────────────────
// node-pty is a native module — import dynamically so a load failure
// doesn't crash the entire app (only the terminal feature breaks).
let ptyModule: typeof import('node-pty') | null = null
const terminals = new Map<string, import('node-pty').IPty>()
const terminalSizes = new Map<string, { cols: number; rows: number }>()
let terminalIdCounter = 0

async function getPty() {
  if (!ptyModule) {
    ptyModule = await import('node-pty')
  }
  return ptyModule
}

trustedHandle('terminal:spawn', async (_event, options?: { cwd?: string; command?: string }) => {
  const pty = await getPty()
  const id = `term-${++terminalIdCounter}`
  const shellPath = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh'
  const cwd = options?.cwd || app.getPath('home')

  // The per-launch bridge token (electron/bridge.ts) is internal to Electron's
  // bridge manager — strip it (and nothing else) so it never leaks into user
  // terminals. PATH/HOME and any user API keys the shell legitimately needs
  // stay intact.
  const terminalEnv = { ...process.env } as Record<string, string>
  delete terminalEnv.HERMES_BRIDGE_TOKEN

  let term: import('node-pty').IPty
  if (options?.command) {
    // Spawn a shell with a specific command (e.g. hermes bridge)
    term = pty.spawn(shellPath, ['-c', options.command], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: terminalEnv,
    })
  } else {
    // Default: interactive shell
    term = pty.spawn(shellPath, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: terminalEnv,
    })
  }

  terminals.set(id, term)

  term.onData((data: string) => {
    mainWindow?.webContents.send('terminal:data', id, data)
  })

  term.onExit(({ exitCode }: { exitCode: number }) => {
    terminals.delete(id)
    terminalSizes.delete(id)
    mainWindow?.webContents.send('terminal:exit', id, exitCode)
  })

  return { id }
})

ipcMain.on('terminal:write', (event, id: string, data: string) => {
  if (!isTrustedSender(event)) return
  terminals.get(id)?.write(data)
})

ipcMain.on('terminal:resize', (event, id: string, cols: number, rows: number) => {
  if (!isTrustedSender(event)) return
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return
  const previous = terminalSizes.get(id)
  if (previous?.cols === cols && previous.rows === rows) return
  terminalSizes.set(id, { cols, rows })
  terminals.get(id)?.resize(cols, rows)
})

ipcMain.on('terminal:kill', (event, id: string) => {
  if (!isTrustedSender(event)) return
  terminals.get(id)?.kill()
  terminals.delete(id)
  terminalSizes.delete(id)
})

function createTray() {
  // Use a 16x16 template image for macOS menu bar (or empty placeholder until icon exists)
  const trayTemplatePath = resolveIconPath('spark-tray-iconTemplate.png')
  const trayFallbackPath = resolveIconPath('spark-icon.png')
  const trayIconPath = existsSync(trayTemplatePath) ? trayTemplatePath : trayFallbackPath
  let icon: Electron.NativeImage
  try {
    icon = nativeImage.createFromPath(trayIconPath)
    if (process.platform === 'darwin' && trayIconPath === trayTemplatePath) {
      icon.setTemplateImage(true)
      // 51px source sized for menu bar with retina support
    }
  } catch {
    icon = nativeImage.createEmpty()
  }
  tray = new Tray(icon)
  tray.setToolTip('Spark')

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Spark', click: () => focusMainWindow() },
    { label: 'New Chat', click: () => mainWindow?.webContents.send('new-chat') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
  tray.setContextMenu(contextMenu)
}

function setupDockMenu() {
  if (process.platform === 'darwin') {
    const dockMenu = Menu.buildFromTemplate([
      { label: 'New Chat', click: () => mainWindow?.webContents.send('new-chat') }
    ])
    app.dock?.setMenu(dockMenu)
  }
}

function registerGlobalShortcut() {
  // Phase 4: Cmd/Ctrl+Shift+Space toggles the quick-capture window. This
  // REPLACES the previous main-window show/hide toggle on this shortcut —
  // the tray icon ("Show Spark") and macOS dock/activate path keep main-window
  // access via focusMainWindow().
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    void toggleQuickWindow()
  })
}

// ── spark:// protocol + single-instance (Phase 4) ─────────────────────────
// Requested at module scope (before ready) so a second launch forwards its
// URL to the primary instance instead of opening a duplicate window.
let gotSingleInstanceLock = true
try {
  gotSingleInstanceLock = app.requestSingleInstanceLock()
} catch (err) {
  console.warn('[deep-link] requestSingleInstanceLock failed:', err)
}
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  // Windows/Linux deliver deep links as argv on a second launch.
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((arg) => typeof arg === 'string' && arg.startsWith('spark://'))
    if (url) {
      void handleSparkUrl(url)
    } else if (mainWindow) {
      void focusMainWindow()
    }
  })
  // macOS delivers deep links via open-url (also when already running).
  app.on('open-url', (event, url) => {
    event.preventDefault()
    void handleSparkUrl(url)
  })
}

// macOS: About panel
app.setAboutPanelOptions({
  applicationName: 'Spark',
  applicationVersion: app.getVersion(),
  copyright: 'Spark',
  version: process.versions.electron
})

app.whenReady().then(async () => {
  registerLocalAssetProtocol()
  applyAppIcon()
  // Register the CSP header injection once — createWindow() can run multiple
  // times on macOS, and a per-window registration would stack listeners.
  registerCspHeaders()

  // Claim spark:// links (dev too — warn instead of failing silently if the
  // OS refuses, since dev runs typically aren't the registered handler).
  try {
    const registered = app.setAsDefaultProtocolClient('spark')
    if (!registered) {
      console.warn('[deep-link] setAsDefaultProtocolClient returned false — spark:// links may not open this build (expected in dev)')
    }
  } catch (err) {
    console.warn('[deep-link] setAsDefaultProtocolClient failed:', err)
  }

  // Create the window first so the UI paints immediately — startBridge() can
  // block for up to 30s waiting for the bridge to become healthy.
  await createWindow()
  createTray()
  setupDockMenu()
  registerGlobalShortcut()

  // Start the Hermes bridge in the background so /api/hermes/* proxies don't
  // 502 while ChatInput and the status pill poll on first paint. The renderer
  // already polls bridge:status.
  startBridge()
    .then((result) => {
      console.log('[bridge] startup result:', result.status, result.message ?? '')
    })
    .catch((err) => {
      console.error('[bridge] startup failed:', err)
    })

  // Auto-updates (skip in dev)
  if (!is.dev) {
    const { setupAutoUpdater } = await import('./updater')
    setupAutoUpdater(mainWindow!)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      focusMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // On macOS, keep app running in background (standard behavior)
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In dev, Ctrl+C in the terminal sends SIGINT to the whole process group.
// Electron's main process ignores it by default, which leaves the window up
// and causes `concurrently` to hang waiting for us. Translate the signal
// into a proper quit so `before-quit` cleanup runs and electron-vite exits.
let isQuitting = false
if (is.dev) {
  const quitOnSignal = (signal: NodeJS.Signals) => {
    if (isQuitting) return
    console.log(`[electron] received ${signal}, quitting`)
    app.quit()
  }
  process.once('SIGINT', () => quitOnSignal('SIGINT'))
  process.once('SIGTERM', () => quitOnSignal('SIGTERM'))
  process.once('SIGHUP', () => quitOnSignal('SIGHUP'))
}

// Swallow pino transport teardown noise so it never surfaces as a crash modal.
// thread-stream emits (doesn't throw) when the worker is ending, which becomes
// an uncaughtException if nothing handles the stream error.
process.on('uncaughtException', (err) => {
  const msg = err instanceof Error ? err.message : String(err)
  if (/worker is ending|worker has exited/i.test(msg)) {
    return
  }
  console.error('[electron] uncaughtException:', err)
})

// Fire-and-forget promises (e.g. void loadURL(...), the background bridge
// start) can reject; in current Electron an unhandled rejection can terminate
// the main process. Never let that take the app down.
process.on('unhandledRejection', (reason) => {
  console.error('[electron] unhandledRejection:', reason)
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// Cleanup preview-manager child processes on quit
app.on('before-quit', () => {
  isQuitting = true
  // Dispose the quick-capture window (kept independent of the main window
  // during the session; torn down here with app quit).
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.close()
  }
  quickWindow = null
  // Destroy mini browser view
  if (miniBrowserView) {
    if (mainWindow) {
      mainWindow.removeBrowserView(miniBrowserView)
    }
    miniBrowserView.webContents.close()
    miniBrowserView = null
  }
  // Kill all terminal PTY processes
  for (const [, term] of terminals) {
    term.kill()
  }
  terminals.clear()
  // Tear down the Hermes bridge cleanly
  try {
    stopBridge()
  } catch (err) {
    console.warn('[electron] stopBridge failed:', err)
  }
  void mcpWorkerManager.dispose()
  // Notify embedded server stores to close DBs without going through pino.
  try {
    process.emit('SIGTERM', 'SIGTERM')
  } catch {
    /* ignore */
  }
})

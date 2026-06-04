import { app, BrowserView, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Notification, Tray, nativeImage, net, protocol, shell } from 'electron'
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

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let apiPort: number = 3001
let dockBounceId: number | null = null
let miniBrowserView: BrowserView | null = null
let lastMiniBrowserBounds: Electron.Rectangle | null = null
const dockIconPath = join(__dirname, '../../build/spark-icon.png')
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

  console.warn(
    'Preload bundle was not ready before BrowserWindow creation. Falling back to the expected output path.',
    preloadPathCandidates
  )
  return preloadPathCandidates[0]
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

ipcMain.handle('cloudchat:snapshotLocalImage', async (_event, inputPath: string) => {
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

  // Start embedded Express server
  apiPort = await startEmbeddedServer()
  console.log(`Embedded server started on port ${apiPort}`)

  // Set port in env so preload can read it synchronously
  process.env.ELECTRON_API_PORT = String(apiPort)
  const preloadPath = await resolvePreloadPath()
  console.log(`Using preload script: ${preloadPath}`)

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    ...(existsSync(dockIconPath) ? { icon: dockIconPath } : {}),
    title: 'Spark',
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      sandbox: false // Required: preload needs process.env for API port
    }
  })

  // Grant microphone + clipboard permission requests from the renderer
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      if (permission === 'media' || permission === 'clipboard-sanitized-write' || permission === 'clipboard-read') {
        callback(true)
      } else {
        callback(false)
      }
    }
  )

  // Content Security Policy — only apply to the main window, not the BrowserView
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    // Skip CSP injection for BrowserView (mini browser) — it needs full web access for sites like YouTube
    if (miniBrowserView && details.webContentsId === miniBrowserView.webContents.id) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    // Also skip for any non-main-window webContents (safety net)
    if (!mainWindow || details.webContentsId !== mainWindow.webContents.id) {
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
            ? " script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net;"
            : " script-src 'self' https://cdn.jsdelivr.net 'sha256-0vw5FNYeotOv1pKtYDJoVY1QPOJ7d3jJvy4jR5P0U2Q=';") +
          " style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net;" +
          " font-src 'self' https://fonts.gstatic.com data:;" +
          " img-src 'self' data: https: http: file: cloudchat-asset:;" +
          " media-src 'self' blob:;" +
          " connect-src 'self' data: http://localhost:* " + (is.dev ? "ws://localhost:* " : "") + "https://api.anthropic.com https://api.openai.com https://api.deepseek.com https://generativelanguage.googleapis.com https://api.minimax.chat https://api.moonshot.cn https://api.x.ai https://openrouter.ai https://api.together.xyz https://api.groq.com https://api.mistral.ai https://api.perplexity.ai https://cdn.jsdelivr.net;" +
          " worker-src 'self' blob:;"
        ]
      }
    })
  })

  // Open external links (e.g. "View on GitHub") in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  // Catch <a target="_blank"> and any navigation away from the app
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appOrigins = ['http://localhost', 'file://', `${CLOUDCHAT_ASSET_PROTOCOL}://`]
    if (!appOrigins.some((origin) => url.startsWith(origin))) {
      event.preventDefault()
      shell.openExternal(url)
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
  if (!existsSync(dockIconPath)) {
    return
  }

  try {
    const icon = nativeImage.createFromPath(dockIconPath)
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

function focusMainWindow() {
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

ipcMain.handle('app:notify-attention', (_event, payload?: AttentionRequestPayload) => {
  notifyAttentionRequest(payload)
})

ipcMain.handle('app:clear-attention', () => {
  clearAttentionRequest()
})

ipcMain.handle('app:get-version', () => app.getVersion())

// ── Hermes Bridge & first-run setup ────────────────────────────────────────
ipcMain.handle('bridge:status', () => getBridgeSetupStatus())
ipcMain.handle('bridge:start', () => startBridge())
ipcMain.handle('bridge:install-deps', async (event) => {
  const send = (line: string) =>
    event.sender.send('bridge:install-progress', line)
  return installBridgeDeps(send)
})
ipcMain.handle('bridge:install-hermes-agent', async (event) => {
  const send = (line: string) =>
    event.sender.send('bridge:install-progress', line)
  return installHermesAgent(send)
})
ipcMain.handle('openrouter:oauth', () => startOpenRouterOAuth())

ipcMain.handle('file:save-dialog', async (_event, payload: { defaultFilename?: string; content?: string }) => {
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

ipcMain.handle('shell:open-external', async (_event, url: string) => {
  if (typeof url !== 'string') return false
  if (!/^(https?:\/\/|file:\/\/\/)/i.test(url)) return false
  try {
    await shell.openExternal(url)
    return true
  } catch {
    return false
  }
})

// ── Mini Browser (BrowserView) management ───────────────────────────
ipcMain.handle('browser:create', (_event, url?: string) => {
  if (!mainWindow) return
  if (miniBrowserView) {
    mainWindow.removeBrowserView(miniBrowserView)
    miniBrowserView.webContents.close()
    miniBrowserView = null
    lastMiniBrowserBounds = null
  }
  miniBrowserView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      sandbox: false, // Disabled: sandbox blocks media playback (YouTube, etc.)
      plugins: true,  // Allow media plugins if needed
    }
  })
  mainWindow.addBrowserView(miniBrowserView)
  // Use getContentBounds() — BrowserView coords are relative to content area, not window frame
  const bounds = mainWindow.getContentBounds()
  const TOOLBAR_HEIGHT = 36
  // Default: bottom-right corner, 600x400, with some padding from edges
  lastMiniBrowserBounds = {
    x: bounds.width - 620,
    y: bounds.height - 460 + TOOLBAR_HEIGHT,
    width: 600,
    height: 400 - TOOLBAR_HEIGHT,
  }
  miniBrowserView.setBounds(lastMiniBrowserBounds)
  miniBrowserView.setAutoResize({ width: false, height: false })
  const initialUrl = url || 'about:blank'
  if (initialUrl !== 'about:blank') {
    try {
      const parsed = new URL(initialUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        console.warn('Blocked creation with non-http URL:', initialUrl);
        return;
      }
    } catch {
      console.warn('Invalid URL:', initialUrl);
      return;
    }
  }
  miniBrowserView.webContents.loadURL(initialUrl)
})

ipcMain.handle('browser:navigate', (_event, url: string) => {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      console.warn('Blocked navigation to non-http URL:', url);
      return;
    }
  } catch {
    console.warn('Invalid URL:', url);
    return;
  }
  miniBrowserView?.webContents.loadURL(url)
})

ipcMain.handle('browser:go-back', () => {
  if (miniBrowserView?.webContents.canGoBack()) {
    miniBrowserView.webContents.goBack()
  }
})

ipcMain.handle('browser:go-forward', () => {
  if (miniBrowserView?.webContents.canGoForward()) {
    miniBrowserView.webContents.goForward()
  }
})

ipcMain.handle('browser:close', () => {
  if (miniBrowserView && mainWindow) {
    mainWindow.removeBrowserView(miniBrowserView)
    miniBrowserView.webContents.close()
    miniBrowserView = null
    lastMiniBrowserBounds = null
  }
})

ipcMain.handle('browser:resize', (_event, bounds: { x: number; y: number; width: number; height: number }) => {
  if (!miniBrowserView || !mainWindow) return;
  const winBounds = mainWindow.getContentBounds();
  // BrowserView y must account for the 36px toolbar — never let it overlap the URL bar.
  // bounds.y is already the BrowserView's y (passed from renderer as position.y + TOOLBAR_HEIGHT).
  // Just clamp to stay below toolbar area and within window.
  const TOOLBAR_HEIGHT = 36;
  const clamped = {
    x: Math.max(0, Math.min(bounds.x, winBounds.width - bounds.width)),
    y: Math.max(TOOLBAR_HEIGHT, Math.min(bounds.y, winBounds.height - 100)),
    width: Math.max(200, Math.min(bounds.width, winBounds.width)),
    height: Math.max(150, Math.min(bounds.height, winBounds.height - TOOLBAR_HEIGHT)),
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

ipcMain.handle('browser:show', () => {
  if (miniBrowserView && mainWindow) {
    mainWindow.addBrowserView(miniBrowserView)
  }
})

ipcMain.handle('browser:hide', () => {
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

ipcMain.handle('terminal:spawn', async (_event, options?: { cwd?: string; command?: string }) => {
  const pty = await getPty()
  const id = `term-${++terminalIdCounter}`
  const shellPath = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh'
  const cwd = options?.cwd || app.getPath('home')

  let term: import('node-pty').IPty
  if (options?.command) {
    // Spawn a shell with a specific command (e.g. hermes bridge)
    term = pty.spawn(shellPath, ['-c', options.command], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env } as Record<string, string>,
    })
  } else {
    // Default: interactive shell
    term = pty.spawn(shellPath, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env } as Record<string, string>,
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

ipcMain.on('terminal:write', (_event, id: string, data: string) => {
  terminals.get(id)?.write(data)
})

ipcMain.on('terminal:resize', (_event, id: string, cols: number, rows: number) => {
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return
  const previous = terminalSizes.get(id)
  if (previous?.cols === cols && previous.rows === rows) return
  terminalSizes.set(id, { cols, rows })
  terminals.get(id)?.resize(cols, rows)
})

ipcMain.on('terminal:kill', (_event, id: string) => {
  terminals.get(id)?.kill()
  terminals.delete(id)
  terminalSizes.delete(id)
})

function createTray() {
  // Use a 16x16 template image for macOS menu bar (or empty placeholder until icon exists)
  const trayTemplatePath = join(__dirname, '../../build/spark-tray-iconTemplate.png')
  const trayFallbackPath = join(__dirname, '../../build/spark-icon.png')
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
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide()
      } else {
        mainWindow.show()
        mainWindow.focus()
      }
    }
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
  await createWindow()
  createTray()
  setupDockMenu()
  registerGlobalShortcut()

  // Fire-and-forget bridge startup. The renderer's first-run wizard polls
  // bridge:status and surfaces failures; we don't block window display on it.
  startBridge()
    .then((r) => console.log('[bridge] startup result:', r.status, r.message ?? ''))
    .catch((err) => console.warn('[bridge] startup threw', err))

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
if (is.dev) {
  const quitOnSignal = (signal: NodeJS.Signals) => {
    console.log(`[electron] received ${signal}, quitting`)
    app.quit()
  }
  process.once('SIGINT', () => quitOnSignal('SIGINT'))
  process.once('SIGTERM', () => quitOnSignal('SIGTERM'))
  process.once('SIGHUP', () => quitOnSignal('SIGHUP'))
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// Cleanup preview-manager child processes on quit
app.on('before-quit', () => {
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
  stopBridge()
  process.emit('SIGINT', 'SIGINT')
})

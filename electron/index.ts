import { app, BrowserView, BrowserWindow, globalShortcut, ipcMain, Menu, Notification, Tray, nativeImage, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { startEmbeddedServer } from './server'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let apiPort: number = 3001
let dockBounceId: number | null = null
let miniBrowserView: BrowserView | null = null
const dockIconPath = join(__dirname, '../../build/icon.png')

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

async function createWindow() {
  process.env.CLOUDCHAT_USER_DATA_DIR = app.getPath('userData')

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
    title: 'CloudChat',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false // Required: preload needs process.env for API port
    }
  })

  // Content Security Policy — only apply to the main window, not the BrowserView
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    // Skip CSP injection for BrowserView (mini browser) — it needs full web access for sites like YouTube
    if (miniBrowserView && details.webContentsId === miniBrowserView.webContents.id) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    // Also skip for any non-main-window webContents (safety net)
    if (details.webContentsId !== mainWindow.webContents.id) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self';" +
          " script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;" +
          " style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net;" +
          " font-src 'self' https://fonts.gstatic.com data:;" +
          " img-src 'self' data: https: http:;" +
          " connect-src 'self' data: http://localhost:* https://* https://cdn.jsdelivr.net;" +
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
    const appOrigins = ['http://localhost', 'file://']
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
      app.dock.setIcon(icon)
    }
  } catch (error) {
    console.warn('Failed to apply app icon:', error)
  }
}

function clearAttentionRequest() {
  if (process.platform !== 'darwin' || dockBounceId === null) {
    return
  }

  app.dock.cancelBounce(dockBounceId)
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

  const title = payload.title?.trim() || 'CloudChat needs your attention'
  const body = payload.body?.trim() || 'A conversation is waiting for your confirmation.'

  if (process.platform === 'darwin' && dockBounceId === null) {
    dockBounceId = app.dock.bounce('informational')
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

// ── Mini Browser (BrowserView) management ───────────────────────────
ipcMain.handle('browser:create', (_event, url?: string) => {
  if (!mainWindow) return
  if (miniBrowserView) {
    mainWindow.removeBrowserView(miniBrowserView)
    miniBrowserView.webContents.close()
    miniBrowserView = null
  }
  miniBrowserView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // Disabled: sandbox blocks media playback (YouTube, etc.)
      plugins: true,  // Allow media plugins if needed
    }
  })
  mainWindow.addBrowserView(miniBrowserView)
  // Use getContentBounds() — BrowserView coords are relative to content area, not window frame
  const bounds = mainWindow.getContentBounds()
  const TOOLBAR_HEIGHT = 36
  // Default: bottom-right corner, 600x400, with some padding from edges
  miniBrowserView.setBounds({
    x: bounds.width - 620,
    y: bounds.height - 460 + TOOLBAR_HEIGHT,
    width: 600,
    height: 400 - TOOLBAR_HEIGHT,
  })
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
    mainWindow?.webContents.send('terminal:exit', id, exitCode)
  })

  return { id }
})

ipcMain.on('terminal:write', (_event, id: string, data: string) => {
  terminals.get(id)?.write(data)
})

ipcMain.on('terminal:resize', (_event, id: string, cols: number, rows: number) => {
  terminals.get(id)?.resize(cols, rows)
})

ipcMain.on('terminal:kill', (_event, id: string) => {
  terminals.get(id)?.kill()
  terminals.delete(id)
})

function createTray() {
  // Use a 16x16 template image for macOS menu bar (or empty placeholder until icon exists)
  const trayTemplatePath = join(__dirname, '../../build/tray-iconTemplate.png')
  const trayFallbackPath = join(__dirname, '../../build/tray-icon.png')
  const trayIconPath = existsSync(trayTemplatePath) ? trayTemplatePath : trayFallbackPath
  let icon: Electron.NativeImage
  try {
    icon = nativeImage.createFromPath(trayIconPath)
    if (process.platform === 'darwin' && trayIconPath === trayTemplatePath) {
      icon.setTemplateImage(true)
      // Let macOS size the template image natively for both 1x and 2x menu bar.
      // The 64px source provides enough resolution; resizing to 18 made it too small.
    }
  } catch {
    icon = nativeImage.createEmpty()
  }
  tray = new Tray(icon)
  tray.setToolTip('CloudChat')

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show CloudChat', click: () => focusMainWindow() },
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
    app.dock.setMenu(dockMenu)
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
  applicationName: 'CloudChat',
  applicationVersion: app.getVersion(),
  copyright: 'CloudChat',
  version: process.versions.electron
})

app.whenReady().then(async () => {
  applyAppIcon()
  await createWindow()
  createTray()
  setupDockMenu()
  registerGlobalShortcut()

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
  process.emit('SIGINT', 'SIGINT')
})

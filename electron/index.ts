import { app, BrowserWindow, globalShortcut, ipcMain, Menu, Notification, Tray, nativeImage, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { startEmbeddedServer } from './server'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let apiPort: number = 3001
let dockBounceId: number | null = null
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

  // Content Security Policy
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
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

ipcMain.handle('terminal:spawn', async (_event, cwd?: string) => {
  const pty = await getPty()
  const id = `term-${++terminalIdCounter}`
  const shellPath = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh'
  const term = pty.spawn(shellPath, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd || app.getPath('home'),
    env: { ...process.env } as Record<string, string>,
  })

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
      icon = icon.resize({ height: 18 })
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
  // Kill all terminal PTY processes
  for (const [, term] of terminals) {
    term.kill()
  }
  terminals.clear()
  process.emit('SIGINT', 'SIGINT')
})

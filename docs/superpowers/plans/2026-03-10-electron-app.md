# CloudChat Electron App — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap CloudChat in Electron so it runs as a self-contained macOS desktop app with native features and auto-updates.

**Architecture:** Embed the existing Express server inside Electron's main process. The React renderer loads from electron-vite's dev server (dev) or bundled files (prod). The API port is passed to the renderer via a URL query parameter that the preload script reads. electron-builder packages the app as DMG + zip for GitHub Releases distribution.

**Tech Stack:** Electron, electron-vite, electron-builder, electron-updater

**Spec:** `docs/superpowers/specs/2026-03-10-electron-app-design.md`

---

## Chunk 1: Foundation — Dependencies, Config, and Server Refactor

### Task 1: Update .gitignore for Electron

**Files:**
- Modify: `.gitignore`

Do this first so build outputs are never accidentally committed.

- [ ] **Step 1: Add Electron-specific entries**

Append to `.gitignore`:

```
# Electron
out/
release/
dist-electron/
```

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: add Electron output directories to gitignore"
```

---

### Task 2: Install Electron dependencies and update package.json metadata

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update package name and version**

In `package.json`, change:
- `"name"` from `"vite_react_shadcn_ts"` to `"cloudchat"`
- `"version"` from `"0.0.0"` to `"1.0.0"`

- [ ] **Step 2: Install production dependency**

```bash
npm install electron-updater
```

- [ ] **Step 3: Install dev dependencies**

```bash
npm install -D electron electron-vite electron-builder @electron-toolkit/utils
```

- [ ] **Step 4: Verify installation**

```bash
npx electron --version
npx electron-vite --version
```

Expected: Version numbers printed without errors.

- [ ] **Step 5: Add Electron scripts and main field to package.json**

Add to `"scripts"`:

```json
"electron:dev": "electron-vite dev",
"electron:build": "electron-vite build && electron-builder --mac",
"electron:publish": "electron-vite build && electron-builder --mac --publish always"
```

Add top-level field:

```json
"main": "out/main/index.js"
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add Electron dependencies, scripts, and update package metadata"
```

---

### Task 3: Create electron-vite config

**Files:**
- Create: `electron.vite.config.ts`

- [ ] **Step 1: Create the config file**

`electron.vite.config.ts` must replicate the existing `vite.config.ts` plugins and aliases for the renderer. The main process config externalizes server dependencies so they resolve at runtime from the packaged app's `node_modules`. The `../server/index` import is also externalized so it is not bundled — it will be loaded at runtime from the app directory.

```ts
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Externalize server code so it loads at runtime from the packaged app
        external: [
          'express', 'cors', '@ai-sdk/openai', '@ai-sdk/anthropic', 'ai', 'zod',
          /\.\.\/server\/.*/
        ]
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: '.',
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html')
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src')
      }
    }
    // Note: PostCSS/Tailwind auto-discovered from project root (postcss.config.js / tailwind.config.ts)
    // lovable-tagger intentionally omitted — dev convenience for web workflow only
  }
})
```

- [ ] **Step 2: Verify config parses**

```bash
npx electron-vite build 2>&1 | head -20
```

Expected: Build starts (may fail if electron/ files don't exist yet, but config parsing should succeed).

- [ ] **Step 3: Commit**

```bash
git add electron.vite.config.ts
git commit -m "chore: add electron-vite config for main/preload/renderer"
```

---

### Task 4: Refactor server/index.ts to support embedded mode

**Files:**
- Modify: `server/index.ts:1-17,1181-1192`
- Create: `server/__tests__/server-exports.test.ts`

The goal: export the Express `app` and a `startServer()` function, while preserving standalone behavior when run directly via `npm run server`.

- [ ] **Step 1: Write a test for the server module exports**

Create `server/__tests__/server-exports.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('server exports', () => {
  it('exports createApp and startServer functions', async () => {
    const serverModule = await import('../index')
    expect(typeof serverModule.createApp).toBe('function')
    expect(typeof serverModule.startServer).toBe('function')
  })

  it('createApp returns an express app with listen method', async () => {
    const { createApp } = await import('../index')
    const app = createApp()
    expect(app).toBeDefined()
    expect(typeof app.listen).toBe('function')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run server/__tests__/server-exports.test.ts
```

Expected: FAIL — `createApp` and `startServer` are not exported.

- [ ] **Step 3: Refactor server/index.ts**

Wrap the Express app setup in an exported `createApp()` function. All route registrations move inside it. The standalone `app` and `PORT` variables at the top are removed.

At the top of the file, replace:

```ts
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
```

With:

```ts
export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
```

All existing route registrations (`app.post(...)`) remain inside `createApp()`. At the end of the function (before the old `app.listen` block), add:

```ts
  return app;
}
```

Add the `startServer` function and the standalone guard:

```ts
export function startServer(port?: number) {
  const resolvedPort = port || process.env.PORT || 3001;
  const app = createApp();
  return new Promise<{ app: typeof app; port: number }>((resolve) => {
    app.listen(resolvedPort, () => {
      console.log(`Local API server running on http://localhost:${resolvedPort}`);
      console.log('Routes:');
      console.log('  POST /functions/v1/chat');
      console.log('  POST /functions/v1/orchestrate');
      console.log('  POST /functions/v1/github-integration');
      console.log('  POST /functions/v1/github-analyzer');
      console.log('  POST /functions/v1/validate-key');
      console.log('  POST /functions/v1/chat-proxy');
      resolve({ app, port: Number(resolvedPort) });
    });
  });
}

// Auto-start when run directly (npm run server), not when imported by Electron
const isElectron = typeof process !== 'undefined' && !!process.versions?.electron;
if (!isElectron) {
  // Check if this module is the entry point (ESM: compare import.meta.url to argv)
  const isEntry = process.argv[1] && import.meta.url.includes(process.argv[1].replace(/\\/g, '/'));
  if (isEntry) {
    startServer();
  }
}
```

Remove the old `app.listen(PORT, ...)` block at the bottom (lines 1183-1192).

Keep `corsHeaders`, `sendJson()`, `getUnknownErrorMessage()`, `createFilteredStream()` and the provider-config imports at module scope — they don't reference `app` and are used by route handlers via closure.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run server/__tests__/server-exports.test.ts
```

Expected: PASS.

- [ ] **Step 5: Verify standalone mode still works**

```bash
npx tsx server/index.ts &
sleep 2
curl -s http://localhost:3001/functions/v1/validate-key -X POST -H 'Content-Type: application/json' -d '{"provider":"openai","api_key":"test"}' | head -c 200
kill %1
```

Expected: Server starts, responds to HTTP request.

- [ ] **Step 6: Commit**

```bash
git add server/index.ts server/__tests__/server-exports.test.ts
git commit -m "refactor: export createApp and startServer from server for Electron embedding"
```

---

### Task 5: Update API base URL to support Electron context

**Files:**
- Create: `src/electron.d.ts`
- Modify: `src/lib/api.ts:6-8`

- [ ] **Step 1: Add type declaration for electronAPI**

Create `src/electron.d.ts`:

```ts
export interface ElectronAPI {
  versions: {
    electron: string
    node: string
    chrome: string
  }
  platform: string
  apiPort: number
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}
```

- [ ] **Step 2: Update getApiBaseUrl**

In `src/lib/api.ts`, change:

```ts
export function getApiBaseUrl(): string {
  return import.meta.env.VITE_API_URL || 'http://localhost:3001';
}
```

To:

```ts
export function getApiBaseUrl(): string {
  if (window.electronAPI?.apiPort) {
    return `http://localhost:${window.electronAPI.apiPort}`;
  }
  return import.meta.env.VITE_API_URL || 'http://localhost:3001';
}
```

- [ ] **Step 3: Verify web mode still works**

```bash
npm run build
```

Expected: Build succeeds. `window.electronAPI` is `undefined` in browser, so the fallback path is used.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts src/electron.d.ts
git commit -m "feat: support dynamic API port from Electron preload"
```

---

## Chunk 2: Electron Shell — Main Process, Preload, and Server Wrapper

### Task 6: Create the preload script

**Files:**
- Create: `electron/preload.ts`

- [ ] **Step 1: Create electron directory**

```bash
mkdir -p electron
```

- [ ] **Step 2: Write the preload script**

The preload runs with `sandbox: false` (see Task 8 for why). It reads the API port from `process.env.ELECTRON_API_PORT` which the main process sets before creating the window.

`electron/preload.ts`:

```ts
import { contextBridge } from 'electron'

// Main process sets ELECTRON_API_PORT env var before creating BrowserWindow
const apiPort = Number(process.env.ELECTRON_API_PORT) || 3001

contextBridge.exposeInMainWorld('electronAPI', {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  },
  platform: process.platform,
  apiPort
})
```

- [ ] **Step 3: Commit**

```bash
git add electron/preload.ts
git commit -m "feat: add Electron preload script with contextBridge API"
```

---

### Task 7: Create the server wrapper

**Files:**
- Create: `electron/server.ts`

- [ ] **Step 1: Write the server wrapper**

`electron/server.ts`:

```ts
import net from 'net'
import { app } from 'electron'
import { join } from 'path'

/**
 * Find a free port, starting from the preferred port.
 */
function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(preferred, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : preferred
      server.close(() => resolve(port))
    })
    server.on('error', () => {
      // Preferred port in use, let OS assign one
      const server2 = net.createServer()
      server2.listen(0, () => {
        const address = server2.address()
        const port = typeof address === 'object' && address ? address.port : 0
        server2.close(() => resolve(port))
      })
      server2.on('error', reject)
    })
  })
}

/**
 * Start the embedded Express server.
 * Resolves the server/index path relative to the app root so it works
 * both in dev (source tree) and prod (packaged app).
 */
export async function startEmbeddedServer(): Promise<number> {
  const port = await findFreePort(3001)

  // In production, app.getAppPath() points to the asar/unpacked app root.
  // In dev, it points to the project root. Either way, server/index is there.
  const serverPath = join(app.getAppPath(), 'server', 'index')
  const { startServer } = await import(serverPath)
  await startServer(port)
  return port
}
```

- [ ] **Step 2: Commit**

```bash
git add electron/server.ts
git commit -m "feat: add embedded server wrapper with dynamic port allocation"
```

---

### Task 8: Create the Electron main process

**Files:**
- Create: `electron/main.ts`

- [ ] **Step 1: Write the main process**

Note on `sandbox`: Set to `false` because the preload needs `process.env` to read the API port. `nodeIntegration` remains `false` and `contextIsolation` remains `true`, so the renderer is still isolated. This is the standard electron-vite approach.

`electron/main.ts`:

```ts
import { app, BrowserWindow, globalShortcut, Menu, Tray, nativeImage, Notification } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { startEmbeddedServer } from './server'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let apiPort: number = 3001

async function createWindow() {
  // Start embedded Express server
  apiPort = await startEmbeddedServer()
  console.log(`Embedded server started on port ${apiPort}`)

  // Set port in env so preload can read it synchronously
  process.env.ELECTRON_API_PORT = String(apiPort)

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'CloudChat',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
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
          " connect-src 'self' http://localhost:* https://* https://cdn.jsdelivr.net;" +
          " worker-src 'self' blob:;"
        ]
      }
    })
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createTray() {
  // Use a 16x16 template image for macOS menu bar (or empty placeholder until icon exists)
  const trayIconPath = join(__dirname, '../../build/tray-icon.png')
  let icon: Electron.NativeImage
  try {
    icon = nativeImage.createFromPath(trayIconPath)
  } catch {
    icon = nativeImage.createEmpty()
  }
  tray = new Tray(icon)
  tray.setToolTip('CloudChat')

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show CloudChat', click: () => mainWindow?.show() },
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
      mainWindow?.show()
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
  // Send kill signal to any spawned preview processes
  // The preview-manager's SIGINT handler may not fire in Electron,
  // so we handle cleanup here
  process.emit('SIGINT' as any)
})
```

- [ ] **Step 2: Commit**

```bash
git add electron/main.ts
git commit -m "feat: add Electron main process with window, tray, dock menu, global shortcut, and CSP"
```

---

## Chunk 3: Packaging, Auto-Updates, and First Launch

### Task 9: Add auto-updater

**Files:**
- Create: `electron/updater.ts`

- [ ] **Step 1: Create the updater module**

`electron/updater.ts`:

```ts
import { autoUpdater } from 'electron-updater'
import { dialog, BrowserWindow } from 'electron'

export function setupAutoUpdater(mainWindow: BrowserWindow) {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    console.log(`Update available: ${info.version}`)
  })

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'Restart CloudChat to install the update.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall()
      }
    })
  })

  autoUpdater.on('error', (error) => {
    console.error('Auto-updater error:', error)
  })

  // Check for updates (silently fails if no internet or no releases)
  autoUpdater.checkForUpdates().catch(() => {})
}
```

- [ ] **Step 2: Commit**

```bash
git add electron/updater.ts
git commit -m "feat: add auto-updater with GitHub Releases integration"
```

---

### Task 10: Add electron-builder config

**Files:**
- Create: `electron-builder.yml`
- Create: `build/entitlements.mac.plist`

- [ ] **Step 1: Create electron-builder.yml**

```yaml
appId: com.cloudchat.app
productName: CloudChat
directories:
  buildResources: build
  output: release
files:
  - "out/**"
  - "server/**"
  - "node_modules/**"
  - "package.json"
  - "!**/.git"
  - "!**/node_modules/.cache"
  - "!docs/**"
  - "!src/**"
  - "!electron/**"
  - "!**/*.map"
  - "!**/*.test.*"
  - "!**/__tests__/**"
mac:
  target:
    - target: dmg
      arch: [universal]
    - target: zip
      arch: [universal]
  category: public.app-category.developer-tools
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  hardenedRuntime: true
  gatekeeperAssess: false
dmg:
  artifactName: "CloudChat-${version}-mac.${ext}"
publish:
  provider: github
  owner: devgwardo
  repo: cloud-chat-hub
npmRebuild: false
asar: true
asarUnpack:
  - "server/**"
  - "node_modules/express/**"
  - "node_modules/cors/**"
```

- [ ] **Step 2: Create entitlements plist**

```bash
mkdir -p build
```

`build/entitlements.mac.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.network.server</key>
    <true/>
</dict>
</plist>
```

- [ ] **Step 3: Commit**

```bash
git add electron-builder.yml build/entitlements.mac.plist
git commit -m "chore: add electron-builder config and macOS entitlements"
```

---

### Task 11: Add TypeScript config for Electron files

**Files:**
- Create: `tsconfig.electron.json`

- [ ] **Step 1: Create the tsconfig**

`tsconfig.electron.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "strict": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["node"]
  },
  "include": ["electron/**/*.ts", "server/**/*.ts"]
}
```

- [ ] **Step 2: Commit**

```bash
git add tsconfig.electron.json
git commit -m "chore: add TypeScript config for Electron main/preload"
```

---

### Task 12: First dev launch test

This is the integration test — verify everything works together.

- [ ] **Step 1: Run electron-vite dev**

```bash
npm run electron:dev
```

Expected:
- electron-vite compiles main, preload, and renderer
- Electron window opens with CloudChat UI
- Express server is running (check terminal output for "Embedded server started on port XXXX")
- **Verify Tailwind styles render correctly** (not raw unstyled HTML)
- Chat functionality works (type a message, get a response if API key is configured)

- [ ] **Step 2: Verify global shortcut**

Press `Cmd+Shift+Space` — window should hide. Press again — window should show.

- [ ] **Step 3: Verify tray and dock menu**

- Check macOS menu bar for tray icon
- Right-click dock icon — should show "New Chat" option

- [ ] **Step 4: Verify web mode still works**

In a separate terminal:

```bash
npm run server &
npm run dev
```

Open `http://localhost:8080` in a browser — everything should work as before.

- [ ] **Step 5: Commit any fixes needed**

```bash
git add -A
git commit -m "fix: resolve issues from first Electron dev launch"
```

(Only if fixes were needed.)

---

### Task 13: Production build test

- [ ] **Step 1: Build the Electron app**

```bash
npm run electron:build
```

Expected: `release/` directory contains a `.dmg` and `.zip` file.

- [ ] **Step 2: Install and test the DMG**

Open the `.dmg`, drag CloudChat to Applications, launch it. Verify:
- App opens without errors
- Chat works (embedded server is running)
- Tray icon appears
- Global shortcut works
- About menu shows version info

- [ ] **Step 3: Commit any fixes needed**

```bash
git add -A
git commit -m "fix: resolve issues from production build test"
```

(Only if fixes were needed.)

---

## Chunk 4: Polish

### Task 14: Add app icon

**Files:**
- Create: `build/icon.png` (source, 1024x1024)
- Create: `build/icon.icns` (generated)
- Create: `build/tray-icon.png` (16x16 template icon for menu bar)

- [ ] **Step 1: Create or source an app icon**

You need a 1024x1024 PNG. Either design one or use a placeholder. Place it at `build/icon.png`.

Also create a 16x16 PNG for the tray at `build/tray-icon.png` (should work as a macOS template image — use a monochrome design).

- [ ] **Step 2: Generate .icns from PNG**

```bash
mkdir -p build/icon.iconset
sips -z 16 16     build/icon.png --out build/icon.iconset/icon_16x16.png
sips -z 32 32     build/icon.png --out build/icon.iconset/icon_16x16@2x.png
sips -z 32 32     build/icon.png --out build/icon.iconset/icon_32x32.png
sips -z 64 64     build/icon.png --out build/icon.iconset/icon_32x32@2x.png
sips -z 128 128   build/icon.png --out build/icon.iconset/icon_128x128.png
sips -z 256 256   build/icon.png --out build/icon.iconset/icon_128x128@2x.png
sips -z 256 256   build/icon.png --out build/icon.iconset/icon_256x256.png
sips -z 512 512   build/icon.png --out build/icon.iconset/icon_256x256@2x.png
sips -z 512 512   build/icon.png --out build/icon.iconset/icon_512x512.png
sips -z 1024 1024 build/icon.png --out build/icon.iconset/icon_512x512@2x.png
iconutil -c icns build/icon.iconset -o build/icon.icns
rm -rf build/icon.iconset
```

- [ ] **Step 3: Commit**

```bash
git add build/icon.png build/icon.icns build/tray-icon.png
git commit -m "chore: add macOS app icon and tray icon"
```

---

### Task 15: Final integration test

- [ ] **Step 1: Clean build**

```bash
rm -rf out/ release/ node_modules/.cache
npm run electron:build
```

- [ ] **Step 2: Test DMG**

Open DMG, install, launch. Full test:
- App starts without errors
- Chat works end-to-end
- GitHub integration works (if PAT configured)
- Code preview sidebar works
- Theme switching works (light/dark/system)
- Tailwind styles render correctly
- System tray shows with icon
- Dock menu shows "New Chat"
- `Cmd+Shift+Space` toggles window
- About panel shows version

- [ ] **Step 3: Test web mode unaffected**

```bash
npm run server &
npm run dev
```

Browser at `http://localhost:8080` works as before.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: CloudChat Electron app — macOS desktop build with auto-updates"
```

# CloudChat Electron App — Design Spec

## Overview

Convert CloudChat from a browser-based app (React SPA + Express server) into a native macOS desktop application using Electron. The app will be distributed as a DMG with auto-updates via GitHub Releases.

## Goals

- **Distribution:** Installable macOS desktop app with auto-updates
- **Native features:** System tray, dock menu, notifications, global shortcuts
- **Self-contained:** Frontend + backend bundled in a single process — no two-terminal setup
- **Minimal disruption:** Existing web workflow (`npm run dev` + `npm run server`) preserved

## Tech Stack

| Tool | Purpose |
|------|---------|
| Electron | Desktop shell (Chromium + Node.js) |
| electron-vite | Unified Vite build for main/preload/renderer |
| electron-builder | Packaging (DMG + zip for macOS) |
| electron-updater | Auto-updates from GitHub Releases |

## Architecture

### Project Structure

```
cloud-chat-hub/
├── electron/
│   ├── main.ts              # Main process (window, lifecycle, native features, updater)
│   ├── preload.ts            # Preload script (contextBridge for platform info + API port)
│   └── server.ts             # Embeds Express server with dynamic port
├── server/
│   └── index.ts              # Existing Express (refactored to export app + startServer)
├── src/                      # Existing React app (minimal changes)
├── build/
│   └── icon.icns             # macOS app icon
├── electron.vite.config.ts   # Unified Vite config (main/preload/renderer)
├── electron-builder.yml      # Packaging & distribution config
└── package.json              # Updated with Electron deps & scripts
```

### Main Process (`electron/main.ts`)

Responsibilities:
- Create BrowserWindow (1400x900, min size, titlebar styling)
- Start embedded Express server before loading renderer
- In dev: load electron-vite's renderer dev server URL. In prod: load bundled `index.html`
- Shut down Express server on app quit

Security settings (`webPreferences`):
- `nodeIntegration: false` (explicit)
- `contextIsolation: true` (explicit)
- `sandbox: true`
- Content Security Policy allowing `fonts.googleapis.com`, `fonts.gstatic.com`, `cdn.jsdelivr.net` (for Shoelace and Google Fonts)

Native features (initial):
- System tray icon with quick actions (new chat, show/hide window)
- macOS dock menu via `app.dock.setMenu()`
- About panel via `app.setAboutPanelOptions()`
- Native notifications for long-running AI responses (when window unfocused)
- Global shortcut to toggle window (`Cmd+Shift+Space`) — registered via `globalShortcut.register()`, unregistered on quit. Configurable in settings later.
- Auto-updater: check GitHub Releases on launch, prompt to install

### Preload Script (`electron/preload.ts`)

All values exposed via `contextBridge.exposeInMainWorld('electronAPI', ...)`:
- `versions` — Electron/Node/Chrome for about screen
- `platform` — OS info for UI tweaks
- `apiPort` — Dynamic port the embedded server is listening on
- Future IPC methods for Express-to-IPC migration

### Server Wrapper (`electron/server.ts`)

- Imports Express `app` from `server/index.ts`
- Finds a free port (fallback if 3001 is taken)
- Starts listening, returns port to main process
- Main process passes port to renderer via preload's `contextBridge`

Note: `preview-manager.ts` spawns child processes and uses `os.tmpdir()`. In the Electron context, this requires `git` to be on the user's PATH. The preview manager's `SIGINT` handler will be replaced with Electron lifecycle hooks (`app.on('before-quit')`) to avoid conflicts. If preview functionality proves problematic in sandboxed/notarized builds, it can be disabled with a runtime check.

## Changes to Existing Code

### `server/index.ts` (~30-40 lines changed)

Refactor to support both standalone and embedded modes:
- Extract Express app setup and route registration
- Export `app` and `startServer(port?: number)` function
- Guard: if run directly (`npm run server`), auto-start as before

No logic changes — same routes, same handlers.

### `src/lib/api.ts` (~3 lines changed)

- `getApiBaseUrl()` checks for `window.electronAPI?.apiPort` first (via contextBridge)
- Falls back to `VITE_API_URL` as today
- Transparent to rest of app

### `index.html` (no changes needed)

API port is injected via contextBridge in preload, not via script tags. No HTML changes required.

### Everything else

Unchanged. React app, stores, components, hooks, styles — all untouched.

## Build & Development

### `electron.vite.config.ts`

**Important:** electron-vite uses its own config and does NOT read the existing `vite.config.ts`. The renderer config must replicate:
- `@vitejs/plugin-react-swc` (SWC compiler)
- Path alias `@` -> `./src`
- Tailwind CSS / PostCSS setup
- `lovable-tagger` plugin (dev mode only)

The main process config outputs CJS (required by Electron), even though `package.json` has `"type": "module"`. electron-vite handles this transformation.

### Scripts

```json
{
  "electron:dev": "electron-vite dev",
  "electron:build": "electron-vite build && electron-builder --mac",
  "electron:publish": "electron-vite build && electron-builder --mac --publish always"
}
```

### Development

`npm run electron:dev` — Single command starts:
- Main process build (with hot reload)
- Preload build
- Renderer (replicates existing Vite plugins — SWC, Tailwind, HMR)
- Embedded Express server

Replaces current two-terminal workflow for Electron development.

### Existing Web Workflow Preserved

- `npm run dev` — Frontend dev server (browser)
- `npm run server` — Express API server (standalone)
- `npm run build` — Web production build

## Packaging & Distribution

### electron-builder.yml

- **App ID:** `com.cloudchat.app`
- **Product name:** CloudChat
- **macOS targets:** DMG + zip (zip required for auto-updates)
- **Code signing:** Uses Apple Developer identity if available, skips for local builds
- **Notarization:** Requires Apple Developer account with notarytool credentials. Entitlements file at `build/entitlements.mac.plist` with `com.apple.security.cs.allow-jit` and network access entitlements.
- **ASAR:** App code archived, native modules unpacked
- **Excluded:** Dev dependencies, source maps, `.git`, test files

### App Icon

- `.icns` file at `build/icon.icns`
- Generated from PNG source

### Auto-Update Flow

1. App launches, checks GitHub Releases for newer version
2. If found, downloads in background
3. Prompts user: "Update available. Restart to install?"
4. On restart, installs and relaunches

Requires `GH_TOKEN` env var for publishing.

### Offline Considerations

Shoelace assets are loaded from `cdn.jsdelivr.net` in `src/main.tsx`. For offline support, Shoelace assets should be bundled locally (copy to `public/` and update `setBasePath()`). This is a follow-up task — the app will work online without changes.

## Data Storage

IndexedDB data (chat history, conversations) is stored in Electron's `app.getPath('userData')` directory:
- macOS: `~/Library/Application Support/CloudChat/`

This is automatic — no code changes needed. Worth noting for backup/migration purposes.

## Future Path

Migrate from embedded Express to Electron IPC:
- Replace `fetch()` calls with `ipcRenderer.invoke()`
- Move AI provider logic into main process IPC handlers
- Remove Express dependency entirely
- Cleaner architecture, better security (no open localhost port)

This is a follow-up effort, not part of the initial conversion.

## macOS-Specific Notes

The following are macOS-only and would need platform alternatives for future cross-platform support:
- `.icns` icon format (Windows uses `.ico`, Linux uses `.png`)
- `app.dock.setMenu()` (dock is macOS-only)
- DMG packaging target
- Entitlements/notarization workflow

## Dependencies to Add

### Production
- `electron-updater` — Auto-updates

### Development
- `electron` — Desktop shell (devDependency — electron-builder downloads the correct binary during packaging)
- `electron-vite` — Unified Vite build
- `electron-builder` — Packaging
- `electron-icon-builder` — Icon generation (optional)

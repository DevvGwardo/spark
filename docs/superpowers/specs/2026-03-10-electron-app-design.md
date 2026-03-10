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
│   ├── preload.ts            # Preload script (contextBridge for platform info)
│   └── server.ts             # Embeds Express server with dynamic port
├── server/
│   └── index.ts              # Existing Express (refactored to export app + startServer)
├── src/                      # Existing React app (unchanged)
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
- In dev: load `http://localhost:5173` (Vite HMR). In prod: load bundled `index.html`
- Shut down Express server on app quit

Native features (initial):
- System tray icon with quick actions (new chat, show/hide window)
- macOS dock menu
- Native notifications for long-running AI responses (when window unfocused)
- Global shortcut to toggle window (`Cmd+Shift+C`)
- Auto-updater: check GitHub Releases on launch, prompt to install

### Preload Script (`electron/preload.ts`)

Exposes via `contextBridge`:
- `versions` — Electron/Node/Chrome for about screen
- `platform` — OS info for UI tweaks
- `apiPort` — Dynamic port the embedded server is listening on
- Future IPC methods for Express-to-IPC migration

### Server Wrapper (`electron/server.ts`)

- Imports Express `app` from `server/index.ts`
- Finds a free port (fallback if 3001 is taken)
- Starts listening, returns port to main process
- Main process passes port to renderer via preload

## Changes to Existing Code

### `server/index.ts` (~20 lines changed)

Refactor to support both standalone and embedded modes:
- Extract Express app setup and route registration
- Export `app` and `startServer(port?: number)` function
- Guard: if run directly (`npm run server`), auto-start as before

No logic changes — same routes, same handlers.

### `src/lib/providers.ts` (~3 lines changed)

- API base URL falls back to `window.__ELECTRON_API_PORT__` if set
- Otherwise uses `VITE_API_URL` as today
- Transparent to rest of app

### `index.html` (minor addition)

- Conditional script block to set API URL from Electron preload
- No-op when running in browser

### Everything else

Unchanged. React app, stores, components, hooks, styles — all untouched.

## Build & Development

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
- Renderer (existing Vite config with Tailwind, SWC, HMR)
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

## Future Path

Migrate from embedded Express to Electron IPC:
- Replace `fetch()` calls with `ipcRenderer.invoke()`
- Move AI provider logic into main process IPC handlers
- Remove Express dependency entirely
- Cleaner architecture, better security (no open localhost port)

This is a follow-up effort, not part of the initial conversion.

## Dependencies to Add

### Production
- `electron` — Desktop shell
- `electron-updater` — Auto-updates

### Development
- `electron-vite` — Unified Vite build
- `electron-builder` — Packaging
- `electron-icon-builder` — Icon generation (optional)

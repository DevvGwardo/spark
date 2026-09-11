import { contextBridge, ipcRenderer } from 'electron'

// Sandboxed preloads cannot import Node modules (no `os`) and process.env does
// not reliably reach a sandboxed renderer, so the main process passes everything
// we need via webPreferences.additionalArguments, which is appended to
// process.argv in the renderer (available in the sandboxed preload polyfill).
// The old env-var values are kept as fallbacks for unsandboxed/dev scenarios.
function argvValue(flag: string): string | undefined {
  const prefix = `${flag}=`
  const match = process.argv.find((arg) => arg.startsWith(prefix))
  return match ? match.slice(prefix.length) : undefined
}

const apiPort = Number(argvValue('--electron-api-port') || process.env?.ELECTRON_API_PORT) || 3001
const snapshotDir = argvValue('--cloudchat-snapshot-dir') || process.env?.CLOUDCHAT_IMAGE_SNAPSHOT_DIR || ''
const homeDir = argvValue('--electron-home-dir') || ''

contextBridge.exposeInMainWorld('electronAPI', {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  },
  platform: process.platform,
  homeDir,
  snapshotDir,
  apiPort,
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  openrouterOAuth: (): Promise<string> => ipcRenderer.invoke('openrouter:oauth'),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:open-external', url),
  saveFile: (defaultFilename: string, content: string): Promise<{ saved: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('file:save-dialog', { defaultFilename, content }),
  snapshotLocalImage: (path: string): Promise<{ url: string; hash: string; path: string }> =>
    ipcRenderer.invoke('cloudchat:snapshotLocalImage', path),
  notifyAttentionRequest: (payload?: { title?: string; body?: string }) => ipcRenderer.invoke('app:notify-attention', payload),
  clearAttentionRequest: () => ipcRenderer.invoke('app:clear-attention'),
  terminal: {
    spawn: (options?: { cwd?: string; command?: string } | string) =>
      ipcRenderer.invoke('terminal:spawn', typeof options === 'string' ? { cwd: options } : options),
    write: (id: string, data: string) => ipcRenderer.send('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.send('terminal:kill', id),
    onData: (callback: (id: string, data: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, id: string, data: string) => callback(id, data)
      ipcRenderer.on('terminal:data', handler)
      return () => { ipcRenderer.removeListener('terminal:data', handler) }
    },
    onExit: (callback: (id: string, exitCode: number) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, id: string, exitCode: number) => callback(id, exitCode)
      ipcRenderer.on('terminal:exit', handler)
      return () => { ipcRenderer.removeListener('terminal:exit', handler) }
    }
  },
  browser: {
    create: (url?: string) => ipcRenderer.invoke('browser:create', url),
    navigate: (url: string) => ipcRenderer.invoke('browser:navigate', url),
    goBack: () => ipcRenderer.invoke('browser:go-back'),
    goForward: () => ipcRenderer.invoke('browser:go-forward'),
    reload: () => ipcRenderer.invoke('browser:reload'),
    close: () => ipcRenderer.invoke('browser:close'),
    resize: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke('browser:resize', bounds),
    show: () => ipcRenderer.invoke('browser:show'),
    hide: () => ipcRenderer.invoke('browser:hide'),
    getUrl: (): Promise<string | null> => ipcRenderer.invoke('browser:get-url'),
    onForceResize: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('browser:force-resize', handler);
      return () => { ipcRenderer.removeListener('browser:force-resize', handler); };
    },
    onNavigated: (callback: (url: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, url: string) => callback(url);
      ipcRenderer.on('browser:navigated', handler);
      return () => { ipcRenderer.removeListener('browser:navigated', handler); };
    },
    onLoading: (callback: (loading: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, loading: boolean) => callback(loading);
      ipcRenderer.on('browser:loading', handler);
      return () => { ipcRenderer.removeListener('browser:loading', handler); };
    },
    onFailLoad: (callback: (payload: { url: string; errorCode: number; errorDescription: string }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { url: string; errorCode: number; errorDescription: string },
      ) => callback(payload);
      ipcRenderer.on('browser:fail-load', handler);
      return () => { ipcRenderer.removeListener('browser:fail-load', handler); };
    },
    onNavState: (callback: (state: { canGoBack: boolean; canGoForward: boolean }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        state: { canGoBack: boolean; canGoForward: boolean },
      ) => callback(state);
      ipcRenderer.on('browser:nav-state', handler);
      return () => { ipcRenderer.removeListener('browser:nav-state', handler); };
    },
  },
  onNewChat: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('new-chat', handler)
    return () => { ipcRenderer.removeListener('new-chat', handler) }
  },
  mcpWorker: {
    status: () => ipcRenderer.invoke('mcp-worker:status'),
    spawn: (req: { serverId: string; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }) =>
      ipcRenderer.invoke('mcp-worker:spawn', req),
  },
  bridge: {
    status: () => ipcRenderer.invoke('bridge:status'),
    start: () => ipcRenderer.invoke('bridge:start'),
    installDeps: () => ipcRenderer.invoke('bridge:install-deps'),
    installHermesAgent: () => ipcRenderer.invoke('bridge:install-hermes-agent'),
    onInstallProgress: (callback: (line: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, line: string) => callback(line)
      ipcRenderer.on('bridge:install-progress', handler)
      return () => { ipcRenderer.removeListener('bridge:install-progress', handler) }
    },
  },
  quick: {
    submit: (text: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('quick:submit', text),
  },
  quickOnCapture: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) => callback(text)
    ipcRenderer.on('quick:capture', handler)
    return () => { ipcRenderer.removeListener('quick:capture', handler) }
  },
  deepLinkOnNavigate: (callback: (target: { kind: string; id?: string; name?: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, target: { kind: string; id?: string; name?: string }) => callback(target)
    ipcRenderer.on('deep-link:navigate', handler)
    return () => { ipcRenderer.removeListener('deep-link:navigate', handler) }
  },
})

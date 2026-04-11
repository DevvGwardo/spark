import { contextBridge, ipcRenderer } from 'electron'

// Main process sets ELECTRON_API_PORT env var before creating BrowserWindow
const apiPort = Number(process.env.ELECTRON_API_PORT) || 3001

contextBridge.exposeInMainWorld('electronAPI', {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  },
  platform: process.platform,
  apiPort,
  notifyAttentionRequest: (payload?: { title?: string; body?: string }) => ipcRenderer.invoke('app:notify-attention', payload),
  clearAttentionRequest: () => ipcRenderer.invoke('app:clear-attention'),
  terminal: {
    spawn: (cwd?: string) => ipcRenderer.invoke('terminal:spawn', cwd),
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
    close: () => ipcRenderer.invoke('browser:close'),
    resize: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke('browser:resize', bounds),
    show: () => ipcRenderer.invoke('browser:show'),
    hide: () => ipcRenderer.invoke('browser:hide'),
  },
  onNewChat: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('new-chat', handler)
    return () => { ipcRenderer.removeListener('new-chat', handler) }
  },
})

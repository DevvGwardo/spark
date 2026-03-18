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
  }
})

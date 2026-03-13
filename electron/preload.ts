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
  clearAttentionRequest: () => ipcRenderer.invoke('app:clear-attention')
})

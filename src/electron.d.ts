export interface ElectronAPI {
  versions: {
    electron: string
    node: string
    chrome: string
  }
  platform: string
  apiPort: number
  notifyAttentionRequest?: (payload?: { title?: string; body?: string }) => Promise<void>
  clearAttentionRequest?: () => Promise<void>
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

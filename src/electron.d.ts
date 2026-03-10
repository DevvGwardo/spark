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

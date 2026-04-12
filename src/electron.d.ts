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
  terminal?: {
    spawn: (options?: { cwd?: string; command?: string } | string) => Promise<{ id: string }>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    kill: (id: string) => void
    onData: (callback: (id: string, data: string) => void) => () => void
    onExit: (callback: (id: string, exitCode: number) => void) => () => void
  }
  browser?: {
    create: (url?: string) => Promise<void>
    navigate: (url: string) => Promise<void>
    goBack: () => Promise<void>
    goForward: () => Promise<void>
    close: () => Promise<void>
    resize: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>
    show: () => Promise<void>
    hide: () => Promise<void>
    onForceResize: (callback: () => void) => () => void
  }
  onNewChat?: (callback: () => void) => () => void
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

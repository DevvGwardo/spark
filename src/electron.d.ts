export interface ElectronAPI {
  versions: {
    electron: string
    node: string
    chrome: string
  }
  platform: string
  apiPort: number
  getAppVersion?: () => Promise<string>
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
  bridge?: {
    status: () => Promise<{
      pythonPath: string | null
      bridgeSource: string | null
      bridgeDepsInstalled: boolean
      hermesAgentPresent: boolean
      authJsonPresent: boolean
      authJsonValid: boolean
      bridgeReachable: boolean
    }>
    start: () => Promise<{ status: 'started' | 'reused-existing' | 'failed'; message?: string }>
    installDeps: () => Promise<{ ok: boolean; message?: string }>
    installHermesAgent: () => Promise<{ ok: boolean; message?: string }>
    writeAuth: (input: { provider: string; apiKey: string; baseUrl?: string; active?: boolean }) => Promise<{ ok: boolean; message?: string }>
    onInstallProgress: (callback: (line: string) => void) => () => void
  }
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

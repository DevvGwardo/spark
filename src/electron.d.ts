export type McpWorkerState = 'starting' | 'ready' | 'stopped' | 'failed'

export interface McpWorkerStatus {
  serverId: string
  state: McpWorkerState
  pid?: number
  restarts: number
}

export interface McpWorkerSpawnRequest {
  serverId: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface DeepLinkNavigateTarget {
  kind: string
  id?: string
  name?: string
}

export interface ElectronAPI {
  versions: {
    electron: string
    node: string
    chrome: string
  }
  platform: string
  homeDir: string
  snapshotDir?: string
  apiPort: number
  getAppVersion?: () => Promise<string>
  openrouterOAuth?: () => Promise<string>
  openExternal?: (url: string) => Promise<boolean>
  saveFile?: (defaultFilename: string, content: string) => Promise<{ saved: boolean; path?: string; error?: string }>
  snapshotLocalImage?: (path: string) => Promise<{ url: string; hash: string; path: string }>
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
    create: (url?: string) => Promise<boolean>
    navigate: (url: string) => Promise<void>
    goBack: () => Promise<void>
    goForward: () => Promise<void>
    reload: () => Promise<void>
    close: () => Promise<void>
    resize: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>
    show: () => Promise<void>
    hide: () => Promise<void>
    getUrl: () => Promise<string | null>
    onForceResize: (callback: () => void) => () => void
    onNavigated: (callback: (url: string) => void) => () => void
    onLoading: (callback: (loading: boolean) => void) => () => void
    onFailLoad: (callback: (payload: { url: string; errorCode: number; errorDescription: string }) => void) => () => void
    onNavState: (callback: (state: { canGoBack: boolean; canGoForward: boolean }) => void) => () => void
  }
  onNewChat?: (callback: () => void) => () => void
  quick?: {
    submit: (text: string) => Promise<{ ok: boolean }>
  }
  quickOnCapture?: (callback: (text: string) => void) => () => void
  deepLinkOnNavigate?: (callback: (target: DeepLinkNavigateTarget) => void) => () => void
  mcpWorker?: {
    status: () => Promise<McpWorkerStatus[]>
    spawn: (req: McpWorkerSpawnRequest) => Promise<McpWorkerStatus>
  }
  bridge?: {
    status: () => Promise<{
      pythonPath: string | null
      gitPath: string | null
      bridgeSource: string | null
      bridgeDepsInstalled: boolean
      hermesAgentPresent: boolean
      bridgeReachable: boolean
      lastStartError: string | null
      bridgeRunning: boolean
      bridgePort: number
      processHealth: 'running' | 'stopped' | 'crashed' | 'starting'
    }>
    start: () => Promise<{ status: 'started' | 'reused-existing' | 'failed'; message?: string }>
    installDeps: () => Promise<{ ok: boolean; message?: string }>
    installHermesAgent: () => Promise<{ ok: boolean; message?: string }>
    onInstallProgress: (callback: (line: string) => void) => () => void
  }
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

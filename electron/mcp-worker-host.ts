// Clean-room reimplementation inspired by observed architecture; no vendor code copied.
import { spawn, type ChildProcess } from 'node:child_process'
import { MCP_WORKER_POLICY } from '../server/lib/mcp-worker-policy'

export type McpWorkerState = 'starting' | 'ready' | 'stopped' | 'failed'

export interface McpWorkerSpawnOptions {
  command: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  spawnTimeoutMs?: number
  cwd?: string
}

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface McpWorkerSnapshot {
  serverId: string
  state: McpWorkerState
  pid: number | null
  lastError: string | null
}

const DEFAULT_SPAWN_TIMEOUT_MS = 10_000
const HEADER_BYTES = 4

function encodeFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8')
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record['jsonrpc'] === '2.0' && ('id' in record) && (typeof record['id'] === 'number' || typeof record['id'] === 'string')
}

/**
 * Minimal utilityProcess-style host for one MCP server child process.
 * Frames JSON-RPC messages over stdio with a 4-byte big-endian length prefix.
 * No network calls; stdio only.
 */
export class McpWorkerHost {
  private readonly serverId: string
  private readonly options: McpWorkerSpawnOptions
  private child: ChildProcess | null = null
  private state: McpWorkerState = 'stopped'
  private lastError: string | null = null
  private nextId = 1
  private inbound = Buffer.alloc(0)
  private readonly pending = new Map<number | string, {
    resolve: (value: JsonRpcResponse) => void
    reject: (err: Error) => void
  }>()

  constructor(serverId: string, options: McpWorkerSpawnOptions) {
    this.serverId = serverId
    this.options = options
  }

  spawn(): Promise<void> {
    if (this.child !== null) {
      return Promise.resolve()
    }
    this.state = 'starting'
    this.lastError = null
    const timeoutMs = this.options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.fail(new Error(`MCP worker "${this.serverId}" spawn timed out after ${timeoutMs}ms`))
        reject(new Error(this.lastError ?? 'spawn timed out'))
      }, timeoutMs)

      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }

      try {
        const child = spawn(this.options.command, [...(this.options.args ?? [])], {
          cwd: this.options.cwd,
          env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        this.child = child
        this.inbound = Buffer.alloc(0)

        child.on('error', (err: Error) => {
          settle(() => {
            this.fail(err)
            reject(err)
          })
        })

        child.on('spawn', () => {
          settle(() => {
            this.state = 'ready'
            resolve()
          })
        })

        child.on('exit', (code: number | null, signal: string | null) => {
          if (this.state === 'starting') {
            settle(() => {
              this.fail(new Error(`MCP worker "${this.serverId}" exited during startup (code=${String(code)} signal=${String(signal)})`))
              reject(new Error(this.lastError ?? 'worker exited during startup'))
            })
            return
          }
          this.markExited(`exit code=${String(code)} signal=${String(signal)}`)
        })

        child.stdout?.on('data', (chunk: Buffer) => {
          this.onStdout(chunk)
        })
      } catch (err: unknown) {
        settle(() => {
          const wrapped = err instanceof Error ? err : new Error(String(err))
          this.fail(wrapped)
          reject(wrapped)
        })
      }
    })
  }

  stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.state = 'stopped'
    this.rejectAllPending(new Error(`MCP worker "${this.serverId}" stopped`))
    if (child === undefined || child === null) return Promise.resolve()
    child.stdout?.removeAllListeners('data')
    return new Promise<void>((resolve) => {
      const done = (): void => {
        if (!child.killed) {
          resolve()
          return
        }
        resolve()
      }
      child.once('exit', done)
      child.kill('SIGTERM')
      // Hard kill if the child ignores SIGTERM; dispose must not hang.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
        }
        resolve()
      }, 2000).unref()
    })
  }

  dispose(): void {
    void this.stop()
  }

  queryStatus(): McpWorkerSnapshot {
    return {
      serverId: this.serverId,
      state: this.state,
      pid: this.child?.pid ?? null,
      lastError: this.lastError,
    }
  }

  sendRequest(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const child = this.child
    if (this.state !== 'ready' || child?.stdin === null || child?.stdin === undefined) {
      return Promise.reject(new Error(`MCP worker "${this.serverId}" is not running`))
    }
    if (this.pending.size >= MCP_WORKER_POLICY.stdoutCap.maxPending) {
      return Promise.reject(new Error(`MCP worker "${this.serverId}" has too many pending requests`))
    }
    const id = this.nextId
    this.nextId += 1
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    const frame = encodeFrame(JSON.stringify(request))
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      child.stdin?.write(frame, (err: Error | null | undefined) => {
        if (err !== null && err !== undefined) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  private onStdout(chunk: Buffer): void {
    this.inbound = Buffer.concat([this.inbound, chunk])
    if (this.inbound.length > MCP_WORKER_POLICY.stdoutCap.maxFrameBufferBytes) {
      this.fail(new Error(`MCP worker "${this.serverId}" frame buffer cap exceeded`))
      return
    }
    while (this.inbound.length >= HEADER_BYTES) {
      const length = this.inbound.readUInt32BE(0)
      if (length > MCP_WORKER_POLICY.stdoutCap.maxFrameBufferBytes) {
        this.fail(new Error(`MCP worker "${this.serverId}" frame buffer cap exceeded`))
        return
      }
      if (this.inbound.length < HEADER_BYTES + length) return
      const body = this.inbound.subarray(HEADER_BYTES, HEADER_BYTES + length).toString('utf8')
      this.inbound = this.inbound.subarray(HEADER_BYTES + length)
      this.dispatchFrame(body)
    }
  }

  private dispatchFrame(body: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(body) as unknown
    } catch {
      return
    }
    if (!isJsonRpcResponse(parsed)) return
    const waiter = this.pending.get(parsed.id)
    if (waiter === undefined) return
    this.pending.delete(parsed.id)
    waiter.resolve(parsed)
  }

  private fail(err: Error): void {
    this.state = 'failed'
    this.lastError = err.message
    void this.stop()
    this.state = 'failed'
  }

  private markExited(reason: string): void {
    this.child = null
    if (this.state !== 'stopped') {
      this.state = 'failed'
      this.lastError = `MCP worker "${this.serverId}" exited: ${reason}`
    }
    this.rejectAllPending(new Error(this.lastError ?? 'worker exited'))
  }

  private rejectAllPending(err: Error): void {
    for (const waiter of this.pending.values()) {
      waiter.reject(err)
    }
    this.pending.clear()
  }
}

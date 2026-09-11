// Clean-room reimplementation inspired by observed architecture; no vendor code copied.
import { McpWorkerHost, type McpWorkerSnapshot, type McpWorkerSpawnOptions, type McpWorkerState } from './mcp-worker-host'

export const MAX_MCP_WORKERS = 8
export const MAX_MCP_RESTARTS = 3

export interface McpWorkerStatus {
  serverId: string
  state: McpWorkerState
  pid?: number
  restarts: number
}

export interface McpWorkerRegistration {
  serverId: string
  options: McpWorkerSpawnOptions
}

interface ManagedEntry {
  host: McpWorkerHost
  options: McpWorkerSpawnOptions
  restarts: number
}

/**
 * Main-process owner of isolated MCP server workers.
 * One worker host per serverId; bounded pool; bounded restarts.
 * Exposes status() as a plain snapshot list for IPC wiring (done by orchestrator).
 */
export class McpWorkerManager {
  private readonly workers = new Map<string, ManagedEntry>()

  size(): number {
    return this.workers.size
  }

  has(serverId: string): boolean {
    return this.workers.has(serverId)
  }

  async add(registration: McpWorkerRegistration): Promise<McpWorkerSnapshot> {
    const existing = this.workers.get(registration.serverId)
    if (existing !== undefined) {
      return existing.host.queryStatus()
    }
    if (this.workers.size >= MAX_MCP_WORKERS) {
      throw new Error(`MCP worker limit reached (${MAX_MCP_WORKERS}); refusing "${registration.serverId}"`)
    }
    const host = new McpWorkerHost(registration.serverId, registration.options)
    this.workers.set(registration.serverId, { host, options: registration.options, restarts: 0 })
    try {
      await host.spawn()
    } catch (err: unknown) {
      this.workers.delete(registration.serverId)
      throw err instanceof Error ? err : new Error(String(err))
    }
    return host.queryStatus()
  }

  async restart(serverId: string): Promise<McpWorkerSnapshot> {
    const entry = this.workers.get(serverId)
    if (entry === undefined) {
      throw new Error(`Unknown MCP worker "${serverId}"`)
    }
    if (entry.restarts >= MAX_MCP_RESTARTS) {
      throw new Error(`MCP worker "${serverId}" exceeded restart budget (${MAX_MCP_RESTARTS})`)
    }
    entry.restarts += 1
    await entry.host.stop()
    entry.host = new McpWorkerHost(serverId, entry.options)
    this.workers.set(serverId, entry)
    try {
      await entry.host.spawn()
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err))
    }
    return entry.host.queryStatus()
  }

  async remove(serverId: string): Promise<void> {
    const entry = this.workers.get(serverId)
    if (entry === undefined) return
    this.workers.delete(serverId)
    await entry.host.stop()
  }

  status(): McpWorkerStatus[] {
    return [...this.workers.entries()].map(([serverId, entry]) => {
      const snapshot = entry.host.queryStatus()
      return {
        serverId,
        state: snapshot.state,
        ...(snapshot.pid === null ? {} : { pid: snapshot.pid }),
        restarts: entry.restarts,
      }
    })
  }

  restartCount(serverId: string): number | null {
    return this.workers.get(serverId)?.restarts ?? null
  }

  async dispose(): Promise<void> {
    const entries = [...this.workers.values()]
    this.workers.clear()
    await Promise.all(entries.map((entry) => entry.host.stop()))
  }
}

// Clean-room supervisor; no vendor content copied.
// Singleton owner of the server-side MCP worker pool. All spawns pass the
// policy gate before reaching the manager. Resettable for tests.
import { McpWorkerManager, MAX_MCP_WORKERS } from '../../electron/mcp-worker-manager';
import type { McpWorkerSnapshot } from '../../electron/mcp-worker-host';
import { realpathSync } from 'node:fs';
import { validateSpawnCommand, validateWorkerCwd, filterWorkerEnv, isAllowedEnvKey, checkSpawnRateLimit, resetSpawnRateLimits } from './mcp-worker-policy';
import type { WorkerSpawnRequest } from './mcp-worker-protocol';

export interface SupervisorError extends Error {
  statusCode: number;
}

function supervisorError(message: string, statusCode: number): SupervisorError {
  const err = new Error(message) as SupervisorError;
  err.statusCode = statusCode;
  return err;
}

export function statusCodeOf(err: unknown): number {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const code = (err as { statusCode?: unknown }).statusCode;
    if (typeof code === 'number' && Number.isInteger(code)) return code;
  }
  return 500;
}

let manager = new McpWorkerManager();

export async function spawnWorker(req: WorkerSpawnRequest): Promise<McpWorkerSnapshot> {
  if (!checkSpawnRateLimit(req.serverId)) {
    throw supervisorError('Spawn rate limited', 429);
  }
  if (!validateSpawnCommand(req.command)) {
    throw supervisorError('Rejected spawn command', 400);
  }
  if (req.cwd !== undefined) {
    if (!validateWorkerCwd(req.cwd)) {
      throw supervisorError('Rejected worker cwd', 400);
    }
    // resolve() does not resolve symlinks — canonicalize first (fail closed).
    try {
      if (!validateWorkerCwd(realpathSync(req.cwd))) {
        throw supervisorError('Rejected worker cwd', 400);
      }
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err) throw err;
      throw supervisorError('Rejected worker cwd', 400);
    }
  }
  if (manager.size() >= MAX_MCP_WORKERS && !manager.has(req.serverId)) {
    throw supervisorError('Worker pool full', 409);
  }
  // envAllowlist names keys to inherit from process.env, intersected with the
  // policy allowlist (same gate as the IPC path's filterWorkerEnv). Unlisted
  // keys are dropped; the raw request array never reaches spawn.
  let env: Record<string, string> | undefined;
  if (req.envAllowlist !== undefined) {
    const picked: Record<string, string> = {};
    for (const key of req.envAllowlist) {
      if (!isAllowedEnvKey(key)) continue;
      const value = process.env[key];
      if (typeof value === 'string') picked[key] = value;
    }
    env = filterWorkerEnv(picked);
  }
  try {
    return await manager.add({
      serverId: req.serverId,
      options: { command: req.command, args: req.args, ...(req.cwd !== undefined ? { cwd: req.cwd } : {}), ...(env !== undefined ? { env } : {}) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/limit reached/i.test(message)) {
      throw supervisorError('Worker pool full', 409);
    }
    throw err;
  }
}

export function workerStatus() {
  return manager.status();
}

export async function stopWorker(serverId: string): Promise<void> {
  await manager.remove(serverId);
}

export async function resetSupervisor(): Promise<void> {
  await manager.dispose();
  resetSpawnRateLimits();
  manager = new McpWorkerManager();
}

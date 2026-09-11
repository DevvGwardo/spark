// Clean-room policy; no vendor code copied.
import { isAbsolute, resolve, relative } from "node:path";
import { homedir } from "node:os";

export const MCP_WORKER_POLICY = {
  maxWorkers: 8,
  maxRestarts: 3,
  spawnTimeoutMs: 10000,
  allowedProtocols: ["stdio"],
  envAllowlist: ["PATH", "HOME"],
  forbidNetwork: false,
  spawnRateLimit: {
    perServerPerMin: 5,
    globalPerMin: 20,
  },
  stdoutCap: {
    maxFrameBufferBytes: 8 * 1024 * 1024,
    maxPending: 256,
  },
} as const;

const SHELL_METACHAR_RE = /[|;&$`\n\r\0]/;

export function validateSpawnCommand(cmd: string): boolean {
  if (typeof cmd !== "string" || cmd.length === 0 || cmd.length > 4096) return false;
  if (SHELL_METACHAR_RE.test(cmd)) return false;
  const bin = cmd.trim().split(/\s+/)[0] ?? "";
  if (!bin || !isAbsolute(bin)) return false;
  if (bin.includes("..")) return false;
  return true;
}

export function isAllowedEnvKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  return (MCP_WORKER_POLICY.envAllowlist as readonly string[]).includes(key);
}

// Allowlist gate for renderer/supplied env. Unlisted keys (e.g. LD_PRELOAD,
// NODE_OPTIONS, PATH hijacks beyond the value itself) are dropped; non-string
// values are dropped. Callers must pass the RETURNED object to spawn — never
// the raw input. Pure (no fs) so the proof test can pin it behaviorally.
export function filterWorkerEnv(env: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  if (typeof env !== "object" || env === null || Array.isArray(env)) return safe;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (isAllowedEnvKey(key)) safe[key] = value;
  }
  return safe;
}

export function validateWorkerCwd(cwd: string, homeDir: string = homedir()): boolean {
  if (typeof cwd !== "string" || !cwd || typeof homeDir !== "string" || !homeDir) return false;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(homeDir);
  if (resolvedCwd === resolvedHome) return true;
  const rel = relative(resolvedHome, resolvedCwd);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// Spawn rate limiter: sliding 60s window, per-server + global buckets.
// Pure except module clock/buckets. Fail-closed on bad input → false.
const SPAWN_WINDOW_MS = 60_000;
const spawnTimestampsByServer = new Map<string, number[]>();
let globalSpawnTimestamps: number[] = [];

function pruneOlderThan(timestamps: number[], cutoff: number): number[] {
  return timestamps.filter((t) => t > cutoff);
}

export function checkSpawnRateLimit(serverId: string): boolean {
  if (typeof serverId !== "string" || serverId.length === 0 || serverId.length > 256) return false;
  const now = Date.now();
  const cutoff = now - SPAWN_WINDOW_MS;
  const perServerLimit = MCP_WORKER_POLICY.spawnRateLimit.perServerPerMin;
  const globalLimit = MCP_WORKER_POLICY.spawnRateLimit.globalPerMin;

  globalSpawnTimestamps = pruneOlderThan(globalSpawnTimestamps, cutoff);
  const perServer = pruneOlderThan(spawnTimestampsByServer.get(serverId) ?? [], cutoff);

  if (perServer.length >= perServerLimit) {
    spawnTimestampsByServer.set(serverId, perServer);
    return false;
  }
  if (globalSpawnTimestamps.length >= globalLimit) {
    spawnTimestampsByServer.set(serverId, perServer);
    return false;
  }
  perServer.push(now);
  spawnTimestampsByServer.set(serverId, perServer);
  globalSpawnTimestamps.push(now);
  return true;
}

// Test hook: clears all sliding-window buckets.
export function resetSpawnRateLimits(): void {
  spawnTimestampsByServer.clear();
  globalSpawnTimestamps = [];
}

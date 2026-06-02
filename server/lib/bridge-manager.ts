/**
 * Server-side Hermes bridge manager.
 *
 * Mirrors the Electron bridge launcher (electron/bridge.ts) for the headless
 * `serve` path: when CloudChat runs as a plain Node server (e.g. on a home
 * server reached over a tunnel from a phone), this auto-starts and supervises
 * the Python bridge so users don't have to launch it by hand.
 *
 * Activated only when MANAGE_BRIDGE=true. The bridge's runtime deps are
 * lightweight (fastapi, uvicorn, httpx, pydantic), so a project-local venv at
 * hermes-bridge/.venv is enough — no heavy hermes-agent clone required to run.
 */

import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { logger } from './logger';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 500;

let bridgeProcess: ChildProcess | null = null;
let startPromise: Promise<BridgeStartResult> | null = null;
let lastStartError: string | null = null;

export interface BridgeStartResult {
  status: 'started' | 'reused-existing' | 'failed';
  message?: string;
}

export interface ServerBridgeStatus {
  pythonPath: string | null;
  bridgeSource: string | null;
  bridgeDepsInstalled: boolean;
  bridgeReachable: boolean;
  bridgeRunning: boolean;
  lastStartError: string | null;
  bridgePort: number;
  processHealth: 'running' | 'stopped' | 'crashed' | 'starting';
}

// ── Port / URL resolution ───────────────────────────────────────────────────

/** The port the bridge listens on, derived from HERMES_BRIDGE_URL / HERMES_PORT. */
export function getBridgePort(): number {
  const raw = process.env.HERMES_BRIDGE_URL;
  if (raw) {
    try {
      const fromUrl = Number(new URL(raw).port);
      if (Number.isInteger(fromUrl) && fromUrl > 0) return fromUrl;
    } catch {
      // fall through to env / default
    }
  }
  const envPort = Number(process.env.HERMES_PORT);
  if (Number.isInteger(envPort) && envPort > 0) return envPort;
  return 3002;
}

function healthUrl(): string {
  return `http://127.0.0.1:${getBridgePort()}/health`;
}

// ── Path resolution ─────────────────────────────────────────────────────────

function venvPython(): string {
  return process.platform === 'win32'
    ? join(PROJECT_ROOT, 'hermes-bridge', '.venv', 'Scripts', 'python.exe')
    : join(PROJECT_ROOT, 'hermes-bridge', '.venv', 'bin', 'python');
}

function findHermesAgentPython(): string | null {
  const p = process.platform === 'win32'
    ? join(homedir(), '.hermes', 'hermes-agent', 'venv', 'Scripts', 'python.exe')
    : join(homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'python3');
  return existsSync(p) ? p : null;
}

function findSystemPython(): string | null {
  const candidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore' });
      return cmd;
    } catch {
      // try next
    }
  }
  return null;
}

/** Prefer the bridge's own venv, then a hermes-agent venv, then system Python. */
export function resolvePython(): string | null {
  const venv = venvPython();
  if (existsSync(venv)) return venv;
  return findHermesAgentPython() ?? findSystemPython();
}

export function resolveBridgeSource(): string | null {
  const dir = join(PROJECT_ROOT, 'hermes-bridge');
  return existsSync(join(dir, 'main.py')) ? dir : null;
}

// ── Health ──────────────────────────────────────────────────────────────────

async function isBridgeReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(healthUrl(), { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealthy(timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isBridgeReachable()) return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

function depsInstalled(python: string | null): boolean {
  if (!python) return false;
  try {
    execFileSync(python, ['-c', 'import fastapi, uvicorn, httpx, pydantic'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ── Status ──────────────────────────────────────────────────────────────────

export async function getBridgeStatus(): Promise<ServerBridgeStatus> {
  const python = resolvePython();
  const bridgeSource = resolveBridgeSource();
  const bridgeReachable = await isBridgeReachable();
  const processAlive = bridgeProcess !== null;

  let processHealth: ServerBridgeStatus['processHealth'] = 'stopped';
  if (processAlive && bridgeReachable) processHealth = 'running';
  else if (processAlive && !bridgeReachable) processHealth = 'starting';
  else if (lastStartError && !bridgeReachable) processHealth = 'crashed';

  return {
    pythonPath: python,
    bridgeSource,
    bridgeDepsInstalled: depsInstalled(python),
    bridgeReachable,
    bridgeRunning: processAlive,
    lastStartError,
    bridgePort: getBridgePort(),
    processHealth,
  };
}

// ── Start / stop ──────────────────────────────────────────────────────────────

export async function startManagedBridge(): Promise<BridgeStartResult> {
  if (startPromise) return startPromise;

  startPromise = (async (): Promise<BridgeStartResult> => {
    const fail = (message: string): BridgeStartResult => {
      lastStartError = message;
      logger.warn(`[bridge-manager] ${message}`);
      return { status: 'failed', message };
    };

    // Already up (started elsewhere — e.g. the user ran the script)? Reuse it.
    if (await isBridgeReachable()) {
      lastStartError = null;
      return { status: 'reused-existing' };
    }

    const python = resolvePython();
    if (!python) {
      return fail('No Python interpreter found. Run scripts/start-bridge.sh or install Python 3.');
    }
    const source = resolveBridgeSource();
    if (!source) {
      return fail('Bridge source directory (hermes-bridge/) not found.');
    }
    if (!depsInstalled(python)) {
      return fail('Bridge dependencies not installed. Run scripts/start-bridge.sh or POST /api/bridge/install-deps.');
    }

    logger.info(`[bridge-manager] starting bridge: ${python} main.py (port ${getBridgePort()})`);
    bridgeProcess = spawn(python, ['main.py'], {
      cwd: source,
      env: { ...process.env, HERMES_PORT: String(getBridgePort()) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    bridgeProcess.stdout?.on('data', (c: Buffer) => process.stdout.write('[bridge] ' + c.toString()));
    bridgeProcess.stderr?.on('data', (c: Buffer) => process.stderr.write('[bridge:err] ' + c.toString()));
    bridgeProcess.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        lastStartError = `Hermes bridge exited unexpectedly (code=${code}, signal=${signal ?? 'none'})`;
      }
      bridgeProcess = null;
      startPromise = null;
    });

    if (!(await waitForHealthy())) {
      return fail(`Bridge did not become healthy within ${HEALTH_TIMEOUT_MS}ms.`);
    }
    lastStartError = null;
    logger.info('[bridge-manager] bridge healthy');
    return { status: 'started' };
  })();

  const result = await startPromise;
  if (result.status === 'failed') startPromise = null; // allow retry
  return result;
}

export function stopManagedBridge(): void {
  if (!bridgeProcess) return;
  lastStartError = null;
  try {
    bridgeProcess.kill(process.platform === 'win32' ? undefined : 'SIGINT');
  } catch (err) {
    logger.warn(`[bridge-manager] error stopping bridge: ${(err as Error).message}`);
  }
  bridgeProcess = null;
  startPromise = null;
}

// ── First-run dependency install ────────────────────────────────────────────

/**
 * Create the bridge venv (if missing) and install its requirements into it.
 * Streams pip output via onProgress. Idempotent.
 */
export async function installBridgeDeps(onProgress?: (line: string) => void): Promise<{ ok: boolean; message?: string }> {
  const source = resolveBridgeSource();
  if (!source) return { ok: false, message: 'Bridge source not found' };
  const reqs = join(source, 'requirements.txt');
  if (!existsSync(reqs)) return { ok: false, message: 'requirements.txt missing in bridge source' };

  const log = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    onProgress?.(trimmed);
    logger.info('[bridge-manager:install] ' + trimmed);
  };

  // Ensure the venv exists, creating it with system Python if needed.
  const venv = venvPython();
  if (!existsSync(venv)) {
    const sys = findSystemPython();
    if (!sys) return { ok: false, message: 'No Python found to create the bridge virtualenv.' };
    log('Creating virtualenv (.venv)…');
    const created = await runStreaming(sys, ['-m', 'venv', join(source, '.venv')], undefined, log);
    if (!created.ok) return created;
  }

  log('Installing bridge dependencies…');
  return runStreaming(venv, ['-m', 'pip', 'install', '--upgrade', '-r', reqs], source, log);
}

function runStreaming(
  cmd: string,
  args: string[],
  cwd: string | undefined,
  log: (line: string) => void,
): Promise<{ ok: boolean; message?: string }> {
  return new Promise((res) => {
    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stdout?.on('data', (c: Buffer) => c.toString().split(/\r?\n/).forEach(log));
    proc.stderr?.on('data', (c: Buffer) => {
      const chunk = c.toString();
      err += chunk;
      chunk.split(/\r?\n/).forEach(log);
    });
    proc.on('close', (code) => {
      if (code === 0) res({ ok: true });
      else res({ ok: false, message: err.trim().slice(-2000) || `process exited ${code}` });
    });
    proc.on('error', (e) => res({ ok: false, message: e.message }));
  });
}

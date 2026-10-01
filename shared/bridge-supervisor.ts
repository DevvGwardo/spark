/**
 * Hermes bridge supervisor (spec Phase 3.1–3.4).
 *
 * The one implementation of the Python bridge lifecycle, shared by the Electron
 * launcher (electron/bridge.ts) and the headless manager
 * (server/lib/bridge-manager.ts). The two differ only in what they inject:
 *
 *   - a PythonResolver (bundled runtime vs project venv first),
 *   - a BridgeInstallStrategy (pip --target vs a project venv),
 *   - an unowned-bridge policy (Electron replaces it, headless refuses it).
 *
 * Everything else lives here: the launch token, the ownership check against the
 * bridge's `/diag`, spawn, the health wait, an awaited stop (SIGINT → 5s →
 * SIGKILL), respawn with backoff, the readiness state machine, and logging to
 * the rotating `~/.hermes/logs/spark-bridge.log`.
 *
 * Ownership: `/diag` returns the bridge's launch token to loopback callers. A
 * running bridge is adopted only when that token equals ours; anything else on
 * the port is "unowned" and handled by the injected policy, never silently
 * adopted.
 */
import { spawn as nodeSpawn, execFile, execFileSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { BridgeReadiness, BridgeReadinessState } from './bridge-readiness';
import { createRotatingLog, type RotatingLog } from './rotating-log';

export type { BridgeReadiness, BridgeReadinessState } from './bridge-readiness';

// ── Public types ────────────────────────────────────────────────────────────

/** Returns the interpreter used to run the bridge, or null if none exists. */
export type PythonResolver = () => string | null;

export interface InstallResult {
  ok: boolean;
  message?: string;
}

export interface BridgeInstallStrategy {
  /** Env added to the bridge process and to the deps probe (e.g. PYTHONPATH). */
  env(source: string | null): Record<string, string>;
  /** Install the bridge's Python requirements. */
  install(ctx: { python: string | null; source: string; log: (line: string) => void }): Promise<InstallResult>;
}

export interface SupervisorLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface BridgeStartResult {
  status: 'started' | 'reused-existing' | 'failed';
  message?: string;
}

export interface BridgeSupervisorStatus {
  pythonPath: string | null;
  bridgeSource: string | null;
  bridgeDepsInstalled: boolean;
  bridgeReachable: boolean;
  bridgeRunning: boolean;
  lastStartError: string | null;
  bridgePort: number;
  processHealth: 'running' | 'stopped' | 'crashed' | 'starting';
  readiness: BridgeReadiness;
}

export interface SupervisorTiming {
  healthTimeoutMs: number;
  healthPollMs: number;
  probeIntervalMs: number;
  probeTimeoutMs: number;
  /** A health probe slower than this marks the bridge degraded. */
  slowProbeMs: number;
  stopGraceMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxAttempts: number;
  attemptWindowMs: number;
  /** Consecutive failed probes before an adopted (non-child) bridge counts as exited. */
  adoptedFailureLimit: number;
}

export const DEFAULT_TIMING: SupervisorTiming = {
  healthTimeoutMs: 30_000,
  healthPollMs: 500,
  probeIntervalMs: 5_000,
  probeTimeoutMs: 5_000,
  slowProbeMs: 2_000,
  stopGraceMs: 5_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  maxAttempts: 5,
  attemptWindowMs: 5 * 60_000,
  adoptedFailureLimit: 3,
};

export const STDERR_TAIL_LINES = 50;

export interface BridgeSupervisorOptions {
  port: number;
  host?: string;
  /** Launch token. Defaults to a fresh random token. */
  token?: string;
  resolvePython: PythonResolver;
  resolveSource: () => string | null;
  install: BridgeInstallStrategy;
  /** A bridge on our port that we do not own: kill it, or refuse to start. */
  onUnowned: 'replace' | 'refuse';
  /** Extra env for the bridge process. */
  extraEnv?: Record<string, string>;
  logger?: SupervisorLogger;
  /** Rotating log file. Defaults to ~/.hermes/logs/spark-bridge.log; null disables. */
  logFile?: string | null;
  /** Mirror bridge stdout/stderr to the console. Default true. */
  echo?: boolean;
  timing?: Partial<SupervisorTiming>;
  // Test seams.
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  fetch?: typeof fetch;
  checkDeps?: (python: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
  listeningPids?: (port: number) => number[];
  killPid?: (pid: number) => void;
}

// ── Shared discovery helpers ────────────────────────────────────────────────

/** First command in `candidates` that runs `--version` successfully. */
export function findExecutable(candidates: string[]): string | null {
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

export function findSystemPython(): string | null {
  return findExecutable(process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']);
}

/** The interpreter inside a virtualenv directory (not checked for existence). */
export function venvPython(venvDir: string, unixName = 'python'): string {
  return process.platform === 'win32' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', unixName);
}

export function hermesHome(): string {
  return join(homedir(), '.hermes');
}

/** ~/.hermes/hermes-agent's venv interpreter, if it exists. */
export function hermesAgentPython(): string | null {
  const p = venvPython(join(hermesHome(), 'hermes-agent', 'venv'), 'python3');
  return existsSync(p) ? p : null;
}

export function defaultBridgeLogPath(): string {
  return join(hermesHome(), 'logs', 'spark-bridge.log');
}

/** Run a command, streaming each output line to `log`. */
export function runStreaming(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  log: (line: string) => void,
): Promise<InstallResult> {
  return new Promise((resolve) => {
    const proc = nodeSpawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stdout?.on('data', (c: Buffer) => c.toString().split(/\r?\n/).forEach(log));
    proc.stderr?.on('data', (c: Buffer) => {
      const chunk = c.toString();
      err += chunk;
      chunk.split(/\r?\n/).forEach(log);
    });
    proc.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, message: err.trim().slice(-2000) || `${cmd} exited ${code}` });
    });
    proc.on('error', (e) => resolve({ ok: false, message: e.message }));
  });
}

/** PIDs listening on a TCP port (excluding this process). */
export function listeningPids(port: number): number[] {
  try {
    let pids: number[];
    if (process.platform === 'win32') {
      const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
      pids = output.split(/\r?\n/).flatMap((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts[0] !== 'TCP' || parts.length < 5) return [];
        return parts[1]?.endsWith(`:${port}`) && parts[3] === 'LISTENING' ? [Number(parts[4])] : [];
      });
    } else {
      // -sTCP:LISTEN: without it lsof also lists *clients* of the port, which
      // can include this very process.
      const output = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
      pids = output.split(/\r?\n/).map((l) => Number(l.trim()));
    }
    return [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
  } catch {
    return [];
  }
}

function defaultKillPid(pid: number): void {
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(pid, 'SIGTERM');
}

function defaultCheckDeps(python: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(python, ['-c', 'import fastapi, uvicorn, httpx, pydantic'], { env, timeout: 20_000 }, (err) => resolve(!err));
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Splits a byte stream into lines, carrying partial lines between chunks. */
function lineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let carry = '';
  return (chunk) => {
    const parts = (carry + chunk.toString()).split(/\r?\n/);
    carry = parts.pop() ?? '';
    if (carry.length > 8192) {
      parts.push(carry);
      carry = '';
    }
    for (const p of parts) if (p) onLine(p);
  };
}

// ── Active supervisor registry ──────────────────────────────────────────────

// Keyed on globalThis so the Express route sees Electron's supervisor even if
// a bundler ever duplicates this module.
const ACTIVE_KEY = Symbol.for('spark.activeBridgeSupervisor');
type RegistryHost = typeof globalThis & { [ACTIVE_KEY]?: BridgeSupervisor | null };

/** The supervisor currently managing the bridge in this process, if any. */
export function getActiveBridgeSupervisor(): BridgeSupervisor | null {
  return (globalThis as RegistryHost)[ACTIVE_KEY] ?? null;
}

export function setActiveBridgeSupervisor(supervisor: BridgeSupervisor | null): void {
  (globalThis as RegistryHost)[ACTIVE_KEY] = supervisor;
}

// ── Supervisor ──────────────────────────────────────────────────────────────

type ProbeResult = { ok: boolean; ms: number; error?: string; body?: unknown };

export class BridgeSupervisor {
  readonly token: string;
  readonly port: number;
  private readonly opts: BridgeSupervisorOptions;
  private readonly timing: SupervisorTiming;
  private readonly log: SupervisorLogger;
  private readonly file: RotatingLog | null;
  private readonly fetchImpl: typeof fetch;

  private child: ChildProcess | null = null;
  private adopted = false;
  private stopping = false;
  private generation = 0;
  private startPromise: Promise<BridgeStartResult> | null = null;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private monitorTimer: ReturnType<typeof setTimeout> | null = null;
  private monitorGen = 0;
  private probeFailures = 0;
  private pendingExitReason: string | null = null;
  private attemptTimes: number[] = [];
  private stderrRing: string[] = [];
  private depsCache: { python: string; result: boolean } | null = null;
  private readonly listeners = new Set<(r: BridgeReadiness) => void>();
  private state: BridgeReadiness = { state: 'stopped', since: Date.now(), attempt: 0, lastError: null, stderrTail: [] };

  constructor(opts: BridgeSupervisorOptions) {
    this.opts = opts;
    this.port = opts.port;
    this.token = opts.token?.trim() || randomBytes(32).toString('hex');
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
    const file = opts.logFile === undefined ? defaultBridgeLogPath() : opts.logFile;
    this.file = file ? createRotatingLog({ path: file }) : null;
    const base = opts.logger ?? { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) };
    const stamp = (level: string, m: string) => this.file?.write(`${new Date().toISOString()} ${level} [supervisor] ${m}`);
    this.log = {
      info: (m) => { base.info(`[bridge] ${m}`); stamp('INFO', m); },
      warn: (m) => { base.warn(`[bridge] ${m}`); stamp('WARN', m); },
    };
  }

  // ── Readiness ─────────────────────────────────────────────────────────────

  readiness(): BridgeReadiness {
    return { ...this.state, stderrTail: [...this.state.stderrTail] };
  }

  onReadiness(listener: (r: BridgeReadiness) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves true once ready, false on crashed/stopped, timeout or abort. */
  waitForReady(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const now = this.state.state;
    if (now === 'ready') return Promise.resolve(true);
    if (now === 'crashed' || now === 'stopped' || signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (v: boolean) => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      const off = this.onReadiness((r) => {
        if (r.state === 'ready') finish(true);
        else if (r.state === 'crashed' || r.state === 'stopped') finish(false);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  get lastError(): string | null {
    return this.state.lastError;
  }

  isRunning(): boolean {
    return this.child !== null || this.adopted;
  }

  private transition(state: BridgeReadinessState, patch: { attempt?: number; lastError?: string | null } = {}): void {
    const prev = this.state;
    const attempt = patch.attempt ?? (state === 'ready' ? 0 : prev.attempt);
    const lastError = patch.lastError !== undefined ? patch.lastError : prev.lastError;
    if (prev.state === state && prev.attempt === attempt && prev.lastError === lastError) return;
    this.state = {
      state,
      since: prev.state === state ? prev.since : Date.now(),
      attempt,
      lastError,
      stderrTail: state === 'crashed' ? this.stderrRing.slice(-STDERR_TAIL_LINES) : [],
    };
    if (prev.state !== state) this.log.info(`state ${prev.state} → ${state}${lastError ? ` (${lastError})` : ''}`);
    for (const l of this.listeners) {
      try {
        l(this.readiness());
      } catch {
        // a listener must never break the supervisor
      }
    }
  }

  // ── Probes ────────────────────────────────────────────────────────────────

  private async probe(path: string, timeoutMs: number): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const res = await this.fetchImpl(`http://127.0.0.1:${this.port}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'X-Hermes-Bridge-Token': this.token },
      });
      const body = path === '/diag' && res.ok ? await res.json().catch(() => null) : undefined;
      return { ok: res.ok, ms: Date.now() - started, body, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, ms: Date.now() - started, error: (err as Error)?.message ?? String(err) };
    }
  }

  async isReachable(): Promise<boolean> {
    return (await this.probe('/health', 1_500)).ok;
  }

  /** True only when the bridge on our port reports our launch token via /diag. */
  async isOwned(): Promise<boolean> {
    const r = await this.probe('/diag', 1_500);
    const token = (r.body as { token?: unknown } | null | undefined)?.token;
    return r.ok && typeof token === 'string' && token.length > 0 && token === this.token;
  }

  // ── Deps / status / install ──────────────────────────────────────────────

  private probeEnv(source: string | null): NodeJS.ProcessEnv {
    return { ...process.env, ...this.opts.install.env(source) };
  }

  async depsInstalled(python: string | null, source = this.opts.resolveSource()): Promise<boolean> {
    if (!python) return false;
    if (this.depsCache?.python === python) return this.depsCache.result;
    const result = await (this.opts.checkDeps ?? defaultCheckDeps)(python, this.probeEnv(source));
    this.depsCache = { python, result };
    return result;
  }

  async status(): Promise<BridgeSupervisorStatus> {
    const python = this.opts.resolvePython();
    const source = this.opts.resolveSource();
    const [bridgeDepsInstalled, bridgeReachable] = await Promise.all([
      this.depsInstalled(python, source),
      this.isReachable(),
    ]);
    const { state, lastError } = this.state;
    const processHealth: BridgeSupervisorStatus['processHealth'] =
      state === 'ready' || state === 'degraded' ? 'running'
        : state === 'starting' || state === 'restarting' ? 'starting'
          : state === 'crashed' || lastError ? 'crashed' : 'stopped';
    return {
      pythonPath: python,
      bridgeSource: source,
      bridgeDepsInstalled,
      bridgeReachable,
      bridgeRunning: this.isRunning(),
      // Probe noise (degraded) and in-flight restarts are not start errors; the
      // setup UI opens on a non-null value, so only terminal states report one.
      lastStartError: state === 'stopped' || state === 'crashed' ? lastError : null,
      bridgePort: this.port,
      processHealth,
      readiness: this.readiness(),
    };
  }

  async installDeps(onProgress?: (line: string) => void): Promise<InstallResult> {
    this.depsCache = null;
    const source = this.opts.resolveSource();
    if (!source) return { ok: false, message: 'Bridge source not found' };
    if (!existsSync(join(source, 'requirements.txt'))) {
      return { ok: false, message: 'requirements.txt missing in bridge source' };
    }
    const log = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      onProgress?.(trimmed);
      this.log.info(`[install] ${trimmed}`);
    };
    const result = await this.opts.install.install({ python: this.opts.resolvePython(), source, log });
    this.depsCache = null;
    return result;
  }

  // ── Start ─────────────────────────────────────────────────────────────────

  start(): Promise<BridgeStartResult> {
    if (this.startPromise) return this.startPromise;
    setActiveBridgeSupervisor(this);
    this.stopping = false;
    const { state } = this.state;
    if ((state === 'ready' || state === 'degraded') && this.isRunning()) {
      return Promise.resolve({ status: this.adopted ? 'reused-existing' : 'started' });
    }
    // A manual start pre-empts a pending backoff; after a crash it opens a fresh window.
    this.clearRespawnTimer();
    if (state !== 'restarting') {
      this.attemptTimes = [];
      this.stderrRing = [];
    }
    this.depsCache = null;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private failStart(message: string): BridgeStartResult {
    this.log.warn(message);
    this.transition('stopped', { attempt: 0, lastError: message });
    return { status: 'failed', message };
  }

  private async doStart(): Promise<BridgeStartResult> {
    const gen = this.generation;
    if (this.state.state !== 'restarting') this.transition('starting', { attempt: 0 });
    const pidsOf = this.opts.listeningPids ?? listeningPids;

    if (await this.isReachable()) {
      if (await this.isOwned()) {
        if (gen !== this.generation) return { status: 'failed', message: 'Bridge start was cancelled' };
        this.log.info(`adopting owned bridge already running on :${this.port}`);
        this.adopted = true;
        this.transition('ready', { lastError: null });
        this.startMonitor();
        return { status: 'reused-existing' };
      }
      if (this.opts.onUnowned === 'refuse') {
        return this.failStart(
          `A Hermes bridge not started by this server is already listening on :${this.port}. ` +
            'Stop it, or set HERMES_BRIDGE_TOKEN to its token so it can be adopted.',
        );
      }
      this.log.warn(`replacing unowned bridge on :${this.port}`);
      if (!(await this.evictPort())) return this.failStart(`Bridge on :${this.port} is not owned by this launch and could not be stopped`);
    } else if (pidsOf(this.port).length > 0) {
      if (this.opts.onUnowned === 'refuse') {
        return this.failStart(`Port :${this.port} is held by an unresponsive process. Stop it and retry.`);
      }
      this.log.warn(`replacing unresponsive process on :${this.port}`);
      if (!(await this.evictPort())) return this.failStart(`Process on :${this.port} could not be stopped`);
    }

    const python = this.opts.resolvePython();
    if (!python) return this.failStart('No Python interpreter found. Install Python 3 or run scripts/start-bridge.sh.');
    const source = this.opts.resolveSource();
    if (!source) return this.failStart('Bridge source directory (hermes-bridge/) not found.');
    if (!(await this.depsInstalled(python, source))) {
      return this.failStart('Bridge dependencies not installed. Run the setup (install deps) and retry.');
    }
    if (gen !== this.generation) return { status: 'failed', message: 'Bridge start was cancelled' };
    return this.spawnAndWait(python, source);
  }

  private async evictPort(): Promise<boolean> {
    const pidsOf = this.opts.listeningPids ?? listeningPids;
    const kill = this.opts.killPid ?? defaultKillPid;
    const pids = pidsOf(this.port);
    if (pids.length === 0) return !(await this.isReachable());
    for (const pid of pids) {
      try {
        kill(pid);
      } catch (err) {
        this.log.warn(`failed to stop pid ${pid} on :${this.port}: ${(err as Error).message}`);
      }
    }
    const deadline = Date.now() + this.timing.stopGraceMs;
    while (Date.now() < deadline) {
      if (pidsOf(this.port).length === 0) return true;
      await sleep(100);
    }
    return false;
  }

  private async spawnAndWait(python: string, source: string): Promise<BridgeStartResult> {
    const gen = ++this.generation;
    this.adopted = false;
    // Shared with the in-process Node server so bridge-client authenticates.
    process.env.HERMES_BRIDGE_TOKEN = this.token;
    this.log.info(`spawning ${python} main.py (cwd ${source}, port ${this.port})`);

    let child: ChildProcess;
    try {
      child = (this.opts.spawn ?? nodeSpawn)(python, ['main.py'], {
        cwd: source,
        env: {
          ...process.env,
          HERMES_PORT: String(this.port),
          HERMES_BRIDGE_HOST: this.opts.host || process.env.HERMES_BRIDGE_HOST || '127.0.0.1',
          HERMES_BRIDGE_TOKEN: this.token,
          ...this.opts.install.env(source),
          ...this.opts.extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const message = `Failed to spawn bridge: ${(err as Error).message}`;
      this.scheduleRespawn(message);
      return { status: 'failed', message };
    }
    this.child = child;
    this.attachOutput(child);
    child.once('exit', (code, signal) => this.onChildExit(gen, child, code, signal));
    child.once('error', (err) => this.onChildExit(gen, child, null, null, `Bridge process error: ${err.message}`));

    const healthy = await this.waitHealthyOwned(gen, child);
    if (gen !== this.generation || this.stopping) return { status: 'failed', message: 'Bridge start was cancelled' };
    if (healthy) {
      this.transition('ready', { lastError: null });
      this.startMonitor();
      return { status: 'started' };
    }
    if (this.child === child) {
      // Alive but never healthy: kill it; the exit handler drives the respawn.
      const message = `Bridge did not become healthy and owned within ${this.timing.healthTimeoutMs}ms`;
      this.pendingExitReason = message;
      void this.killChild(child);
      return { status: 'failed', message };
    }
    return { status: 'failed', message: this.state.lastError ?? 'Bridge exited during startup' };
  }

  private attachOutput(child: ChildProcess): void {
    const echo = this.opts.echo !== false;
    const out = lineSplitter((line) => this.file?.write(`${new Date().toISOString()} OUT ${line}`));
    const err = lineSplitter((line) => {
      this.stderrRing.push(line);
      if (this.stderrRing.length > STDERR_TAIL_LINES) this.stderrRing.splice(0, this.stderrRing.length - STDERR_TAIL_LINES);
      this.file?.write(`${new Date().toISOString()} ERR ${line}`);
    });
    child.stdout?.on('data', (c: Buffer) => {
      if (echo) process.stdout.write('[bridge] ' + c.toString());
      out(c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (echo) process.stderr.write('[bridge:err] ' + c.toString());
      err(c);
    });
  }

  private async waitHealthyOwned(gen: number, child: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + this.timing.healthTimeoutMs;
    while (Date.now() < deadline) {
      if (gen !== this.generation || this.stopping || this.child !== child) return false;
      if ((await this.isReachable()) && (await this.isOwned())) return true;
      await sleep(this.timing.healthPollMs);
    }
    return false;
  }

  // ── Exit / respawn ────────────────────────────────────────────────────────

  private onChildExit(gen: number, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null, error?: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.stopMonitor();
    if (this.stopping || gen !== this.generation) return;
    const reason = this.pendingExitReason ?? error ??
      `Hermes bridge exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'})`;
    this.pendingExitReason = null;
    this.log.warn(reason);
    this.scheduleRespawn(reason);
  }

  private scheduleRespawn(reason: string): void {
    const { maxAttempts, attemptWindowMs, backoffBaseMs, backoffMaxMs } = this.timing;
    const now = Date.now();
    this.attemptTimes = this.attemptTimes.filter((t) => now - t < attemptWindowMs);
    if (this.attemptTimes.length >= maxAttempts) {
      this.transition('crashed', {
        attempt: this.attemptTimes.length,
        lastError: `${reason}. Gave up after ${maxAttempts} restarts in ${Math.round(attemptWindowMs / 60_000)} min.`,
      });
      return;
    }
    this.attemptTimes.push(now);
    const attempt = this.attemptTimes.length;
    const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (attempt - 1));
    this.transition('restarting', { attempt, lastError: reason });
    this.log.info(`respawning in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
    this.clearRespawnTimer();
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      void this.respawn();
    }, delay);
    this.respawnTimer.unref?.();
  }

  private async respawn(): Promise<void> {
    if (this.stopping || this.startPromise) return;
    const python = this.opts.resolvePython();
    const source = this.opts.resolveSource();
    if (!python || !source) {
      this.scheduleRespawn('Python interpreter or bridge source is no longer available');
      return;
    }
    this.startPromise = this.spawnAndWait(python, source).finally(() => {
      this.startPromise = null;
    });
    await this.startPromise;
  }

  private clearRespawnTimer(): void {
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = null;
  }

  // ── Health monitor ────────────────────────────────────────────────────────

  private startMonitor(): void {
    this.stopMonitor();
    this.probeFailures = 0;
    const gen = ++this.monitorGen;
    const tick = async () => {
      const r = await this.probe('/health', this.timing.probeTimeoutMs);
      if (gen !== this.monitorGen || this.stopping) return;
      if (r.ok && r.ms <= this.timing.slowProbeMs) {
        this.probeFailures = 0;
        this.transition('ready', { lastError: null });
      } else {
        this.probeFailures = r.ok ? 0 : this.probeFailures + 1;
        this.transition('degraded', {
          lastError: r.ok ? `Health probe slow (>${this.timing.slowProbeMs}ms)` : `Health probe failed: ${r.error}`,
        });
        if (this.adopted && !this.child && this.probeFailures >= this.timing.adoptedFailureLimit) {
          this.adopted = false;
          this.stopMonitor();
          this.scheduleRespawn('Adopted bridge stopped responding');
          return;
        }
      }
      this.monitorTimer = setTimeout(() => void tick(), this.timing.probeIntervalMs);
      this.monitorTimer.unref?.();
    };
    this.monitorTimer = setTimeout(() => void tick(), this.timing.probeIntervalMs);
    this.monitorTimer.unref?.();
  }

  private stopMonitor(): void {
    this.monitorGen++;
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    this.monitorTimer = null;
  }

  // ── Stop ──────────────────────────────────────────────────────────────────

  /** Intentional stop: SIGINT, then SIGKILL after the grace period. Never respawns. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.generation++;
    this.clearRespawnTimer();
    this.stopMonitor();
    this.adopted = false;
    const child = this.child;
    if (child) await this.killChild(child);
    this.child = null;
    this.startPromise = null;
    this.transition('stopped', { attempt: 0, lastError: null });
  }

  private killChild(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (killTimer) clearTimeout(killTimer);
        resolve();
      };
      child.once('exit', done);
      try {
        // SIGINT doesn't work cleanly for python on Windows; plain kill there.
        if (process.platform === 'win32') child.kill();
        else child.kill('SIGINT');
      } catch (err) {
        this.log.warn(`error signalling bridge: ${(err as Error).message}`);
      }
      killTimer = setTimeout(() => {
        killTimer = null;
        this.log.warn(`bridge ignored SIGINT for ${this.timing.stopGraceMs}ms; sending SIGKILL`);
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        // SIGKILL cannot be ignored; stop waiting shortly regardless.
        setTimeout(resolve, 1_000).unref?.();
      }, this.timing.stopGraceMs);
    });
  }
}

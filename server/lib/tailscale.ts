// ─── Tailscale detection ────────────────────────────────────────────────────
// Spark exposes itself to the user's own tailnet instead of a public tunnel.
// Nothing in this module mutates system state: we only read `tailscale status`
// and `tailscale serve status`, then hand the user a copy-paste command.

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';

const EXEC_TIMEOUT_MS = 5_000;
const MAX_BUFFER = 4 * 1024 * 1024;

/** macOS keeps the CLI inside the app bundle; it is not always on PATH. */
const MACOS_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/**
 * HTTPS port Spark asks `tailscale serve` to listen on. Deliberately not 443:
 * 443 is `tailscale serve`'s default target and is commonly already mapped to
 * another local service, so claiming it would clobber that mapping.
 */
export const DEFAULT_TAILNET_HTTPS_PORT = 8443;

const execFileAsync = promisify(execFile) as (
  file: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  needsLogin: boolean;
  /** MagicDNS name without the trailing dot, e.g. `mac.tailnet.ts.net`. */
  hostname: string | null;
  /** `https://<hostname>` — reachable only from the tailnet. */
  url: string | null;
  authUrl: string | null;
  error: string | null;
}

export interface TailscaleServeInfo {
  /** True when serve already proxies this app's port somewhere on the tailnet. */
  configured: boolean;
  /** The URL the existing mapping serves, when configured. */
  url: string | null;
  error: string | null;
}

let cachedBin: string | null | undefined;

/** Resolve the Tailscale CLI once; null when Tailscale is not installed. */
export async function resolveTailscaleBin(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  try {
    await execFileAsync('tailscale', ['version'], { timeout: EXEC_TIMEOUT_MS });
    cachedBin = 'tailscale';
  } catch {
    cachedBin = existsSync(MACOS_APP_CLI) ? MACOS_APP_CLI : null;
  }
  return cachedBin;
}

async function runTailscale(args: string[]): Promise<{ ok: boolean; stdout: string; error: string | null }> {
  const bin = await resolveTailscaleBin();
  if (!bin) return { ok: false, stdout: '', error: 'Tailscale CLI not found' };
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    return { ok: true, stdout, error: null };
  } catch (err) {
    return { ok: false, stdout: '', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Strip the trailing dot that MagicDNS names carry. */
function normalizeDnsName(name: string): string {
  return name.replace(/\.$/, '');
}

/** Pure parse of `tailscale status --json`, so it can be unit-tested. */
export function parseTailscaleStatus(raw: unknown): Omit<TailscaleStatus, 'installed' | 'error'> {
  const data = (raw ?? {}) as {
    BackendState?: unknown;
    AuthURL?: unknown;
    Self?: { DNSName?: unknown };
  };
  const backendState = typeof data.BackendState === 'string' ? data.BackendState : '';
  const authUrl = typeof data.AuthURL === 'string' && data.AuthURL.length > 0 ? data.AuthURL : null;
  const dnsName = typeof data.Self?.DNSName === 'string' ? normalizeDnsName(data.Self.DNSName) : '';
  const hostname = dnsName.length > 0 ? dnsName : null;
  return {
    running: backendState === 'Running',
    needsLogin: backendState === 'NeedsLogin' || Boolean(authUrl),
    hostname,
    url: hostname ? `https://${hostname}` : null,
    authUrl,
  };
}

const OFFLINE_STATUS = {
  running: false,
  needsLogin: false,
  hostname: null,
  url: null,
  authUrl: null,
} as const;

/** Read the local Tailscale daemon state. Never throws. */
export async function getTailscaleStatus(): Promise<TailscaleStatus> {
  const bin = await resolveTailscaleBin();
  if (!bin) {
    return { installed: false, error: null, ...OFFLINE_STATUS };
  }
  // `status --json` exits 0 even while the daemon is stopped, so a failure here
  // means something real (daemon down, permission) — surface it.
  const result = await runTailscale(['status', '--json']);
  if (!result.ok) {
    return { installed: true, error: result.error, ...OFFLINE_STATUS };
  }
  try {
    return { installed: true, error: null, ...parseTailscaleStatus(JSON.parse(result.stdout)) };
  } catch {
    return { installed: true, error: 'Could not parse tailscale status', ...OFFLINE_STATUS };
  }
}

interface ServeWebEntry {
  Handlers?: Record<string, { Proxy?: unknown }>;
}

function proxyTargetsPort(proxy: string, appPort: number): boolean {
  try {
    const parsed = new URL(proxy);
    if (parsed.port) return Number(parsed.port) === appPort;
    return appPort === (parsed.protocol === 'https:' ? 443 : 80);
  } catch {
    return false;
  }
}

/** `host.tailnet.ts.net:8443` + `/foo` -> `https://host.tailnet.ts.net:8443/foo` */
function buildServeUrl(hostPort: string, path: string): string {
  const lastColon = hostPort.lastIndexOf(':');
  const host = lastColon > 0 ? hostPort.slice(0, lastColon) : hostPort;
  const port = lastColon > 0 ? hostPort.slice(lastColon + 1) : '';
  const portSuffix = port && port !== '443' ? `:${port}` : '';
  const pathSuffix = path && path !== '/' ? path : '';
  return `https://${host}${portSuffix}${pathSuffix}`;
}

/** Pure parse of `tailscale serve status --json`, looking for this app's port. */
export function parseServeInfo(raw: unknown, appPort: number): TailscaleServeInfo {
  const web = (raw as { Web?: Record<string, ServeWebEntry> } | null)?.Web;
  if (!web || typeof web !== 'object') return { configured: false, url: null, error: null };

  for (const [hostPort, entry] of Object.entries(web)) {
    const handlers = entry?.Handlers;
    if (!handlers || typeof handlers !== 'object') continue;
    for (const [path, handler] of Object.entries(handlers)) {
      const proxy = typeof handler?.Proxy === 'string' ? handler.Proxy : '';
      if (!proxyTargetsPort(proxy, appPort)) continue;
      return { configured: true, url: buildServeUrl(hostPort, path), error: null };
    }
  }
  return { configured: false, url: null, error: null };
}

/** Is `tailscale serve` already exposing this app's port? Never throws. */
export async function getTailscaleServeInfo(appPort: number): Promise<TailscaleServeInfo> {
  const bin = await resolveTailscaleBin();
  if (!bin) return { configured: false, url: null, error: 'Tailscale CLI not found' };
  const result = await runTailscale(['serve', 'status', '--json']);
  if (!result.ok) return { configured: false, url: null, error: result.error };
  try {
    return parseServeInfo(JSON.parse(result.stdout), appPort);
  } catch {
    return { configured: false, url: null, error: 'Could not parse tailscale serve status' };
  }
}

/** Copy-paste command that exposes the app to the tailnet. We never run it. */
export function buildServeCommand(appPort: number, httpsPort = DEFAULT_TAILNET_HTTPS_PORT): string {
  return `tailscale serve --bg --https=${httpsPort} http://localhost:${appPort}`;
}

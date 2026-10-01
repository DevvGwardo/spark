import type { Express } from 'express';
import { execFile } from 'child_process';
import { constants as fsConstants } from 'fs';
import { access } from 'fs/promises';
import { promisify } from 'util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hermesAgentBin } from '../../shared/hermes-agent';
import { sendJson } from '../lib/helpers';
import { logger } from '../lib/logger';

const execFileAsync = promisify(execFile);

// os.homedir() is crash-safe when HOME is unset (falls back to the OS user
// database); process.env.HOME + ... would produce a broken "/.hermes/…" path.
const HERMES_HOME = homedir();
if (!HERMES_HOME) {
  logger.warn('[hermes-runtimes] os.homedir() returned empty — Hermes paths may be incorrect');
}
const HERMES_DIR = join(HERMES_HOME, '.hermes', 'hermes-agent');
const HERMES_BIN = hermesAgentBin(HERMES_DIR);
const DOCKER_HERMES_CONTAINER = 'hermes-docker';

type ExecFileAsyncFn = (
  file: string,
  args: readonly string[],
  options?: {
    timeout?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string; stderr: string }>;
type PathExistsFn = (path: string) => Promise<boolean>;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function inspectHermesRuntimes(deps?: {
  execFileAsync?: ExecFileAsyncFn;
  pathExists?: PathExistsFn;
  fetchImpl?: typeof fetch;
}) {
  const runExec = deps?.execFileAsync ?? execFileAsync;
  const checkPath = deps?.pathExists ?? pathExists;
  const fetchImpl = deps?.fetchImpl ?? fetch;

  const hostDirExists = await checkPath(HERMES_DIR);
  const hostBinExists = await checkPath(HERMES_BIN);

  let hostVersion: string | null = null;
  if (hostDirExists && hostBinExists) {
    try {
      const { stdout } = await runExec(HERMES_BIN, ['--version'], {
        timeout: 10000,
        env: { ...process.env, NO_COLOR: '1' },
      });
      const match = stdout.split('\n')[0].match(/Hermes Agent (v[\d.]+)/);
      if (match) hostVersion = match[1];
    } catch {
      // intentionally ignored
    }
  }

  let hostGitSha: string | null = null;
  if (hostDirExists) {
    try {
      const { stdout } = await runExec(
        'git',
        ['-C', HERMES_DIR, 'rev-parse', '--short', 'HEAD'],
        { timeout: 10000 }
      );
      const value = stdout.trim();
      if (value) hostGitSha = value;
    } catch {
      // intentionally ignored
    }
  }

  const host = {
    source: HERMES_DIR,
    version: hostVersion,
    gitSha: hostGitSha,
    available: hostDirExists && hostBinExists,
  };

  try {
    await runExec('docker', ['version', '--format', '{{.Client.Version}}'], {
      timeout: 10000,
    });
  } catch {
    return {
      host,
      container: {
        name: DOCKER_HERMES_CONTAINER,
        available: false,
        running: false,
        image: null,
        imageCreated: null,
        apiPort: null,
        apiReachable: false,
        healthPlatform: null,
      },
    };
  }

  let containerAvailable = true;
  let containerRunning = false;
  try {
    const { stdout } = await runExec(
      'docker',
      ['inspect', DOCKER_HERMES_CONTAINER, '--format', '{{.State.Running}}'],
      { timeout: 10000 }
    );
    containerRunning = stdout.trim() === 'true';
  } catch {
    containerAvailable = false;
  }

  let containerImage: string | null = null;
  let imageCreated: string | null = null;
  let apiPort: number | null = null;
  let apiReachable = false;
  let healthPlatform: string | null = null;

  if (containerAvailable && containerRunning) {
    try {
      const { stdout } = await runExec(
        'docker',
        ['inspect', DOCKER_HERMES_CONTAINER, '--format', '{{.Config.Image}}'],
        { timeout: 10000 }
      );
      const value = stdout.trim();
      if (value) containerImage = value;
    } catch {
      // intentionally ignored
    }

    try {
      if (containerImage) {
        const { stdout } = await runExec(
          'docker',
          ['image', 'inspect', containerImage, '--format', '{{.Created}}'],
          { timeout: 10000 }
        );
        const value = stdout.trim();
        if (value) imageCreated = value;
      }
    } catch {
      // intentionally ignored
    }

    // List published ports as containerPort|hostPort pairs, e.g.
    // "8000/tcp|49153,6379/tcp|49154". Map-iteration order is arbitrary, so
    // the first entry is not necessarily the API port — probe them all below.
    const publishedPorts: Array<{ containerPort: number; hostPort: number }> = [];
    try {
      const { stdout } = await runExec(
        'docker',
        [
          'inspect',
          DOCKER_HERMES_CONTAINER,
          '--format',
          '{{range $p, $conf := .NetworkSettings.Ports}}{{if $conf}}{{$p}}|{{(index $conf 0).HostPort}},{{end}}{{end}}',
        ],
        { timeout: 10000 }
      );
      for (const pair of stdout.trim().split(',')) {
        const [containerRef, hostPortStr] = pair.split('|');
        if (!containerRef || !hostPortStr) continue;
        const containerPort = Number.parseInt(containerRef, 10); // "8000/tcp" -> 8000
        const hostPort = Number.parseInt(hostPortStr, 10);
        if (Number.isFinite(containerPort) && Number.isFinite(hostPort)) {
          publishedPorts.push({ containerPort, hostPort });
        }
      }
    } catch {
      // intentionally ignored
    }

    // Probe each mapped host port until one answers /health — the container
    // may publish several ports (Redis, DB, …) and only the API port passes.
    try {
      for (const { hostPort } of publishedPorts) {
        try {
          const response = await fetchImpl(`http://localhost:${hostPort}/health`, {
            signal: AbortSignal.timeout(3000),
          });
          if (response.ok) {
            apiPort = hostPort;
            apiReachable = true;
            const body = await response.json();
            healthPlatform = body.platform || null;
            break;
          }
        } catch {
          // not this port — try the next mapped port
        }
      }
      // No port answered — still surface the first mapped port for the UI.
      if (apiPort === null && publishedPorts.length > 0) {
        apiPort = publishedPorts[0].hostPort;
      }
    } catch {
      // intentionally ignored
    }
  }

  return {
    host,
    container: {
      name: DOCKER_HERMES_CONTAINER,
      available: containerAvailable,
      running: containerRunning,
      image: containerImage,
      imageCreated,
      apiPort,
      apiReachable,
      healthPlatform,
    },
  };
}

type HermesRuntimesPayload = Awaited<ReturnType<typeof inspectHermesRuntimes>>;

const RUNTIMES_CACHE_TTL_MS = 45_000;
const RUNTIMES_CACHE_ENABLED = process.env.VITEST !== 'true';

let runtimesCache: { payload: HermesRuntimesPayload; expiresAt: number } | null = null;

export function registerHermesRuntimesRoute(app: Express) {

  // GET /api/hermes/runtimes — inspect host and container Hermes runtimes
  app.get('/api/hermes/runtimes', async (_req, res) => {
    try {
      const now = Date.now();
      if (
        RUNTIMES_CACHE_ENABLED &&
        runtimesCache &&
        runtimesCache.expiresAt > now
      ) {
        sendJson(res, 200, runtimesCache.payload);
        return;
      }

      const payload = await inspectHermesRuntimes();
      if (RUNTIMES_CACHE_ENABLED) {
        runtimesCache = { payload, expiresAt: now + RUNTIMES_CACHE_TTL_MS };
      }
      sendJson(res, 200, payload);
    } catch (err: unknown) {
      sendJson(res, 500, {
        error: 'Failed to inspect Hermes runtimes',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

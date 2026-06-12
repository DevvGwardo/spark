import type { Express } from 'express';
import { execFile } from 'child_process';
import { constants as fsConstants } from 'fs';
import { access } from 'fs/promises';
import { promisify } from 'util';
import { sendJson } from '../lib/helpers';

const execFileAsync = promisify(execFile);

const HERMES_DIR = process.env.HOME + '/.hermes/hermes-agent';
const HERMES_BIN = process.env.HOME + '/.hermes/hermes-agent/venv/bin/hermes';
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
    } catch {}
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
    } catch {}
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
    } catch {}

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
    } catch {}

    try {
      const { stdout } = await runExec(
        'docker',
        [
          'inspect',
          DOCKER_HERMES_CONTAINER,
          '--format',
          '{{range $p, $conf := .NetworkSettings.Ports}}{{if $conf}}{{(index $conf 0).HostPort}}{{end}}{{end}}',
        ],
        { timeout: 10000 }
      );
      const parsed = Number.parseInt(stdout.trim(), 10);
      apiPort = Number.isFinite(parsed) ? parsed : null;
    } catch {}

    try {
      if (apiPort !== null) {
        const response = await fetchImpl(`http://localhost:${apiPort}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          apiReachable = true;
          const body = await response.json();
          healthPlatform = body.platform || null;
        }
      }
    } catch {}
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
    } catch (err: any) {
      sendJson(res, 500, {
        error: 'Failed to inspect Hermes runtimes',
        details: err.message,
      });
    }
  });
}

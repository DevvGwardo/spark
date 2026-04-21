import type { Express } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { sendJson } from '../lib/helpers';

const execFileAsync = promisify(execFile);

const HERMES_DIR = process.env.HOME + '/.hermes/hermes-agent';
const HERMES_BIN = process.env.HOME + '/.hermes/hermes-agent/venv/bin/hermes';
const DOCKER_HERMES_CONTAINER = 'hermes-docker';

export function registerHermesRuntimesRoute(app: Express) {

  // GET /api/hermes/runtimes — inspect host and container Hermes runtimes
  app.get('/api/hermes/runtimes', async (_req, res) => {
    try {
      let hostVersion: string | null = null;
      try {
        const { stdout } = await execFileAsync(HERMES_BIN, ['--version'], {
          timeout: 10000,
          env: { ...process.env, NO_COLOR: '1' },
        });
        const match = stdout.split('\n')[0].match(/Hermes Agent (v[\d.]+)/);
        if (match) hostVersion = match[1];
      } catch {}

      let hostGitSha: string | null = null;
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['-C', HERMES_DIR, 'rev-parse', '--short', 'HEAD'],
          { timeout: 10000 }
        );
        const value = stdout.trim();
        if (value) hostGitSha = value;
      } catch {}

      const host = {
        source: HERMES_DIR,
        version: hostVersion,
        gitSha: hostGitSha,
        available: true,
      };

      try {
        await execFileAsync('docker', ['version', '--format', '{{.Client.Version}}'], {
          timeout: 10000,
        });
      } catch {
        return sendJson(res, 200, {
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
        });
      }

      let containerAvailable = true;
      let containerRunning = false;
      try {
        const { stdout } = await execFileAsync(
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
          const { stdout } = await execFileAsync(
            'docker',
            ['inspect', DOCKER_HERMES_CONTAINER, '--format', '{{.Config.Image}}'],
            { timeout: 10000 }
          );
          const value = stdout.trim();
          if (value) containerImage = value;
        } catch {}

        try {
          if (containerImage) {
            const { stdout } = await execFileAsync(
              'docker',
              ['image', 'inspect', containerImage, '--format', '{{.Created}}'],
              { timeout: 10000 }
            );
            const value = stdout.trim();
            if (value) imageCreated = value;
          }
        } catch {}

        try {
          const { stdout } = await execFileAsync(
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
            const response = await fetch(`http://localhost:${apiPort}/health`, {
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

      sendJson(res, 200, {
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
      });
    } catch (err: any) {
      sendJson(res, 500, {
        error: 'Failed to inspect Hermes runtimes',
        details: err.message,
      });
    }
  });
}

import type { Express } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { sendJson } from '../lib/helpers';

const execFileAsync = promisify(execFile);

const HERMES_DIR = process.env.HOME + '/.hermes/hermes-agent';
const HERMES_BIN = process.env.HOME + '/.hermes/hermes-agent/venv/bin/hermes';

// Track if an update is currently running
let updateInProgress = false;

export function registerHermesUpdateRoute(app: Express) {

  // GET /api/hermes/update/status — check for available updates
  app.get('/api/hermes/update/status', async (_req, res) => {
    try {
      // Check git for commits behind
      await execFileAsync('git', ['fetch', 'origin', '--quiet'], {
        cwd: HERMES_DIR,
        timeout: 15000,
      });

      const { stdout } = await execFileAsync(
        'git',
        ['rev-list', 'HEAD..origin/main', '--count'],
        { cwd: HERMES_DIR, timeout: 10000 }
      );

      const commitsBehind = parseInt(stdout.trim(), 10) || 0;

      // Get current version from hermes --version
      let currentVersion = 'unknown';
      try {
        const { stdout: versionOut } = await execFileAsync(HERMES_BIN, ['--version'], {
          timeout: 10000,
          env: { ...process.env, NO_COLOR: '1' },
        });
        // Parse "Hermes Agent v0.9.0 (2026.4.13)" from first line
        const firstLine = versionOut.split('\n')[0];
        const match = firstLine.match(/Hermes Agent (v[\d.]+)/);
        if (match) currentVersion = match[1];
      } catch {}

      sendJson(res, 200, {
        commitsBehind,
        updateAvailable: commitsBehind > 0,
        currentVersion,
        updateInProgress,
      });
    } catch (err: any) {
      sendJson(res, 500, {
        error: 'Failed to check for updates',
        details: err.message,
      });
    }
  });

  // POST /api/hermes/update — trigger the update
  app.post('/api/hermes/update', async (_req, res) => {
    if (updateInProgress) {
      return sendJson(res, 409, { error: 'Update already in progress' });
    }

    updateInProgress = true;

    try {
      // Step 1: git fetch
      await execFileAsync('git', ['fetch', 'origin'], {
        cwd: HERMES_DIR,
        timeout: 60000,
      });

      // Step 2: git pull (merge origin/main)
      const pullResult = await execFileAsync(
        'git',
        ['merge', 'origin/main', '--no-edit'],
        { cwd: HERMES_DIR, timeout: 60000 }
      );

      // Step 3: reinstall dependencies via hermes update
      // Run hermes update which handles pip install + venv setup
      const updateResult = await execFileAsync(HERMES_BIN, ['update'], {
        cwd: HERMES_DIR,
        timeout: 300000, // 5 min max
        env: { ...process.env, NO_COLOR: '1' },
      });

      // Get new version
      let newVersion = 'unknown';
      try {
        const { stdout } = await execFileAsync(HERMES_BIN, ['--version'], {
          timeout: 10000,
          env: { ...process.env, NO_COLOR: '1' },
        });
        const match = stdout.split('\n')[0].match(/Hermes Agent (v[\d.]+)/);
        if (match) newVersion = match[1];
      } catch {}

      sendJson(res, 200, {
        success: true,
        newVersion,
        output: updateResult.stdout.slice(-500), // last 500 chars of output
      });
    } catch (err: any) {
      sendJson(res, 500, {
        success: false,
        error: err.message,
        stdout: err.stdout?.slice(-500),
        stderr: err.stderr?.slice(-500),
      });
    } finally {
      updateInProgress = false;
    }
  });
}

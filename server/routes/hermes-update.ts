import type { Express } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { sendJson } from '../lib/helpers';

const execFileAsync = promisify(execFile);

const HERMES_DIR = process.env.HOME + '/.hermes/hermes-agent';
const HERMES_BIN = process.env.HOME + '/.hermes/hermes-agent/venv/bin/hermes';

// Track if an update is currently running
let updateInProgress = false;

// Conflict markers in `git status --porcelain` output
const CONFLICT_RE = /^(U[AUD]|A[UA]|D[UA])/m;

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

      // Get current branch
      const { stdout: currentBranchOut } = await execFileAsync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: HERMES_DIR, timeout: 10000 }
      );
      const currentBranch = currentBranchOut.trim();

      // Get porcelain status for dirty and conflict detection
      const { stdout: statusOut } = await execFileAsync(
        'git',
        ['status', '--porcelain'],
        { cwd: HERMES_DIR, timeout: 10000 }
      );
      const dirty = statusOut.trim().length > 0;
      const hasConflicts = CONFLICT_RE.test(statusOut);

      // Count stash entries left behind by previous updates
      const { stdout: stashListOut } = await execFileAsync(
        'git',
        ['stash', 'list'],
        { cwd: HERMES_DIR, timeout: 10000 }
      );
      const stashCount = stashListOut
        .split('\n')
        .filter((line) => line.includes('cloud-chat-hub-update')).length;

      // Determine blocked reason — UI should not offer update when set
      let blockedReason: string | null = null;
      if (hasConflicts) {
        blockedReason = 'Hermes repo has unresolved merge conflicts. Resolve manually in ~/.hermes/hermes-agent.';
      } else if (currentBranch !== 'main') {
        blockedReason = `Hermes repo is on branch ${currentBranch}, expected main.`;
      }

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
        updateAvailable: commitsBehind > 0 && blockedReason === null,
        currentVersion,
        updateInProgress,
        currentBranch,
        dirty,
        hasConflicts,
        stashCount,
        blockedReason,
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
      // Step 0: refuse if not on main — we will not create merge commits onto other branches
      const { stdout: branchOut } = await execFileAsync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: HERMES_DIR, timeout: 10000 }
      );
      const currentBranch = branchOut.trim();
      if (currentBranch !== 'main') {
        return sendJson(res, 409, {
          success: false,
          error: `hermes repo is on branch ${currentBranch}, expected main`,
          currentBranch,
        });
      }

      // Step 1: capture pre-update SHA for rollback
      const { stdout: shaOut } = await execFileAsync(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: HERMES_DIR, timeout: 10000 }
      );
      const preUpdateSha = shaOut.trim();

      // Step 2: git fetch
      await execFileAsync('git', ['fetch', 'origin'], {
        cwd: HERMES_DIR,
        timeout: 60000,
      });

      // Step 3: stash local changes so the merge sees a clean tree
      let hadStash = false;
      try {
        const stashResult = await execFileAsync('git', ['stash', 'push', '-m', 'cloud-chat-hub-update'], {
          cwd: HERMES_DIR,
          timeout: 10000,
        });
        // git stash push returns 0 even when nothing to stash — check output
        hadStash = !stashResult.stdout.includes('No local changes');
      } catch {
        // stash push failed — proceed without stashing
      }

      // Step 4: git merge --ff-only origin/main
      try {
        await execFileAsync(
          'git',
          ['merge', '--ff-only', 'origin/main'],
          { cwd: HERMES_DIR, timeout: 60000 }
        );
      } catch (mergeErr: any) {
        // Restore the user's local changes before bailing
        if (hadStash) {
          try {
            await execFileAsync('git', ['stash', 'pop'], {
              cwd: HERMES_DIR,
              timeout: 10000,
            });
          } catch {}
        }
        return sendJson(res, 500, {
          success: false,
          error: 'Merge failed (non fast-forward): ' + (mergeErr.stderr?.trim() || mergeErr.message),
          stderr: mergeErr.stderr?.slice(-500),
        });
      }

      // Step 5: restore local changes — detect stash-pop conflicts and roll back
      if (hadStash) {
        let stashPopFailed = false;
        try {
          await execFileAsync('git', ['stash', 'pop'], {
            cwd: HERMES_DIR,
            timeout: 10000,
          });
        } catch {
          stashPopFailed = true;
        }

        if (stashPopFailed) {
          const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], {
            cwd: HERMES_DIR,
            timeout: 10000,
          });

          if (CONFLICT_RE.test(statusOut)) {
            // Roll the working tree back; leave the stash in place so the user can resolve manually
            await execFileAsync('git', ['reset', '--hard', preUpdateSha], {
              cwd: HERMES_DIR,
              timeout: 10000,
            });
            return sendJson(res, 500, {
              success: false,
              error: `stash pop conflict — rolled back to ${preUpdateSha.slice(0, 7)}. Local changes preserved in stash@{0}.`,
              stashRef: 'stash@{0}',
            });
          }
        }
      }

      // Step 6: reinstall dependencies via hermes update
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

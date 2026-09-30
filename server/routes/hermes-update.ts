import type { Express } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sendJson } from '../lib/helpers';
import { requireLocalHermesMutation } from '../lib/hermes-op-gate';
import { logger } from '../lib/logger';

const execFileAsync = promisify(execFile);

// os.homedir() is crash-safe when HOME is unset (falls back to the OS user
// database); process.env.HOME + ... would produce a broken "/.hermes/…" path.
const HERMES_HOME = homedir();
if (!HERMES_HOME) {
  logger.warn('[hermes-update] os.homedir() returned empty — Hermes paths may be incorrect');
}
const HERMES_DIR = join(HERMES_HOME, '.hermes', 'hermes-agent');
const HERMES_BIN = join(HERMES_HOME, '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes');

// Track if an update is currently running
let updateInProgress = false;

// git fetch results are cached for the status poll so a polling UI doesn't
// hit the network (and trip .git/index.lock) on every request.
const STATUS_FETCH_TTL_MS = 20_000;
let lastStatusFetchAt = 0;

// Progress of the current (or last) update, polled by the UI modal
interface UpdateProgress {
  step: number;
  totalSteps: number;
  label: string;
  done: boolean;
  success: boolean | null;
  error: string | null;
  newVersion: string | null;
}

const TOTAL_STEPS = 6;

let updateProgress: UpdateProgress = {
  step: 0,
  totalSteps: TOTAL_STEPS,
  label: '',
  done: false,
  success: null,
  error: null,
  newVersion: null,
};

function setProgress(step: number, label: string) {
  updateProgress = { ...updateProgress, step, label };
}

function finishProgress(success: boolean, error: string | null, newVersion: string | null = null) {
  updateProgress = {
    ...updateProgress,
    step: success ? TOTAL_STEPS : updateProgress.step,
    label: success ? 'Update complete' : updateProgress.label,
    done: true,
    success,
    error,
    newVersion,
  };
}

// Conflict markers in `git status --porcelain` output
const CONFLICT_RE = /^(U[AUD]|A[UA]|D[UA])/m;

export function registerHermesUpdateRoute(app: Express) {

  // GET /api/hermes/update/status — check for available updates
  app.get('/api/hermes/update/status', async (_req, res) => {
    try {
      // Check git for commits behind. The fetch is network-bound and can
      // collide with an in-flight update's own fetch (index.lock), so cache
      // it ~20s and skip it entirely while an update is running.
      const now = Date.now();
      if (!updateInProgress && now - lastStatusFetchAt >= STATUS_FETCH_TTL_MS) {
        await execFileAsync('git', ['fetch', 'origin', '--quiet'], {
          cwd: HERMES_DIR,
          timeout: 15000,
        });
        lastStatusFetchAt = Date.now();
      }

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
        // local-main is a fork branch — updates still pull from origin/main
        if (currentBranch !== 'local-main') {
          blockedReason = `Hermes repo is on branch ${currentBranch}, expected main.`;
        }
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
      } catch {
        // intentionally ignored
      }

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
    } catch (err: unknown) {
      sendJson(res, 500, {
        error: 'Failed to check for updates',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /api/hermes/update/progress — poll progress of a running update
  app.get('/api/hermes/update/progress', (_req, res) => {
    sendJson(res, 200, { ...updateProgress, updateInProgress });
  });

  // POST /api/hermes/update — trigger the update
  app.post('/api/hermes/update', requireLocalHermesMutation, async (_req, res) => {
    if (updateInProgress) {
      return sendJson(res, 409, { error: 'Update already in progress' });
    }

    updateInProgress = true;
    updateProgress = {
      step: 0,
      totalSteps: TOTAL_STEPS,
      label: 'Starting update...',
      done: false,
      success: null,
      error: null,
      newVersion: null,
    };

    try {
      // Step 0: refuse if not on main or local-main — we will not create merge commits onto other branches
      setProgress(1, 'Checking repository state...');
      const { stdout: branchOut } = await execFileAsync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: HERMES_DIR, timeout: 10000 }
      );
      const currentBranch = branchOut.trim();
      if (currentBranch !== 'main' && currentBranch !== 'local-main') {
        finishProgress(false, `hermes repo is on branch ${currentBranch}, expected main`);
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
      setProgress(2, 'Fetching latest changes...');
      await execFileAsync('git', ['fetch', 'origin'], {
        cwd: HERMES_DIR,
        timeout: 60000,
      });

      // Step 3: stash local changes so the merge sees a clean tree
      setProgress(3, 'Stashing local changes...');
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
      setProgress(4, 'Applying update...');
      try {
        await execFileAsync(
          'git',
          ['merge', '--ff-only', 'origin/main'],
          { cwd: HERMES_DIR, timeout: 60000 }
        );
      } catch (mergeErr: unknown) {
        // Restore the user's local changes before bailing
        if (hadStash) {
          try {
            await execFileAsync('git', ['stash', 'pop'], {
              cwd: HERMES_DIR,
              timeout: 10000,
            });
          } catch {
            // stash pop may fail if no stash exists
          }
        }
        const mergeErrMsg = 'Merge failed (non fast-forward): ' + (mergeErr instanceof Error ? mergeErr.message : String(mergeErr));
        const execErr = mergeErr as { stderr?: string };
        finishProgress(false, mergeErrMsg);
        return sendJson(res, 500, {
          success: false,
          error: mergeErrMsg,
          stderr: execErr.stderr?.slice(-500),
        });
      }

      // Step 5: restore local changes — detect stash-pop conflicts and roll back
      setProgress(5, 'Restoring local changes...');
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
            const stashErrMsg = `stash pop conflict — rolled back to ${preUpdateSha.slice(0, 7)}. Local changes preserved in stash@{0}.`;
            finishProgress(false, stashErrMsg);
            return sendJson(res, 500, {
              success: false,
              error: stashErrMsg,
              stashRef: 'stash@{0}',
            });
          }
        }
      }

      // Step 6: reinstall dependencies via hermes update
      setProgress(6, 'Installing dependencies...');
      try {
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
        } catch {
          // intentionally ignored
        }

        finishProgress(true, null, newVersion);
        sendJson(res, 200, {
          success: true,
          newVersion,
          output: updateResult.stdout.slice(-500), // last 500 chars of output
        });
      } catch (err: unknown) {
        // The merge already succeeded — a failure here would leave the repo
        // at the new commit with broken deps. Roll back to the pre-update
        // commit and restore the user's stashed changes (if any).
        const errMsg = err instanceof Error ? err.message : String(err);
        const execErr = err as { stdout?: string; stderr?: string };
        try {
          await execFileAsync('git', ['reset', '--hard', preUpdateSha], {
            cwd: HERMES_DIR,
            timeout: 10000,
          });
          if (hadStash) {
            try {
              await execFileAsync('git', ['stash', 'pop'], {
                cwd: HERMES_DIR,
                timeout: 10000,
              });
            } catch {
              // stash pop failed after rollback — leave the stash in place so
              // the user can restore their changes manually
            }
          }
        } catch (rollbackErr: unknown) {
          const rollbackMsg =
            `Update failed (${errMsg}) and rollback to ${preUpdateSha.slice(0, 7)} also failed: ` +
            (rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr));
          finishProgress(false, rollbackMsg);
          return sendJson(res, 500, { success: false, error: rollbackMsg });
        }
        finishProgress(false, errMsg);
        sendJson(res, 500, {
          success: false,
          error: errMsg,
          stdout: execErr.stdout?.slice(-500),
          stderr: execErr.stderr?.slice(-500),
        });
      }
    } catch (err: unknown) {
      finishProgress(false, err instanceof Error ? err.message : String(err));
      const execErr = err as { stdout?: string; stderr?: string };
      sendJson(res, 500, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        stdout: execErr.stdout?.slice(-500),
        stderr: execErr.stderr?.slice(-500),
      });
    } finally {
      updateInProgress = false;
    }
  });
}

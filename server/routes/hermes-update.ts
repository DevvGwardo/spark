import type { Express, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getActiveBridgeSupervisor, hermesAgentPython } from '../../shared/bridge-supervisor';
import {
  HERMES_AGENT_PATCH_NAME,
  HERMES_AGENT_VERSION_TAG,
  findHermesPatch,
  hermesAgentBin,
} from '../../shared/hermes-agent';
import { sendJson } from '../lib/helpers';
import { requireLocalHermesMutation } from '../lib/hermes-op-gate';
import {
  detectCheckout,
  gitRunner,
  listRemoteReleaseTags,
  moveToTag,
  planPinnedUpdate,
  restartBridgeAndVerify,
  type BridgeRestartReport,
} from '../lib/hermes-agent-update';
import { logger } from '../lib/logger';

const execFileAsync = promisify(execFile);
const exec = (file: string, args: string[], opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}) =>
  execFileAsync(file, args, { ...opts, encoding: 'utf8' });

// os.homedir() is crash-safe when HOME is unset (falls back to the OS user
// database); process.env.HOME + ... would produce a broken "/.hermes/…" path.
const HERMES_HOME = homedir();
if (!HERMES_HOME) {
  logger.warn('[hermes-update] os.homedir() returned empty — Hermes paths may be incorrect');
}
const HERMES_DIR = join(HERMES_HOME, '.hermes', 'hermes-agent');
const HERMES_BIN = hermesAgentBin(HERMES_DIR);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The runs-parity patch: Electron resources, the repo's patches/, or cwd. */
function resolvePatchPath(): string | null {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return findHermesPatch([
    ...(resources ? [join(resources, 'patches', HERMES_AGENT_PATCH_NAME)] : []),
    join(PROJECT_ROOT, 'patches', HERMES_AGENT_PATCH_NAME),
    join(process.cwd(), 'patches', HERMES_AGENT_PATCH_NAME),
  ]);
}

/**
 * Reinstall hermes-agent into its own venv for the new checkout. Installs
 * without that venv (Electron's pip --target layout) are left alone.
 */
async function reinstallAgentDeps(): Promise<void> {
  const python = hermesAgentPython();
  if (!python) return;
  const editable = existsSync(join(HERMES_DIR, 'pyproject.toml')) || existsSync(join(HERMES_DIR, 'setup.py'));
  const reqs = join(HERMES_DIR, 'requirements.txt');
  if (!editable && !existsSync(reqs)) return;
  await exec(python, ['-m', 'pip', 'install', '--upgrade', ...(editable ? ['-e', HERMES_DIR] : ['-r', reqs])], {
    cwd: HERMES_DIR,
    timeout: 300_000,
  });
}

function restartBridge(expectTag: string | null): Promise<BridgeRestartReport> {
  return restartBridgeAndVerify(getActiveBridgeSupervisor(), expectTag).catch((err: unknown) => ({
    attempted: true,
    ok: false,
    message: err instanceof Error ? err.message : String(err),
  }));
}

// Track if an update is currently running
let updateInProgress = false;

// git fetch results are cached for the status poll so a polling UI doesn't
// hit the network (and trip .git/index.lock) on every request.
const STATUS_FETCH_TTL_MS = 20_000;
let lastStatusFetchAt = 0;
// Pinned checkouts poll `ls-remote` for release tags instead; same TTL.
let remoteTagsCache: { at: number; tags: string[] } | null = null;

async function remoteReleaseTags(force = false): Promise<string[]> {
  const now = Date.now();
  if (!force && remoteTagsCache && now - remoteTagsCache.at < STATUS_FETCH_TTL_MS) return remoteTagsCache.tags;
  const tags = await listRemoteReleaseTags(gitRunner(exec, HERMES_DIR, 15_000));
  remoteTagsCache = { at: Date.now(), tags };
  return tags;
}

async function hermesVersion(): Promise<string> {
  try {
    const { stdout } = await exec(HERMES_BIN, ['--version'], {
      timeout: 10000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    // Parse "Hermes Agent v0.9.0 (2026.4.13)" from first line
    const match = stdout.split('\n')[0].match(/Hermes Agent (v[\d.]+)/);
    if (match) return match[1];
  } catch {
    // intentionally ignored
  }
  return 'unknown';
}

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

const TOTAL_STEPS = 7;

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

/**
 * POST body `{ tag }` may pick any published release tag (e.g. the app's
 * pinned HERMES_AGENT_VERSION_TAG); the default is the latest release.
 */
async function handlePinnedUpdate(currentTag: string, requested: unknown, res: Response): Promise<void> {
  const tags = await remoteReleaseTags(true);
  let targetTag: string | null;
  if (requested !== undefined && requested !== null && requested !== '') {
    if (typeof requested !== 'string' || !tags.includes(requested)) {
      finishProgress(false, 'Unknown release tag');
      return sendJson(res, 400, { success: false, error: `Unknown hermes-agent release tag: ${String(requested).slice(0, 64)}` });
    }
    targetTag = requested === currentTag ? null : requested;
  } else {
    targetTag = planPinnedUpdate(currentTag, tags).targetTag;
  }
  if (!targetTag) {
    finishProgress(false, `Already at ${currentTag}`);
    return sendJson(res, 409, { success: false, error: `hermes-agent is already at ${currentTag}`, currentTag });
  }

  const moved = await moveToTag(
    { agentDir: HERMES_DIR, exec, patchPath: resolvePatchPath(), reinstallDeps: reinstallAgentDeps, onStep: setProgress },
    currentTag,
    targetTag,
  );
  if (!moved.ok) {
    logger.warn(`[hermes-update] move ${currentTag} → ${targetTag} failed: ${moved.error}`);
    finishProgress(false, moved.error ?? 'Update failed');
    return sendJson(res, 500, { success: false, error: moved.error, rolledBack: moved.rolledBack, currentTag, targetTag });
  }

  setProgress(7, 'Restarting bridge...');
  const bridgeRestart = await restartBridge(targetTag);
  finishProgress(true, null, targetTag);
  sendJson(res, 200, {
    success: true,
    newVersion: targetTag,
    previousTag: currentTag,
    patchApplied: moved.patchApplied,
    bridgeRestart,
  });
}

export function registerHermesUpdateRoute(app: Express) {

  // GET /api/hermes/update/status — check for available updates
  app.get('/api/hermes/update/status', async (_req, res) => {
    try {
      // A pinned install (detached at a release tag, as electron's installer
      // creates it) is offered "move to tag vX", never a main fast-forward.
      const checkout = await detectCheckout(gitRunner(exec, HERMES_DIR, 10_000));
      if (checkout.pinned && checkout.tag) {
        const { stdout: statusOut } = await exec('git', ['status', '--porcelain'], { cwd: HERMES_DIR, timeout: 10000 });
        const hasConflicts = CONFLICT_RE.test(statusOut);
        const { latestTag, targetTag } = planPinnedUpdate(checkout.tag, updateInProgress ? (remoteTagsCache?.tags ?? []) : await remoteReleaseTags());
        const blockedReason = hasConflicts
          ? 'Hermes repo has unresolved merge conflicts. Resolve manually in ~/.hermes/hermes-agent.'
          : null;
        return sendJson(res, 200, {
          commitsBehind: 0,
          updateAvailable: targetTag !== null && blockedReason === null,
          currentVersion: await hermesVersion(),
          updateInProgress,
          currentBranch: 'HEAD',
          dirty: statusOut.trim().length > 0,
          hasConflicts,
          stashCount: 0,
          blockedReason,
          pinned: true,
          currentTag: checkout.tag,
          latestTag,
          targetTag,
          pinnedTag: HERMES_AGENT_VERSION_TAG,
        });
      }

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

      const currentVersion = await hermesVersion();

      sendJson(res, 200, {
        pinned: false,
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
  app.post('/api/hermes/update', requireLocalHermesMutation, async (req, res) => {
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
      setProgress(1, 'Checking repository state...');
      const checkout = await detectCheckout(gitRunner(exec, HERMES_DIR, 10_000));
      if (checkout.pinned && checkout.tag) {
        return await handlePinnedUpdate(checkout.tag, (req.body as { tag?: unknown } | undefined)?.tag, res);
      }

      // Step 0: refuse if not on main or local-main — we will not create merge commits onto other branches
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

        const newVersion = await hermesVersion();

        // Step 7: the running bridge still has the old agent loaded.
        setProgress(7, 'Restarting bridge...');
        const bridgeRestart = await restartBridge(null);

        finishProgress(true, null, newVersion);
        sendJson(res, 200, {
          success: true,
          newVersion,
          bridgeRestart,
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

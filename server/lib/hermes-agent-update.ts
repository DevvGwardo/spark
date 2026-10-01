/**
 * Pinned-tag update flow for ~/.hermes/hermes-agent (spec 3.5 / G9).
 *
 * Spark installs hermes-agent as a detached checkout of a release tag with
 * patches/hermes-api-server-runs-parity.patch applied on top. Fast-forwarding
 * that checkout to origin/main would leave the pin and stale the patch, so a
 * pinned checkout instead moves to another release tag:
 *
 *   remove patch → fetch tag → checkout --detach tag → re-apply + verify patch
 *   → reinstall deps → (caller) restart the bridge through the supervisor.
 *
 * Any failure after the checkout moves rolls back to the previous commit and
 * re-applies the patch there. Every command goes through an injected `exec`, so
 * tests drive the sequence without touching git or the network.
 */
import type { BridgeDiag, BridgeStartResult } from '../../shared/bridge-supervisor';
import {
  applyHermesPatch,
  compareReleaseTags,
  exactTagAtHead,
  isHermesPatchApplied,
  latestReleaseTag,
  revertHermesPatch,
  type GitRun,
} from '../../shared/hermes-agent';

export type Exec = (
  file: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface PinnedUpdateEnv {
  agentDir: string;
  exec: Exec;
  /** The runs-parity patch, or null when this build does not ship it. */
  patchPath: string | null;
  /** Reinstall hermes-agent's deps for the new checkout; omitted = skip. */
  reinstallDeps?: () => Promise<void>;
  onStep?: (step: number, label: string) => void;
}

export function gitRunner(exec: Exec, cwd: string, timeout = 60_000): GitRun {
  return async (args) => (await exec('git', args, { cwd, timeout })).stdout;
}

// ── Detection ───────────────────────────────────────────────────────────────

export interface CheckoutInfo {
  /** `rev-parse --abbrev-ref HEAD`: a branch name, or "HEAD" when detached. */
  branch: string;
  detached: boolean;
  /** Tag HEAD sits exactly on (only looked up when detached). */
  tag: string | null;
  /** Detached at a tag: Spark's pinned install shape. */
  pinned: boolean;
}

export async function detectCheckout(git: GitRun): Promise<CheckoutInfo> {
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const detached = branch === 'HEAD';
  const tag = detached ? await exactTagAtHead(git) : null;
  return { branch, detached, tag, pinned: detached && tag !== null };
}

/** Release tags published on origin (no fetch; `ls-remote` only). */
export async function listRemoteReleaseTags(git: GitRun): Promise<string[]> {
  const out = await git(['ls-remote', '--tags', '--refs', 'origin', 'v*']);
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1] ?? '')
    .filter((ref) => ref.startsWith('refs/tags/'))
    .map((ref) => ref.slice('refs/tags/'.length));
}

export interface PinnedPlan {
  latestTag: string | null;
  /** The tag to offer ("move to tag vX"), or null when already current. */
  targetTag: string | null;
}

export function planPinnedUpdate(currentTag: string, remoteTags: string[]): PinnedPlan {
  const latestTag = latestReleaseTag(remoteTags);
  const targetTag = latestTag && compareReleaseTags(latestTag, currentTag) > 0 ? latestTag : null;
  return { latestTag, targetTag };
}

// ── Move to tag ─────────────────────────────────────────────────────────────

export interface MoveResult {
  ok: boolean;
  error?: string;
  previousRef: string | null;
  previousTag: string | null;
  newTag: string | null;
  rolledBack: boolean;
  patchApplied: boolean;
}

/**
 * Move a pinned checkout to `targetTag`. On a patch or deps failure, check the
 * previous commit back out and re-apply the patch there.
 */
export async function moveToTag(env: PinnedUpdateEnv, currentTag: string, targetTag: string): Promise<MoveResult> {
  const git = gitRunner(env.exec, env.agentDir);
  const step = env.onStep ?? (() => {});
  const patch = env.patchPath;
  const fail = (error: string, extra: Partial<MoveResult> = {}): MoveResult => ({
    ok: false,
    error,
    previousRef: null,
    previousTag: currentTag,
    newTag: null,
    rolledBack: false,
    patchApplied: false,
    ...extra,
  });

  const previousRef = (await git(['rev-parse', 'HEAD'])).trim();

  // The patch is the only local change we own; take it off so the checkout can move.
  step(2, 'Removing Spark patch...');
  const hadPatch = patch ? await isHermesPatchApplied(git, patch) : false;
  if (hadPatch && patch) {
    const reverted = await revertHermesPatch(git, patch);
    if (!reverted.ok) return fail(reverted.message ?? 'Failed to remove Spark patch', { previousRef });
  }
  const restorePatch = async (): Promise<string | null> => {
    if (!hadPatch || !patch) return null;
    const r = await applyHermesPatch(git, patch);
    return r.ok ? null : r.message ?? 'patch re-apply failed';
  };

  // Anything else modified is the user's: refuse rather than discard it.
  const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).trim();
  if (dirty) {
    const restoreErr = await restorePatch();
    return fail(
      'hermes-agent has local changes besides the Spark patch; commit or discard them in ~/.hermes/hermes-agent first.' +
        (restoreErr ? ` (Spark patch could not be restored: ${restoreErr})` : ''),
      { previousRef },
    );
  }

  step(3, `Fetching ${targetTag}...`);
  try {
    const shallow = (await git(['rev-parse', '--is-shallow-repository'])).trim() === 'true';
    await git(['fetch', ...(shallow ? ['--depth', '1'] : []), '--no-tags', 'origin', 'tag', targetTag]);
  } catch (err) {
    const restoreErr = await restorePatch();
    return fail(`Failed to fetch ${targetTag}: ${errMessage(err)}` + (restoreErr ? ` (Spark patch not restored: ${restoreErr})` : ''), {
      previousRef,
    });
  }

  const rollback = async (reason: string): Promise<MoveResult> => {
    let rollbackErr: string | null = null;
    try {
      await git(['-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach', previousRef]);
      rollbackErr = await restorePatch();
    } catch (err) {
      rollbackErr = errMessage(err);
    }
    const where = currentTag ?? previousRef.slice(0, 7);
    return fail(
      rollbackErr
        ? `${reason}. Rollback to ${where} also failed: ${rollbackErr}`
        : `${reason}. Rolled back to ${where}.`,
      { previousRef, rolledBack: rollbackErr === null, patchApplied: rollbackErr === null && hadPatch },
    );
  };

  step(4, `Moving to ${targetTag}...`);
  try {
    await git(['-c', 'advice.detachedHead=false', 'checkout', '--detach', `refs/tags/${targetTag}`]);
  } catch (err) {
    // checkout is all-or-nothing, but restore the patch on the old commit.
    const restoreErr = await restorePatch();
    return fail(`Failed to check out ${targetTag}: ${errMessage(err)}` + (restoreErr ? ` (Spark patch not restored: ${restoreErr})` : ''), {
      previousRef,
    });
  }

  step(5, 'Re-applying Spark patch...');
  let patchApplied = false;
  if (patch) {
    const applied = await applyHermesPatch(git, patch);
    if (!applied.ok) return rollback(`Spark patch does not apply to ${targetTag} (${applied.message})`);
    patchApplied = true;
  }

  step(6, 'Installing dependencies...');
  if (env.reinstallDeps) {
    try {
      await env.reinstallDeps();
    } catch (err) {
      return rollback(`Dependency install failed on ${targetTag}: ${errMessage(err)}`);
    }
  }

  return { ok: true, previousRef, previousTag: currentTag, newTag: targetTag, rolledBack: false, patchApplied };
}

// ── Bridge restart ──────────────────────────────────────────────────────────

export interface RestartableBridge {
  restart(): Promise<BridgeStartResult>;
  diag(): Promise<BridgeDiag | null>;
}

export interface BridgeRestartReport {
  attempted: boolean;
  ok: boolean;
  message?: string;
  pid?: number | null;
  hermesAgentVersion?: string | null;
}

/**
 * Restart the bridge through its supervisor so it loads the updated agent, then
 * confirm via /diag: it must be ours (token_matches), a new process, and — when
 * the bridge reports it and a tag is expected — on the expected release.
 */
export async function restartBridgeAndVerify(
  bridge: RestartableBridge | null,
  expectTag: string | null = null,
): Promise<BridgeRestartReport> {
  if (!bridge) {
    return { attempted: false, ok: false, message: 'The Hermes bridge is not managed by this process; restart it to load the update.' };
  }
  const before = await bridge.diag();
  const result = await bridge.restart();
  if (result.status === 'failed') {
    return { attempted: true, ok: false, message: result.message ?? 'Bridge restart failed' };
  }
  const after = await bridge.diag();
  const pid = after?.pid ?? null;
  const hermesAgentVersion = after?.hermes_agent_version ?? null;
  if (!after || after.token_matches !== true) {
    return { attempted: true, ok: false, message: 'Bridge /diag did not confirm ownership after restart', pid, hermesAgentVersion };
  }
  if (before?.pid != null && pid === before.pid) {
    return { attempted: true, ok: false, message: `Bridge was not restarted (pid ${pid} unchanged)`, pid, hermesAgentVersion };
  }
  if (expectTag && hermesAgentVersion && compareReleaseTags(`v${hermesAgentVersion}`, expectTag) !== 0) {
    return {
      attempted: true,
      ok: false,
      message: `Bridge reports hermes-agent ${hermesAgentVersion}, expected ${expectTag}`,
      pid,
      hermesAgentVersion,
    };
  }
  return { attempted: true, ok: true, pid, hermesAgentVersion };
}

function errMessage(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr?.trim() || e?.message || String(err)).slice(-500);
}

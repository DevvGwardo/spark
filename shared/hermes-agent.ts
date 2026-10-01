/**
 * Hermes Agent checkout helpers shared by the Electron installer
 * (electron/hermes-agent-install.ts) and the update route
 * (server/routes/hermes-update.ts).
 *
 * One place for: the release Spark's patches are rebased against, the
 * platform-aware `hermes` CLI path inside the agent's venv, and the
 * runs-parity patch apply/verify logic. Git is reached through an injected
 * runner so both callers (and tests) choose how commands execute.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { hermesHome } from './bridge-supervisor';

// Spark patches (patches/*) are rebased against this exact Hermes release —
// see patches/README.md ("Rebased for Hermes 0.19.0 (2026.7.20)").
export const HERMES_AGENT_VERSION_TAG = 'v2026.7.20';
export const HERMES_AGENT_PATCH_NAME = 'hermes-api-server-runs-parity.patch';

/** Release tags look like v2026.7.20. */
export const RELEASE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

/** Runs `git <args>` inside the hermes-agent checkout; rejects on non-zero exit. */
export type GitRun = (args: string[]) => Promise<string>;

export function hermesAgentDir(home: string = hermesHome()): string {
  return join(home, 'hermes-agent');
}

/**
 * The `hermes` CLI inside a hermes-agent checkout's venv. POSIX venvs put
 * console scripts in bin/; Windows venvs put them in Scripts/ with .exe.
 */
export function hermesAgentBin(agentDir: string = hermesAgentDir(), platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? join(agentDir, 'venv', 'Scripts', 'hermes.exe')
    : join(agentDir, 'venv', 'bin', 'hermes');
}

/** First existing candidate path for the runs-parity patch, or null. */
export function findHermesPatch(candidates: string[], exists: (p: string) => boolean = existsSync): string | null {
  return candidates.find((p) => exists(p)) ?? null;
}

/** Compare two release tags (v2026.7.20 style). Non-release tags sort lowest. */
export function compareReleaseTags(a: string, b: string): number {
  const pa = RELEASE_TAG_RE.exec(a);
  const pb = RELEASE_TAG_RE.exec(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** Highest release tag in `tags`, or null when none look like a release. */
export function latestReleaseTag(tags: Iterable<string>): string | null {
  let best: string | null = null;
  for (const t of tags) {
    if (!RELEASE_TAG_RE.test(t)) continue;
    if (best === null || compareReleaseTags(t, best) > 0) best = t;
  }
  return best;
}

/** The tag HEAD sits exactly on (`git describe --tags --exact-match`), or null. */
export async function exactTagAtHead(git: GitRun): Promise<string | null> {
  try {
    const tag = (await git(['describe', '--tags', '--exact-match', 'HEAD'])).trim();
    return tag || null;
  } catch {
    return null;
  }
}

/** `git apply --reverse --check` succeeds exactly when the patch is already applied. */
export async function isHermesPatchApplied(git: GitRun, patchPath: string): Promise<boolean> {
  try {
    await git(['apply', '--reverse', '--check', patchPath]);
    return true;
  } catch {
    return false;
  }
}

export interface PatchResult {
  ok: boolean;
  alreadyApplied?: boolean;
  message?: string;
}

/**
 * Apply the patch idempotently and verify it: skipped when already applied,
 * otherwise `apply --check` then `apply` (atomic — a failed apply leaves the
 * tree untouched), then confirm with a reverse check.
 */
export async function applyHermesPatch(git: GitRun, patchPath: string): Promise<PatchResult> {
  if (await isHermesPatchApplied(git, patchPath)) return { ok: true, alreadyApplied: true };
  try {
    await git(['apply', '--check', patchPath]);
    await git(['apply', patchPath]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Failed to apply ${HERMES_AGENT_PATCH_NAME}: ${detail.slice(-500)}` };
  }
  if (!(await isHermesPatchApplied(git, patchPath))) {
    return { ok: false, message: `${HERMES_AGENT_PATCH_NAME} applied but did not verify (reverse check failed)` };
  }
  return { ok: true };
}

/** Remove the patch if it is applied (so a checkout can move). */
export async function revertHermesPatch(git: GitRun, patchPath: string): Promise<PatchResult> {
  if (!(await isHermesPatchApplied(git, patchPath))) return { ok: true, alreadyApplied: false };
  try {
    await git(['apply', '--reverse', patchPath]);
    return { ok: true, alreadyApplied: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Failed to remove ${HERMES_AGENT_PATCH_NAME}: ${detail.slice(-500)}` };
  }
}

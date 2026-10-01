/**
 * First-run Hermes Agent install for the Electron app (moved out of
 * electron/bridge.ts when the bridge lifecycle moved to shared/bridge-supervisor).
 *
 * Clones NousResearch/hermes-agent pinned to the release Spark's patches/ are
 * rebased against, applies the parity patch with a version check, and installs
 * its requirements into the same package dir the bridge uses.
 */
import { execFileSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { app } from 'electron'
import { findExecutable, hermesHome } from '../shared/bridge-supervisor'
import { bridgePackagesDir, resolvePython } from './bridge'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Spark patches (patches/*) are rebased against this exact Hermes release —
// see patches/README.md ("Rebased for Hermes 0.19.0 (2026.7.20)").
const HERMES_AGENT_VERSION_TAG = 'v2026.7.20'
const HERMES_AGENT_PATCH_NAME = 'hermes-api-server-runs-parity.patch'

function hermesAgentDir(): string {
  return join(hermesHome(), 'hermes-agent')
}

function findGit(): string | null {
  return findExecutable(process.platform === 'win32' ? ['git', 'git.exe'] : ['git'])
}

/**
 * Clone NousResearch/hermes-agent into ~/.hermes/hermes-agent and pip-install
 * its deps. Skips clone if directory already exists.
 *
 * The clone is pinned to the exact release Spark's patches/ are rebased
 * against (HERMES_AGENT_VERSION_TAG = Hermes 0.19.0), and the patch is applied
 * programmatically with a version check — cloning unpinned master silently
 * drifts out of sync with the patch.
 */
export async function installHermesAgent(onProgress?: (line: string) => void): Promise<{ ok: boolean; message?: string }> {
  const target = hermesAgentDir()
  const git = findGit()
  const log = (line: string) => {
    onProgress?.(line)
    console.log('[install-hermes] ' + line)
  }

  if (!git) {
    return { ok: false, message: 'Git is required to install Hermes Agent. Install Git and try again.' }
  }

  if (!existsSync(target)) {
    log(`Cloning NousResearch/hermes-agent @ ${HERMES_AGENT_VERSION_TAG}…`)
    const clone = await new Promise<{ ok: boolean; err?: string }>((res) => {
      const proc = spawn(git, ['clone', '--depth', '1', '--branch', HERMES_AGENT_VERSION_TAG,
        'https://github.com/NousResearch/hermes-agent.git', target], { stdio: ['ignore', 'pipe', 'pipe'] })
      let err = ''
      proc.stderr?.on('data', (c: Buffer) => {
        const s = c.toString()
        err += s
        log(s.trim())
      })
      proc.on('close', (code) => {
        if (code === 0) res({ ok: true })
        else res({ ok: false, err: err.trim().slice(-1000) || `git exited ${code}` })
      })
      proc.on('error', (e) => res({ ok: false, err: e.message }))
    })
    if (!clone.ok) {
      return { ok: false, message: clone.err ?? 'git clone failed' }
    }
  } else {
    log('hermes-agent directory already exists, skipping clone')
  }

  // Version check: Spark's patches only apply to the pinned release. Refuse to
  // patch a different version instead of silently corrupting the checkout.
  const version = getHermesAgentVersion(git, target)
  if (!version.ok) {
    return { ok: false, message: version.message ?? 'Could not determine hermes-agent version' }
  }
  if (version.tag !== HERMES_AGENT_VERSION_TAG) {
    return {
      ok: false,
      message: `hermes-agent is at ${version.tag}, but Spark patches target ${HERMES_AGENT_VERSION_TAG}. ` +
        `Run "git -C ~/.hermes/hermes-agent fetch --tags && git -C ~/.hermes/hermes-agent checkout ${HERMES_AGENT_VERSION_TAG}" and retry.`,
    }
  }

  // Apply Spark's patch programmatically (idempotent — skipped when already applied).
  const patchPath = resolveHermesPatchPath()
  if (!patchPath) {
    log(`Spark patch file (${HERMES_AGENT_PATCH_NAME}) not found — skipping patch application`)
  } else if (isHermesPatchApplied(git, target, patchPath)) {
    log('Spark patch already applied, skipping')
  } else {
    try {
      execFileSync(git, ['-C', target, 'apply', '--check', patchPath], { stdio: 'ignore' })
      execFileSync(git, ['-C', target, 'apply', patchPath], { stdio: 'ignore' })
      log(`Applied ${HERMES_AGENT_PATCH_NAME}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `Failed to apply ${HERMES_AGENT_PATCH_NAME}: ${detail.slice(-500)}` }
    }
  }

  // Install hermes-agent's deps using our resolved Python.
  const python = resolvePython()
  if (!python) return { ok: false, message: 'No Python found to install hermes-agent deps' }

  const reqs = join(target, 'requirements.txt')
  if (!existsSync(reqs)) {
    log('No requirements.txt found in hermes-agent — skipping pip install')
    return { ok: true }
  }

  log('Installing hermes-agent dependencies (this can take 1-3 minutes)…')
  return new Promise((res) => {
    const proc = spawn(python, ['-m', 'pip', 'install',
      '--target', bridgePackagesDir(),
      '--upgrade',
      '-r', reqs,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    proc.stdout?.on('data', (c: Buffer) => log(c.toString().trim()))
    proc.stderr?.on('data', (c: Buffer) => {
      err += c.toString()
      log(c.toString().trim())
    })
    proc.on('close', (code) => {
      if (code === 0) res({ ok: true })
      else res({ ok: false, message: err.trim().slice(-2000) || `pip exited ${code}` })
    })
  })
}

// ── Hermes agent version pinning & patch application ───────────────────────

/**
 * Resolve the pinned Hermes release the checkout is at. Shallow clones of a
 * tag report the tag via `git describe --tags --exact-match`.
 */
function getHermesAgentVersion(git: string, dir: string): { ok: boolean; tag?: string; message?: string } {
  try {
    const tag = execFileSync(git, ['-C', dir, 'describe', '--tags', '--exact-match'], {
      encoding: 'utf8',
    }).trim()
    if (!tag) throw new Error('empty describe output')
    return { ok: true, tag }
  } catch {
    try {
      const sha = execFileSync(git, ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
      return { ok: false, message: `Could not determine hermes-agent version (HEAD is ${sha})` }
    } catch {
      return { ok: false, message: '~/.hermes/hermes-agent is not a git checkout; cannot verify version' }
    }
  }
}

/**
 * `git apply --reverse --check` exits 0 when the patch is already applied.
 */
function isHermesPatchApplied(git: string, dir: string, patchPath: string): boolean {
  try {
    execFileSync(git, ['-C', dir, 'apply', '--reverse', '--check', patchPath], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Locate Spark's Hermes patch. Packaged builds receive it via extraResources
 * (process.resourcesPath/patches); dev uses the repo's patches/ directory.
 */
function resolveHermesPatchPath(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'patches', HERMES_AGENT_PATCH_NAME)]
    : [resolve(__dirname, '../../patches', HERMES_AGENT_PATCH_NAME)]
  return candidates.find((p) => existsSync(p)) ?? null
}

/**
 * First-run Hermes Agent install for the Electron app (moved out of
 * electron/bridge.ts when the bridge lifecycle moved to shared/bridge-supervisor).
 *
 * Clones NousResearch/hermes-agent pinned to the release Spark's patches/ are
 * rebased against, applies the parity patch with a version check, and installs
 * its requirements into the same package dir the bridge uses.
 */
import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { promisify } from 'util'
import { app } from 'electron'
import { findExecutable } from '../shared/bridge-supervisor'
import {
  HERMES_AGENT_PATCH_NAME,
  HERMES_AGENT_VERSION_TAG,
  applyHermesPatch,
  exactTagAtHead,
  findHermesPatch,
  hermesAgentDir,
  type GitRun,
} from '../shared/hermes-agent'
import { bridgePackagesDir, resolvePython } from './bridge'

const __dirname = dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)

function gitIn(git: string, dir: string): GitRun {
  return async (args) => (await execFileAsync(git, ['-C', dir, ...args], { encoding: 'utf8' })).stdout
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
  const gitRun = gitIn(git, target)
  const version = await getHermesAgentVersion(gitRun)
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
  } else {
    const patched = await applyHermesPatch(gitRun, patchPath)
    if (!patched.ok) return { ok: false, message: patched.message }
    log(patched.alreadyApplied ? 'Spark patch already applied, skipping' : `Applied ${HERMES_AGENT_PATCH_NAME}`)
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
async function getHermesAgentVersion(git: GitRun): Promise<{ ok: boolean; tag?: string; message?: string }> {
  const tag = await exactTagAtHead(git)
  if (tag) return { ok: true, tag }
  try {
    const sha = (await git(['rev-parse', '--short', 'HEAD'])).trim()
    return { ok: false, message: `Could not determine hermes-agent version (HEAD is ${sha})` }
  } catch {
    return { ok: false, message: '~/.hermes/hermes-agent is not a git checkout; cannot verify version' }
  }
}

/**
 * Locate Spark's Hermes patch. Packaged builds receive it via extraResources
 * (process.resourcesPath/patches); dev uses the repo's patches/ directory.
 */
function resolveHermesPatchPath(): string | null {
  return findHermesPatch(app.isPackaged
    ? [join(process.resourcesPath, 'patches', HERMES_AGENT_PATCH_NAME)]
    : [resolve(__dirname, '../../patches', HERMES_AGENT_PATCH_NAME)])
}

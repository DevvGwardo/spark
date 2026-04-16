/**
 * Hermes Bridge Launcher
 *
 * Spawns the Python Hermes bridge from inside Electron so the packaged app
 * is fully self-contained. In dev mode, if a bridge is already running on
 * the expected port (e.g. via `npm run dev:electron`), reuses it instead.
 *
 * Resolution order for the Python interpreter:
 *   1. Bundled Python in resources/python-runtime/ (production builds)
 *   2. ~/.hermes/hermes-agent/venv/bin/python3 (existing user install)
 *   3. python3 / python from PATH
 *
 * Bridge dependencies (fastapi, uvicorn, httpx, pydantic) are installed
 * lazily into ~/.hermes/cloudchat-pkgs/ on first launch; the spawn passes
 * that directory via PYTHONPATH so the bridge can import them.
 */

import { app } from 'electron'
import { spawn, ChildProcess, execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'

const BRIDGE_PORT = Number(process.env.HERMES_PORT || 3002)
const BRIDGE_HEALTH_URL = `http://127.0.0.1:${BRIDGE_PORT}/health`
const BRIDGE_HEALTH_TIMEOUT_MS = 30_000
const BRIDGE_HEALTH_POLL_MS = 500

let bridgeProcess: ChildProcess | null = null
let bridgeStartPromise: Promise<BridgeStartResult> | null = null

export interface BridgeStartResult {
  status: 'started' | 'reused-existing' | 'failed'
  message?: string
}

export interface BridgeSetupStatus {
  pythonPath: string | null
  bridgeSource: string | null
  bridgeDepsInstalled: boolean
  hermesAgentPresent: boolean
  authJsonPresent: boolean
  authJsonValid: boolean
  bridgeReachable: boolean
}

// ── Path resolution ────────────────────────────────────────────────────────

function isPackaged(): boolean {
  return app.isPackaged
}

/**
 * Locate the bundled Python interpreter. In production, electron-builder
 * places it under process.resourcesPath/python-runtime/. In dev, this
 * directory does not exist and we fall back to system Python.
 */
function findBundledPython(): string | null {
  const base = isPackaged()
    ? join(process.resourcesPath, 'python-runtime')
    : resolve(__dirname, '../../resources/python-runtime')

  const candidates = process.platform === 'win32'
    ? [join(base, 'python.exe'), join(base, 'Scripts', 'python.exe')]
    : [join(base, 'bin', 'python3'), join(base, 'bin', 'python')]

  return candidates.find((p) => existsSync(p)) ?? null
}

/**
 * Look for an existing hermes-agent venv that already has fastapi installed.
 * If present, reusing it skips the bridge-deps install entirely.
 */
function findHermesAgentPython(): string | null {
  const venvPython = process.platform === 'win32'
    ? join(homedir(), '.hermes', 'hermes-agent', 'venv', 'Scripts', 'python.exe')
    : join(homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'python3')

  if (!existsSync(venvPython)) return null

  // Verify it actually has fastapi — otherwise it's useless to us.
  try {
    execFileSync(venvPython, ['-c', 'import fastapi'], { stdio: 'ignore' })
    return venvPython
  } catch {
    return null
  }
}

function findSystemPython(): string | null {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python']

  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore' })
      return cmd
    } catch {
      // try next
    }
  }
  return null
}

export function resolvePython(): string | null {
  return findBundledPython() ?? findHermesAgentPython() ?? findSystemPython()
}

/**
 * Locate the bundled bridge source. In production, electron-builder places
 * it under process.resourcesPath/hermes-bridge/. In dev, use the project's
 * own hermes-bridge/ directory.
 */
function resolveBridgeSource(): string | null {
  const candidates = isPackaged()
    ? [join(process.resourcesPath, 'hermes-bridge')]
    : [resolve(__dirname, '../../hermes-bridge')]

  for (const dir of candidates) {
    if (existsSync(join(dir, 'main.py'))) {
      return dir
    }
  }
  return null
}

function bridgePackagesDir(): string {
  const dir = join(homedir(), '.hermes', 'cloudchat-pkgs')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function hermesAgentDir(): string {
  return join(homedir(), '.hermes', 'hermes-agent')
}

function authJsonPath(): string {
  return join(homedir(), '.hermes', 'auth.json')
}

// ── Health checks ──────────────────────────────────────────────────────────

async function isBridgeReachable(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1500)
    const res = await fetch(BRIDGE_HEALTH_URL, { signal: controller.signal })
    clearTimeout(timeout)
    return res.ok
  } catch {
    return false
  }
}

async function waitForBridge(timeoutMs = BRIDGE_HEALTH_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isBridgeReachable()) return true
    await new Promise((r) => setTimeout(r, BRIDGE_HEALTH_POLL_MS))
  }
  return false
}

// ── Setup status ───────────────────────────────────────────────────────────

function isAuthJsonValid(): boolean {
  const p = authJsonPath()
  if (!existsSync(p)) return false
  try {
    const data = JSON.parse(readFileSync(p, 'utf8')) as {
      providers?: Record<string, { api_key?: string; key?: string; token?: string }>
      credential_pool?: Array<{ api_key?: string }>
    }
    const providers = data.providers ?? {}
    const hasProviderKey = Object.values(providers).some(
      (p) => Boolean(p.api_key || p.key || p.token),
    )
    const hasPoolKey = (data.credential_pool ?? []).some((c) => Boolean(c.api_key))
    return hasProviderKey || hasPoolKey
  } catch {
    return false
  }
}

export async function getBridgeSetupStatus(): Promise<BridgeSetupStatus> {
  const pythonPath = resolvePython()
  const bridgeSource = resolveBridgeSource()
  // bridgeDepsInstalled: heuristic — fastapi importable from our packages dir,
  // OR the hermes-agent venv's python already has it.
  let bridgeDepsInstalled = false
  if (pythonPath) {
    try {
      execFileSync(pythonPath, ['-c', 'import fastapi, uvicorn, httpx, pydantic'], {
        stdio: 'ignore',
        env: {
          ...process.env,
          PYTHONPATH: bridgePackagesDir(),
        },
      })
      bridgeDepsInstalled = true
    } catch {
      bridgeDepsInstalled = false
    }
  }
  return {
    pythonPath,
    bridgeSource,
    bridgeDepsInstalled,
    hermesAgentPresent: existsSync(join(hermesAgentDir(), 'run_agent.py')),
    authJsonPresent: existsSync(authJsonPath()),
    authJsonValid: isAuthJsonValid(),
    bridgeReachable: await isBridgeReachable(),
  }
}

// ── Spawn / stop ───────────────────────────────────────────────────────────

export async function startBridge(): Promise<BridgeStartResult> {
  // Coalesce concurrent calls
  if (bridgeStartPromise) return bridgeStartPromise

  bridgeStartPromise = (async (): Promise<BridgeStartResult> => {
    if (await isBridgeReachable()) {
      console.log('[bridge] already running on :' + BRIDGE_PORT + ', reusing')
      return { status: 'reused-existing' }
    }

    const python = resolvePython()
    if (!python) {
      const msg = 'No Python interpreter found (bundled or system)'
      console.warn('[bridge] ' + msg)
      return { status: 'failed', message: msg }
    }

    const source = resolveBridgeSource()
    if (!source) {
      const msg = 'Bridge source directory not found'
      console.warn('[bridge] ' + msg)
      return { status: 'failed', message: msg }
    }

    console.log(`[bridge] spawning ${python} ${join(source, 'main.py')}`)

    bridgeProcess = spawn(python, ['main.py'], {
      cwd: source,
      env: {
        ...process.env,
        HERMES_PORT: String(BRIDGE_PORT),
        // Ensure the bridge can find its lazily-installed deps.
        PYTHONPATH: [bridgePackagesDir(), source].join(process.platform === 'win32' ? ';' : ':'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    bridgeProcess.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write('[bridge] ' + chunk.toString())
    })
    bridgeProcess.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write('[bridge:err] ' + chunk.toString())
    })
    bridgeProcess.on('exit', (code, signal) => {
      console.log(`[bridge] process exited code=${code} signal=${signal}`)
      bridgeProcess = null
      bridgeStartPromise = null
    })

    const ready = await waitForBridge()
    if (!ready) {
      return {
        status: 'failed',
        message: 'Bridge did not become healthy within ' + BRIDGE_HEALTH_TIMEOUT_MS + 'ms',
      }
    }
    return { status: 'started' }
  })()

  const result = await bridgeStartPromise
  if (result.status === 'failed') {
    bridgeStartPromise = null // allow retry on failure
  }
  return result
}

export function stopBridge(): void {
  if (!bridgeProcess) return
  try {
    if (process.platform === 'win32') {
      // SIGINT doesn't work cleanly on Windows for python; fall back to kill
      bridgeProcess.kill()
    } else {
      bridgeProcess.kill('SIGINT')
    }
  } catch (err) {
    console.warn('[bridge] error killing bridge process', err)
  }
  bridgeProcess = null
  bridgeStartPromise = null
}

// ── Setup actions (used by first-run wizard) ───────────────────────────────

/**
 * Pip-install the bridge requirements into ~/.hermes/cloudchat-pkgs/.
 * Idempotent: re-running just upgrades.
 */
export async function installBridgeDeps(): Promise<{ ok: boolean; message?: string }> {
  const python = resolvePython()
  if (!python) return { ok: false, message: 'No Python interpreter found' }
  const source = resolveBridgeSource()
  if (!source) return { ok: false, message: 'Bridge source not found' }
  const reqs = join(source, 'requirements.txt')
  if (!existsSync(reqs)) return { ok: false, message: 'requirements.txt missing in bridge source' }

  return new Promise((res) => {
    const proc = spawn(python, [
      '-m', 'pip', 'install',
      '--target', bridgePackagesDir(),
      '--upgrade',
      '-r', reqs,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    proc.stderr?.on('data', (c: Buffer) => { err += c.toString() })
    proc.on('close', (code) => {
      if (code === 0) res({ ok: true })
      else res({ ok: false, message: err.trim().slice(-2000) || `pip exited ${code}` })
    })
  })
}

/**
 * Clone NousResearch/hermes-agent into ~/.hermes/hermes-agent and pip-install
 * its deps. Skips clone if directory already exists.
 */
export async function installHermesAgent(onProgress?: (line: string) => void): Promise<{ ok: boolean; message?: string }> {
  const target = hermesAgentDir()
  const log = (line: string) => {
    onProgress?.(line)
    console.log('[install-hermes] ' + line)
  }

  if (!existsSync(target)) {
    log('Cloning NousResearch/hermes-agent…')
    const clone = await new Promise<{ ok: boolean; err?: string }>((res) => {
      const proc = spawn('git', ['clone', '--depth', '1',
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

/**
 * Write an auth.json in the format Hermes expects. Merges into existing
 * file if present so we don't clobber unrelated providers.
 */
export function writeAuthJson(input: {
  provider: string
  apiKey: string
  baseUrl?: string
  active?: boolean
}): { ok: boolean; message?: string } {
  const path = authJsonPath()
  const dir = join(homedir(), '.hermes')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  let existing: {
    version?: number
    providers?: Record<string, { api_key?: string; base_url?: string }>
    credential_pool?: unknown[]
    active_provider?: string
    updated_at?: string
  } = {}
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // start fresh on parse failure
    }
  }

  const providers = existing.providers ?? {}
  providers[input.provider] = {
    ...providers[input.provider],
    api_key: input.apiKey,
    ...(input.baseUrl ? { base_url: input.baseUrl } : {}),
  }

  const updated = {
    version: existing.version ?? 1,
    providers,
    credential_pool: existing.credential_pool ?? [],
    active_provider: input.active ? input.provider : (existing.active_provider ?? input.provider),
    updated_at: new Date().toISOString(),
  }

  try {
    writeFileSync(path, JSON.stringify(updated, null, 2), { mode: 0o600 })
    return { ok: true }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

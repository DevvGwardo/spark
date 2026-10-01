/**
 * Hermes Bridge Launcher (Electron).
 *
 * The lifecycle — token, /diag ownership check, spawn, health wait, respawn,
 * readiness, awaited stop, rotating log — lives in shared/bridge-supervisor.ts.
 * This file only injects what is Electron-specific:
 *
 *   Python:  1. bundled resources/python-runtime/ (production builds)
 *            2. ~/.hermes/hermes-agent/venv (only if it already has fastapi)
 *            3. python3 / python from PATH
 *   Install: pip --target ~/.hermes/cloudchat-pkgs, passed via PYTHONPATH.
 *   Unowned: a bridge on :3002 that is not ours is replaced (stale dev runs).
 */
import { app } from 'electron'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  BridgeSupervisor,
  findExecutable,
  findSystemPython,
  hermesAgentPython,
  hermesHome,
  runStreaming,
  type BridgeStartResult,
  type BridgeSupervisorStatus,
} from '../shared/bridge-supervisor'

export type { BridgeStartResult }
export interface BridgeSetupStatus extends BridgeSupervisorStatus {
  gitPath: string | null
  hermesAgentPresent: boolean
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const BRIDGE_PORT = Number(process.env.HERMES_PORT || 3002)

/** Resolve a resource bundled by electron-builder, or its dev-tree equivalent. */
function resourcePath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, name) : resolve(__dirname, '../..', name)
}

function findBundledPython(): string | null {
  const base = resourcePath('python-runtime')
  const candidates = process.platform === 'win32'
    ? [join(base, 'python.exe'), join(base, 'Scripts', 'python.exe')]
    : [join(base, 'bin', 'python3'), join(base, 'bin', 'python')]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** The hermes-agent venv is only useful if it already has fastapi. */
function findHermesAgentPython(): string | null {
  const python = hermesAgentPython()
  if (!python) return null
  try {
    execFileSync(python, ['-c', 'import fastapi'], { stdio: 'ignore' })
    return python
  } catch {
    return null
  }
}

export function resolvePython(): string | null {
  return findBundledPython() ?? findHermesAgentPython() ?? findSystemPython()
}

function resolveBridgeSource(): string | null {
  const dir = resourcePath('hermes-bridge')
  return existsSync(join(dir, 'main.py')) ? dir : null
}

export function bridgePackagesDir(): string {
  const dir = join(hermesHome(), 'cloudchat-pkgs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// No `token`: the supervisor mints a per-launch one, which is how Electron tells
// its own bridge apart from stale processes left on :3002.
const supervisor = new BridgeSupervisor({
  port: BRIDGE_PORT,
  resolvePython,
  resolveSource: resolveBridgeSource,
  onUnowned: 'replace',
  extraEnv: { HERMES_BRIDGE_VERSION: app.getVersion() },
  install: {
    env: (source) => ({
      PYTHONPATH: [bridgePackagesDir(), source].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
    }),
    install: async ({ python, source, log }) => {
      if (!python) return { ok: false, message: 'No Python interpreter found' }
      const reqs = join(source, 'requirements.txt')
      return runStreaming(python, ['-m', 'pip', 'install', '--target', bridgePackagesDir(), '--upgrade', '-r', reqs], {}, log)
    },
  },
})

export const bridgeSupervisor = supervisor
export const startBridge = (): Promise<BridgeStartResult> => supervisor.start()
export const stopBridge = (): Promise<void> => supervisor.stop()
export const installBridgeDeps = (onProgress?: (line: string) => void) => supervisor.installDeps(onProgress)

export async function getBridgeSetupStatus(): Promise<BridgeSetupStatus> {
  return {
    ...(await supervisor.status()),
    gitPath: findExecutable(process.platform === 'win32' ? ['git', 'git.exe'] : ['git']),
    hermesAgentPresent: existsSync(join(hermesHome(), 'hermes-agent', 'run_agent.py')),
  }
}

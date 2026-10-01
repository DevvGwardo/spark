/**
 * Server-side Hermes bridge manager (headless `serve` path, MANAGE_BRIDGE=true).
 *
 * The lifecycle — token, /diag ownership check, spawn, health wait, respawn,
 * readiness, awaited stop, rotating log — lives in shared/bridge-supervisor.ts,
 * shared with the Electron launcher. This file only injects what differs:
 *
 *   Python:  hermes-bridge/.venv first, then a hermes-agent venv, then PATH.
 *   Install: create hermes-bridge/.venv if missing and pip install into it.
 *   Unowned: refused. A bridge on the port is adopted only if its /diag token
 *            matches HERMES_BRIDGE_TOKEN; we never kill a process we didn't start.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BridgeSupervisor,
  findSystemPython,
  hermesAgentPython,
  runStreaming,
  venvPython,
  type BridgeStartResult,
  type BridgeSupervisorStatus,
} from '../../shared/bridge-supervisor';
import { logger } from './logger';

export type { BridgeStartResult };
export type ServerBridgeStatus = BridgeSupervisorStatus;

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRIDGE_DIR = join(PROJECT_ROOT, 'hermes-bridge');
const VENV_DIR = join(BRIDGE_DIR, '.venv');

/** The port the bridge listens on, derived from HERMES_BRIDGE_URL / HERMES_PORT. */
export function getBridgePort(): number {
  try {
    const fromUrl = Number(new URL(process.env.HERMES_BRIDGE_URL ?? '').port);
    if (Number.isInteger(fromUrl) && fromUrl > 0) return fromUrl;
  } catch {
    // fall through to env / default
  }
  const envPort = Number(process.env.HERMES_PORT);
  return Number.isInteger(envPort) && envPort > 0 ? envPort : 3002;
}

/** Prefer the bridge's own venv, then a hermes-agent venv, then system Python. */
export function resolvePython(): string | null {
  const venv = venvPython(VENV_DIR);
  if (existsSync(venv)) return venv;
  return hermesAgentPython() ?? findSystemPython();
}

export function resolveBridgeSource(): string | null {
  return existsSync(join(BRIDGE_DIR, 'main.py')) ? BRIDGE_DIR : null;
}

let supervisor: BridgeSupervisor | null = null;

/** Created lazily so merely importing this module (e.g. for /status) spawns nothing. */
export function getManagedBridgeSupervisor(): BridgeSupervisor {
  supervisor ??= new BridgeSupervisor({
    port: getBridgePort(),
    // An operator-provided token lets a bridge started by scripts/start-bridge.sh
    // with the same token be adopted; otherwise a fresh one is minted.
    token: process.env.HERMES_BRIDGE_TOKEN,
    resolvePython,
    resolveSource: resolveBridgeSource,
    onUnowned: 'refuse',
    extraEnv: { HERMES_DISABLE_LAZY_INSTALLS: '1' },
    logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
    install: {
      env: () => ({}),
      install: async ({ source, log }) => {
        const venv = venvPython(VENV_DIR);
        if (!existsSync(venv)) {
          const sys = findSystemPython();
          if (!sys) return { ok: false, message: 'No Python found to create the bridge virtualenv.' };
          log('Creating virtualenv (.venv)…');
          const created = await runStreaming(sys, ['-m', 'venv', VENV_DIR], {}, log);
          if (!created.ok) return created;
        }
        log('Installing bridge dependencies…');
        return runStreaming(venv, ['-m', 'pip', 'install', '--upgrade', '-r', join(source, 'requirements.txt')], { cwd: source }, log);
      },
    },
  });
  return supervisor;
}

export const getBridgeStatus = (): Promise<ServerBridgeStatus> => getManagedBridgeSupervisor().status();
export const startManagedBridge = (): Promise<BridgeStartResult> => getManagedBridgeSupervisor().start();
export const installBridgeDeps = (onProgress?: (line: string) => void) =>
  getManagedBridgeSupervisor().installDeps(onProgress);

/** Intentional stop: SIGINT → 5s → SIGKILL, awaited. Never triggers a respawn. */
export async function stopManagedBridge(): Promise<void> {
  await supervisor?.stop();
}

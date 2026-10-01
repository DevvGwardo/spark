/**
 * Bridge readiness: the single signal the UI uses to decide whether Hermes
 * queries should run.
 *
 * Primary source is `GET /api/bridge/readiness` (hardening spec Phase 3.3),
 * pushed by the bridge supervisor. Until a server with that route is running,
 * the route 404s and we derive an equivalent value from the `/api/hermes/health`
 * probe the app already uses (`detectHermesBridge`), so the gate works against
 * both old and new servers.
 */
import { getApiBaseUrl } from './api';
import { detectHermesBridge } from './detect-hermes';

import {
  BRIDGE_READINESS_STATES,
  type BridgeReadiness,
  type BridgeReadinessState,
} from '../../shared/bridge-readiness';

export type { BridgeReadiness, BridgeReadinessState };

/** Readiness plus where it came from — the fallback carries no stderr. */
export interface BridgeReadinessResult extends BridgeReadiness {
  source: 'readiness' | 'health-fallback';
}

const READINESS_STATES: ReadonlySet<string> = new Set<string>(BRIDGE_READINESS_STATES);

/** States in which Hermes queries may run. */
export function isBridgeUsable(state: BridgeReadinessState | undefined): boolean {
  return state === 'ready' || state === 'degraded';
}

/** Poll cadence: fast while the bridge is coming up, relaxed once it is up. */
export function readinessPollInterval(state: BridgeReadinessState | undefined): number {
  if (state === 'ready' || state === 'degraded') return 15_000;
  if (state === 'stopped' || state === 'crashed') return 5_000;
  return 2_000;
}

function parseReadiness(data: unknown): BridgeReadiness | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.state !== 'string' || !READINESS_STATES.has(d.state)) return null;
  return {
    state: d.state as BridgeReadinessState,
    since: typeof d.since === 'number' ? d.since : Date.now(),
    attempt: typeof d.attempt === 'number' ? d.attempt : 0,
    lastError: typeof d.lastError === 'string' ? d.lastError : null,
    stderrTail: Array.isArray(d.stderrTail)
      ? d.stderrTail.filter((line): line is string => typeof line === 'string')
      : [],
  };
}

/**
 * When the readiness route is missing we stop asking for a while instead of
 * paying a guaranteed 404 on every poll. Re-checked periodically so a server
 * upgraded underneath a long-lived window is picked up without a reload.
 */
const READINESS_404_RECHECK_MS = 60_000;
let readinessMissingAt: number | null = null;

/** Test helper. */
export function __resetBridgeReadinessForTests(): void {
  readinessMissingAt = null;
}

async function fetchReadinessRoute(): Promise<BridgeReadiness | 'missing'> {
  const response = await fetch(`${getApiBaseUrl()}/api/bridge/readiness`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(4_000),
  });
  if (response.status === 404) return 'missing';
  const data = await response.json().catch(() => null);
  const parsed = parseReadiness(data);
  // A non-404 response that isn't the contract (an old server's SPA fallback,
  // a proxy error page) is treated like a missing route rather than "offline".
  return parsed ?? 'missing';
}

async function fallbackFromHealth(previous: BridgeReadinessState | undefined): Promise<BridgeReadinessResult> {
  const status = await detectHermesBridge({ force: true });
  const now = Date.now();
  if (status?.isReachable) {
    return { state: 'ready', since: now, attempt: 0, lastError: null, stderrTail: [], source: 'health-fallback' };
  }
  // The health probe can't tell "never came up" from "went away"; the last
  // state we saw can. A bridge that was usable and now isn't is reconnecting.
  const state: BridgeReadinessState =
    previous === 'ready' || previous === 'degraded' || previous === 'restarting' ? 'restarting' : 'stopped';
  return { state, since: now, attempt: 0, lastError: null, stderrTail: [], source: 'health-fallback' };
}

/**
 * Resolve the bridge's readiness. Never throws: an unreachable API server is
 * itself an answer (`stopped`, with the network error as `lastError`).
 */
export async function fetchBridgeReadiness(
  previous?: BridgeReadinessState,
): Promise<BridgeReadinessResult> {
  const skipRoute =
    readinessMissingAt !== null && Date.now() - readinessMissingAt < READINESS_404_RECHECK_MS;

  if (!skipRoute) {
    try {
      const result = await fetchReadinessRoute();
      if (result !== 'missing') {
        readinessMissingAt = null;
        return { ...result, source: 'readiness' };
      }
      readinessMissingAt = Date.now();
    } catch (err) {
      // The API server itself is unreachable; the health probe would fail too.
      return {
        state: previous && isBridgeUsable(previous) ? 'restarting' : 'stopped',
        since: Date.now(),
        attempt: 0,
        lastError: err instanceof Error ? err.message : String(err),
        stderrTail: [],
        source: 'readiness',
      };
    }
  }

  return fallbackFromHealth(previous);
}

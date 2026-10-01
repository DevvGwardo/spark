/**
 * Bridge readiness contract (spec Phase 3.3).
 *
 * Served by `GET /api/bridge/readiness` and consumed by the UI's bridge gate.
 * Both the Electron and headless supervisors produce exactly this shape, so the
 * frontend never has to guess the bridge's state from individual request
 * failures.
 *
 *   starting   → first spawn, waiting for /health + ownership
 *   ready      → healthy, probes fast
 *   degraded   → process alive, but health probes slow (>2s) or failing
 *   restarting → unexpected exit; respawn scheduled or in flight
 *   crashed    → respawn budget exhausted (5 attempts / 5 min); stderrTail kept
 *   stopped    → not running (never started, intentionally stopped, or a
 *                start precondition failed — see lastError)
 */
export type BridgeReadinessState =
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'restarting'
  | 'crashed'
  | 'stopped';

export interface BridgeReadiness {
  state: BridgeReadinessState;
  /** Epoch ms of the last state transition. */
  since: number;
  /** Respawn attempt in the current window; 0 when healthy. */
  attempt: number;
  lastError: string | null;
  /** Last stderr lines of the bridge. Only populated when `crashed`, else []. */
  stderrTail: string[];
}

export const BRIDGE_READINESS_STATES: readonly BridgeReadinessState[] = [
  'starting',
  'ready',
  'degraded',
  'restarting',
  'crashed',
  'stopped',
];

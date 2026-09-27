import { logger } from '../lib/logger';
import type { Express } from 'express';
import { sendJson } from '../lib/helpers';
import { getHermesBridgeRoot } from '../lib/hermes-bridge-url';

// ─── Remote status probe ────────────────────────────────────────────────────
// Read-only: reports whether the local Hermes bridge is reachable, so the
// mobile view can show online/offline while the user is away. There are
// deliberately no action endpoints here — waking the machine or cycling a
// smart plug was removed because `tailscale serve` reaches the host directly.

// /health lives at the bridge root, not under /v1 (which only serves chat).
// Strip a trailing /v1 so the probe works whether the env var carries it or not.
const HERMES_BRIDGE_URL = getHermesBridgeRoot();
const HEALTH_URL = `${HERMES_BRIDGE_URL}/health`;

let lastSeenCache: { timestamp: string; host: string; profile?: string } | null = null;

async function probeHealth(): Promise<{ online: boolean; host: string; profile?: string }> {
  try {
    const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return { online: false, host: HERMES_BRIDGE_URL };
    const body = (await resp.json()) as Record<string, unknown>;
    return {
      online: true,
      host: HERMES_BRIDGE_URL,
      profile: typeof body.profile === 'string' ? body.profile : undefined,
    };
  } catch (err) {
    logger.debug(`[remote-status] health probe failed: ${err instanceof Error ? err.message : String(err)}`);
    return { online: false, host: HERMES_BRIDGE_URL };
  }
}

export function registerRemoteStatusRoutes(app: Express) {
  app.get('/api/remote/hermes-status', async (_req, res) => {
    try {
      const result = await probeHealth();
      if (result.online) {
        lastSeenCache = {
          timestamp: new Date().toISOString(),
          host: result.host,
          profile: result.profile,
        };
      }
      sendJson(res, 200, {
        online: result.online,
        lastSeen: lastSeenCache?.timestamp ?? null,
        host: result.host,
        profile: result.profile ?? lastSeenCache?.profile ?? undefined,
      });
    } catch (err: unknown) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });
}

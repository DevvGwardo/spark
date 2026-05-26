import { logger } from '../lib/logger';
import type { Express } from 'express';
import { createSocket } from 'dgram';
import { sendJson } from '../lib/helpers';

const HERMES_BRIDGE_URL = process.env.HERMES_BRIDGE_URL || 'http://localhost:3002';
const HEALTH_URL = `${HERMES_BRIDGE_URL}/health`;

// ─── In-memory cache for last successful health probe ─────────────────────
let lastSeenCache: { timestamp: string; host: string; profile?: string } | null = null;

async function probeHealth(): Promise<{ online: boolean; host: string; profile?: string }> {
  try {
    const resp = await fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { online: false, host: HERMES_BRIDGE_URL };
    const body = (await resp.json()) as Record<string, unknown>;
    return {
      online: true,
      host: HERMES_BRIDGE_URL,
      profile: typeof body.profile === 'string' ? body.profile : undefined,
    };
  } catch {
    return { online: false, host: HERMES_BRIDGE_URL };
  }
}

// ─── WoL magic packet (hand-rolled UDP) ────────────────────────────────────
function sendWolPacket(mac: string, broadcast: string): void {
  const hex = mac.replace(/[:-]/g, '');
  if (hex.length !== 12) throw new Error(`Invalid MAC address: ${mac}`);

  const macBytes = Buffer.from(hex, 'hex');
  const packet = Buffer.alloc(6 + 16 * 6);
  // 6 bytes of 0xFF
  for (let i = 0; i < 6; i++) packet[i] = 0xff;
  // 16 repetitions of the MAC
  for (let rep = 0; rep < 16; rep++) {
    macBytes.copy(packet, 6 + rep * 6);
  }

  const socket = createSocket('udp4');
  socket.on('error', () => socket.close());
  socket.send(packet, 9, broadcast, (err) => {
    socket.close();
    if (err) logger.error(`[remote-revival] WoL send error: ${err.message}`);
  });
}

export function registerRemoteRevivalRoutes(app: Express) {
  // GET /api/remote/hermes-status
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
      const message = err instanceof Error ? err.message : 'Unknown error';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/remote/wake
  app.post('/api/remote/wake', (_req, res) => {
    try {
      const mac = process.env.REMOTE_WAKE_MAC;
      if (!mac) {
        sendJson(res, 503, { error: 'not configured' });
        return;
      }
      const broadcast = process.env.REMOTE_WAKE_BROADCAST || '255.255.255.255';
      sendWolPacket(mac, broadcast);
      sendJson(res, 200, { ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/remote/ping-bridge
  app.post('/api/remote/ping-bridge', (_req, res) => {
    const attempts: { attempt: number; online: boolean; error?: string }[] = [];
    let completed = 0;
    const total = 5;

    const doProbe = () => {
      const attempt = completed + 1;
      fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) })
        .then((resp) => {
          attempts.push({ attempt, online: resp.ok });
        })
        .catch((err) => {
          attempts.push({
            attempt,
            online: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        })
        .finally(() => {
          completed++;
          if (completed < total) {
            setTimeout(doProbe, 6000);
          } else {
            sendJson(res, 200, {
              online: attempts[attempts.length - 1]?.online ?? false,
              attempts,
            });
          }
        });
    };

    doProbe();
  });

  // POST /api/remote/smart-plug
  app.post('/api/remote/smart-plug', async (_req, res) => {
    try {
      const plugUrl = process.env.REMOTE_SMART_PLUG_URL;
      if (!plugUrl) {
        sendJson(res, 503, { error: 'not configured' });
        return;
      }
      const resp = await fetch(plugUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
      });
      sendJson(res, 200, { ok: resp.ok, status: resp.status });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      sendJson(res, 502, { error: message });
    }
  });
}

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { logger } from '../lib/logger';
import type { Express, Request, Response } from 'express';
import { sendJson } from '../lib/helpers';
import { getProfileFromRequest } from '../lib/hermes-profiles';

// Admin/health endpoints live at the bridge root, not under /v1 (which only
// serves OpenAI-compatible chat). Strip a trailing /v1 so these proxies work
// whether HERMES_BRIDGE_URL is configured with or without it.
const HERMES_BRIDGE_URL = (process.env.HERMES_BRIDGE_URL || 'http://localhost:3002').replace(/\/v1\/?$/, '');

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const BRIDGE_CACHE_TTL_MS = 10_000;

const CACHEABLE_BRIDGE_PATHS = new Set([
  '/health',
  '/v1/providers',
  '/workspace/commands',
  '/workspace/overview',
]);

type BridgeCacheEntry = {
  status: number;
  contentType: string;
  body: string;
  expiresAt: number;
};

const bridgeReadCache = new Map<string, BridgeCacheEntry>();
const BRIDGE_CACHE_ENABLED = process.env.VITEST !== 'true';

function bridgeCacheKey(path: string, profile: string): string {
  return `${path}\0${profile}`;
}

function isCacheableBridgePath(path: string): boolean {
  const base = path.split('?')[0] ?? path;
  return CACHEABLE_BRIDGE_PATHS.has(base);
}

function invalidateBridgeReadCache(): void {
  bridgeReadCache.clear();
}

async function proxyTo(
  req: Request,
  res: Response,
  path: string,
  options?: RequestInit,
): Promise<void> {
  const method = (options?.method ?? 'GET').toUpperCase();
  const profile = getProfileFromRequest(req);
  const isGet = method === 'GET';

  if (!isGet) {
    invalidateBridgeReadCache();
  }

  if (BRIDGE_CACHE_ENABLED && isGet && isCacheableBridgePath(path)) {
    const cached = bridgeReadCache.get(bridgeCacheKey(path, profile));
    if (cached && cached.expiresAt > Date.now()) {
      res.status(cached.status).type(cached.contentType).send(cached.body);
      return;
    }
  }

  try {
    const response = await fetch(`${HERMES_BRIDGE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Hermes-Profile': profile,
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const rawText = await response.text();
      let data: unknown = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        // Non-JSON response
      }
      const errorData = isObjectRecord(data) ? data : {};
      const plainTextError = rawText.trim();
      const error =
        typeof errorData.error === 'string' && errorData.error
          ? errorData.error
          : plainTextError || `Bridge returned ${response.status}`;
      return sendJson(res, response.status, { error });
    }

    const contentType = response.headers.get('content-type') ?? 'application/json';

    if (isGet && !isCacheableBridgePath(path)) {
      res.status(response.status).type(contentType);
      if (response.body) {
        await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), res);
      } else {
        res.end();
      }
      return;
    }

    const rawText = await response.text();

    if (BRIDGE_CACHE_ENABLED && isGet && isCacheableBridgePath(path)) {
      bridgeReadCache.set(bridgeCacheKey(path, profile), {
        status: response.status,
        contentType,
        body: rawText,
        expiresAt: Date.now() + BRIDGE_CACHE_TTL_MS,
      });
    }

    res.status(response.status).type(contentType).send(rawText);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to reach hermes-bridge';
    logger.error(`[hermes-admin] Proxy error for ${path}: ${message}`);
    return sendJson(res, 502, { error: message });
  }
}

/**
 * Best-effort startup sanity check for HERMES_BRIDGE_URL.
 *
 * The CloudChat FastAPI bridge serves chat **and** the /workspace/* + /v1/providers
 * admin routes. The bare hermes-agent gateway only answers /health + chat, so if
 * HERMES_BRIDGE_URL is pointed at the gateway, /health passes but the command
 * palette, model picker, and session admin all silently 404. /health alone can't
 * tell them apart, so we additionally probe /v1/providers and warn loudly if it's
 * missing. Fire-and-forget, non-blocking, delayed so the bridge has time to boot.
 */
export function warnIfBridgeMisconfigured(): void {
  setTimeout(() => {
    void (async () => {
      try {
        const health = await fetch(`${HERMES_BRIDGE_URL}/health`, { signal: AbortSignal.timeout(2500) });
        if (!health.ok) return; // unreachable / still starting — not this check's concern
        const probe = await fetch(`${HERMES_BRIDGE_URL}/v1/providers`, { signal: AbortSignal.timeout(2500) });
        if (probe.status === 404) {
          logger.warn(
            `[hermes-admin] HERMES_BRIDGE_URL (${HERMES_BRIDGE_URL}) answers /health but 404s /v1/providers — ` +
            'this looks like the hermes-agent gateway, not the CloudChat bridge. The command palette, model ' +
            'picker, and session admin will fail. Point HERMES_BRIDGE_URL at the CloudChat bridge ' +
            '(default http://localhost:3002/v1).',
          );
        }
      } catch {
        // Bridge not up at boot — detection/polling handles that elsewhere.
      }
    })();
  }, 4000);
}

export function registerHermesAdminRoute(app: Express) {
  const getQuerySuffix = (req: Request) => (
    req.originalUrl.includes('?')
      ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
      : ''
  );

  // ─── Health / Detection ───────────────────────────────────────────────
  // Same-origin proxy for bridge detection so the frontend never has to reach
  // the bridge directly. A phone loading the app over LAN/tunnel can't resolve
  // the host's localhost:3002 — but it can hit this route, which the server
  // proxies to the bridge on its behalf.

  app.get('/api/hermes/health', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/health');
  });

  app.get('/api/hermes/bridges/cursor-composer', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/bridges/cursor-composer');
  });

  // ─── Providers ────────────────────────────────────────────────────────────

  app.get('/api/hermes/providers', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/v1/providers');
  });

  // ─── Cron Jobs ──────────────────────────────────────────────────────────

  app.get('/api/hermes/cron', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/cron${getQuerySuffix(req)}`);
  });

  app.post('/api/hermes/cron', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/cron', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  app.delete('/api/hermes/cron/:id', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/cron/${encodeURIComponent(req.params.id)}`, {
      method: 'DELETE',
    });
  });

  app.post('/api/hermes/cron/:id/pause', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/cron/${encodeURIComponent(req.params.id)}/pause`, {
      method: 'POST',
    });
  });

  app.post('/api/hermes/cron/:id/resume', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/cron/${encodeURIComponent(req.params.id)}/resume`, {
      method: 'POST',
    });
  });

  app.post('/api/hermes/cron/:id/run', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/cron/${encodeURIComponent(req.params.id)}/run`, {
      method: 'POST',
    });
  });

  app.get('/api/hermes/cron/:id/history', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/cron/${encodeURIComponent(req.params.id)}/history`);
  });

  // ─── Sessions ───────────────────────────────────────────────────────────

  app.get('/api/hermes/sessions', async (req: Request, res: Response) => {
    // Forward pagination/search params (limit, offset, q) through to the bridge.
    const queryIndex = req.originalUrl.indexOf('?');
    const queryString = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
    await proxyTo(req, res, `/sessions${queryString}`);
  });

  app.get('/api/hermes/sessions/:id', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/sessions/${encodeURIComponent(req.params.id)}`);
  });

  app.delete('/api/hermes/sessions/:id', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/sessions/${encodeURIComponent(req.params.id)}`, {
      method: 'DELETE',
    });
  });

  // ─── Hermes Workspace ───────────────────────────────────────────────────

  app.get('/api/hermes/workspace/overview', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/overview');
  });

  app.get('/api/hermes/workspace/commands', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/commands');
  });

  app.get('/api/hermes/workspace/auth-providers', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/auth-providers');
  });

  app.get('/api/hermes/workspace/usage', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/usage');
  });

  app.get('/api/hermes/workspace/logs', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/workspace/logs${getQuerySuffix(req)}`);
  });

  app.get('/api/hermes/workspace/system', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/system');
  });

  // ─── Webhooks ─────────────────────────────────────────────────────────

  app.get('/api/hermes/webhooks', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/webhooks');
  });

  app.post('/api/hermes/webhooks', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/webhooks', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  app.delete('/api/hermes/webhooks/:name', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/webhooks/${encodeURIComponent(req.params.name)}`, {
      method: 'DELETE',
    });
  });

  // ─── Pairing ──────────────────────────────────────────────────────────

  app.get('/api/hermes/pairing', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/pairing');
  });

  app.get('/api/hermes/workspace/files', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/files');
  });

  app.get('/api/hermes/workspace/files/:key', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/workspace/files/${encodeURIComponent(req.params.key)}`);
  });

  app.put('/api/hermes/workspace/files/:key', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/workspace/files/${encodeURIComponent(req.params.key)}`, {
      method: 'PUT',
      body: JSON.stringify(req.body),
    });
  });

  app.get('/api/hermes/workspace/skills', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/skills');
  });

  app.get('/api/hermes/workspace/skills/content', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/workspace/skills/content${getQuerySuffix(req)}`);
  });

  app.delete('/api/hermes/workspace/skills', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/skills', {
      method: 'DELETE',
      body: JSON.stringify(req.body),
    });
  });

  app.get('/api/hermes/workspace/skills/hub', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/skills/hub');
  });

  app.post('/api/hermes/workspace/skills/hub/install', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/skills/hub/install', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  // ─── MCP Servers ──────────────────────────────────────────────────────

  app.get('/api/hermes/workspace/mcp-servers', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/mcp-servers');
  });

  app.get('/api/hermes/workspace/mcp-catalog', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/mcp-catalog');
  });

  app.post('/api/hermes/workspace/mcp-servers/install', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/mcp-servers/install', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  app.delete('/api/hermes/workspace/mcp-servers/:name', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/workspace/mcp-servers/${encodeURIComponent(req.params.name)}`, {
      method: 'DELETE',
    });
  });

  // ─── Messaging Platforms ──────────────────────────────────────────────

  app.get('/api/hermes/messaging/platforms', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/messaging/platforms');
  });

  app.get('/api/hermes/messaging/platforms/:id', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/messaging/platforms/${encodeURIComponent(req.params.id)}`);
  });

  app.put('/api/hermes/messaging/platforms/:id/env', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/messaging/platforms/${encodeURIComponent(req.params.id)}/env`, {
      method: 'PUT',
      body: JSON.stringify(req.body),
    });
  });

  app.put('/api/hermes/messaging/platforms/:id/config', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/messaging/platforms/${encodeURIComponent(req.params.id)}/config`, {
      method: 'PUT',
      body: JSON.stringify(req.body),
    });
  });

  app.delete('/api/hermes/messaging/platforms/:id', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/messaging/platforms/${encodeURIComponent(req.params.id)}`, {
      method: 'DELETE',
    });
  });

  app.post('/api/hermes/messaging/platforms/:id/test', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/messaging/platforms/${encodeURIComponent(req.params.id)}/test`, {
      method: 'POST',
    });
  });

  app.post('/api/hermes/messaging/platforms/:id/restart-gateway', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/messaging/platforms/${encodeURIComponent(req.params.id)}/restart-gateway`, {
      method: 'POST',
    });
  });

  app.get('/api/hermes/messaging/platforms/:id/oauth', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/messaging/platforms/${encodeURIComponent(req.params.id)}/oauth`);
  });

  app.post('/api/hermes/messaging/platforms/:id/oauth/complete', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/messaging/platforms/${encodeURIComponent(req.params.id)}/oauth/complete`, {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });
}

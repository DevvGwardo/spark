import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { logger } from '../lib/logger';
import type { Express, NextFunction, Request, Response } from 'express';
import { isSocketLoopback, sendJson } from '../lib/helpers';
import { getProfileFromRequest } from '../lib/hermes-profiles';
import { getHermesBridgeRoot } from '../lib/hermes-bridge-url';
import { approvalPolicyStore } from '../approval-engine';

// Admin/health endpoints live at the bridge root, not under /v1 (which only
// serves OpenAI-compatible chat). Strip a trailing /v1 so these proxies work
// whether HERMES_BRIDGE_URL is configured with or without it.
const HERMES_BRIDGE_URL = getHermesBridgeRoot();

const DESTRUCTIVE_PREFIXES = [
  '/api/hermes/moa',
  '/api/hermes/fallback',
  '/api/hermes/goals',
  '/api/hermes/tool-search',
  '/api/hermes/checkpoints',
  '/api/hermes/curator',
  '/api/hermes/computer-use',
  '/api/hermes/pets',
  '/api/hermes/bundles',
  '/api/hermes/plugins',
  '/api/hermes/claw',
  '/api/hermes/kanban',
  '/api/hermes/projects',
  '/api/hermes/auth',
  '/api/hermes/portal',
  '/api/hermes/workspace/skills',
  '/api/hermes/workspace/mcp-servers',
  '/api/hermes/workspace/files',
  '/api/hermes/messaging/platforms',
  '/api/hermes/sessions',
  '/api/hermes/cron',
];

function isDestructiveHermesOp(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return false;
  }
  return DESTRUCTIVE_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

function requireLocalHermesMutation(req: Request, res: Response, next: NextFunction): void {
  // Express 4 has strict routing off, so `POST /api/hermes/kanban/swarm/`
  // (trailing slash) matches the route but yields a req.path with the slash,
  // which would bypass the exact-match set below. Normalize before lookup.
  const normalizedPath = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
  if (!isDestructiveHermesOp(req.method, normalizedPath)) {
    next();
    return;
  }
  // Tunnel traffic terminates on loopback after the Host-based token gate in
  // createApp. LAN clients connecting directly have a non-loopback socket.
  if (isSocketLoopback(req)) {
    next();
    return;
  }
  logger.warn(`[hermes-admin] blocked non-local mutating request: ${req.method} ${normalizedPath}`);
  sendJson(res, 403, { error: 'This Hermes operation is only available from the local app or an authenticated tunnel.' });
}

function bridgeAuthHeaders(): Record<string, string> {
  const token = (process.env.HERMES_BRIDGE_TOKEN || '').trim();
  return token ? { 'X-Hermes-Bridge-Token': token } : {};
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const BRIDGE_CACHE_TTL_MS = 10_000;

const CACHEABLE_BRIDGE_PATHS = new Set([
  '/health',
  '/v1/providers',
  '/workspace/commands',
  '/workspace/overview',
  '/workspace/skills',
  '/workspace/skills/hub',
  '/workspace/mcp-servers',
  '/workspace/mcp-catalog',
  '/messaging/platforms',
  '/plugins',
  '/hooks',
  '/portal/tools',
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

// Startup-race guard for the admin proxy (mirrors the chat proxy's readiness
// retry in lib/hermes.ts). The Electron main starts the bridge in parallel
// with the renderer, so the first /health, /v1/providers, /workspace/*
// polls can fire while uvicorn is still booting -> ECONNREFUSED -> 502 spam.
// Only kicks in on connection errors; happy path adds zero latency.
const BRIDGE_READY_POLL_INTERVAL_MS = 300;
// Match electron/bridge.ts waitForOwnedBridge (30s). 8s was shorter than a
// cold uvicorn + FastAPI lifespan boot, so first-paint /providers and
// /workspace/commands 502'd while the bridge was still starting.
const BRIDGE_READY_POLL_TIMEOUT_MS = 30_000;

function isLikelyBridgeConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { name?: string; code?: string; message?: string; cause?: { code?: string; name?: string } };
  const CONN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET']);
  if (err.code && CONN_CODES.has(err.code)) return true;
  if (err.cause?.code && CONN_CODES.has(err.cause.code)) return true;
  if (err.name === 'TypeError' && (err.cause || err.message?.includes('fetch failed'))) return true;
  return false;
}

async function fetchWithBridgeReadinessRetry(url: string, init: RequestInit): Promise<globalThis.Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (!isLikelyBridgeConnectionError(error)) throw error;
    const deadline = Date.now() + BRIDGE_READY_POLL_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const health = await fetch(`${HERMES_BRIDGE_URL}/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (health.ok) {
          ready = true;
          break;
        }
      } catch {
        // Bridge not up yet — keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, BRIDGE_READY_POLL_INTERVAL_MS));
    }
    if (!ready) throw error;
    logger.info('[hermes-admin] Hermes bridge became reachable; retrying proxy fetch for %s', url);
    return await fetch(url, init);
  }
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
      const maxAge = Math.max(0, Math.floor((cached.expiresAt - Date.now()) / 1000));
      res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
      res.status(cached.status).type(cached.contentType).send(cached.body);
      return;
    }
  }

  try {
    const response = await fetchWithBridgeReadinessRetry(`${HERMES_BRIDGE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Hermes-Profile': profile,
        ...bridgeAuthHeaders(),
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
        await pipeline(
          Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream),
          res,
        );
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
      // Set Cache-Control so the frontend can avoid network roundtrips entirely
      // during rapid navigation (e.g. switching panels back and forth).
      res.setHeader('Cache-Control', `public, max-age=${Math.floor(BRIDGE_CACHE_TTL_MS / 1000)}`);
    } else {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
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
            '(default http://127.0.0.1:3002).',
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

  // Local/tunnel-only gate for destructive Hermes ops (LAN clients blocked).
  app.use(requireLocalHermesMutation);

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

  // Single approval route (B3): accepts BOTH body shapes. Engine-local ids
  // (server-side approval-engine, anything not starting with "acp-") resolve
  // locally via {decision}; bridge ACP ids ("acp-*") forward to the bridge,
  // either by translating {decision} or by forwarding {option_id} verbatim.
  // Body: {"decision": "approved" | "approved_for_session" | "denied", "reason"?: string}
  //    or {"option_id": "allow_once" | "allow_session" | "allow_always" | "deny"}.
  app.post('/api/hermes/approvals/:approvalId', async (req: Request, res: Response) => {
    const { approvalId } = req.params;
    if (!approvalId) {
      sendJson(res, 400, { error: 'approvalId is required' });
      return;
    }
    const body = (req.body ?? {}) as { decision?: unknown; option_id?: unknown; reason?: unknown };
    const { decision, option_id: optionId } = body;
    const VALID_DECISIONS = ['approved', 'approved_for_session', 'denied'];
    const VALID_OPTION_IDS = ['allow_once', 'allow_session', 'allow_always', 'deny'];
    if (decision === undefined && optionId === undefined) {
      sendJson(res, 400, { error: 'body must include "decision" or "option_id"' });
      return;
    }
    if (decision !== undefined && (typeof decision !== 'string' || !VALID_DECISIONS.includes(decision))) {
      sendJson(res, 400, {
        error: 'decision must be one of: "approved", "approved_for_session", "denied"',
      });
      return;
    }
    if (optionId !== undefined && (typeof optionId !== 'string' || !VALID_OPTION_IDS.includes(optionId))) {
      sendJson(res, 400, {
        error: 'option_id must be one of: "allow_once", "allow_session", "allow_always", "deny"',
      });
      return;
    }
    if (approvalId.startsWith('acp-')) {
      const DECISION_TO_OPTION_ID: Record<string, string> = {
        approved: 'allow_once',
        approved_for_session: 'allow_session',
        denied: 'deny',
      };
      const outgoingOptionId = typeof optionId === 'string' ? optionId : DECISION_TO_OPTION_ID[decision as string];
      if (
        typeof optionId === 'string' &&
        typeof decision === 'string' &&
        DECISION_TO_OPTION_ID[decision] !== optionId
      ) {
        logger.warn(`[approvals] Conflicting decision=${decision} with option_id=${optionId} for ${approvalId} — preferring option_id`);
      }
      try {
        const upstream = await fetch(`${HERMES_BRIDGE_URL}/v1/approvals/${encodeURIComponent(approvalId)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...bridgeAuthHeaders(),
          },
          body: JSON.stringify({ option_id: outgoingOptionId }),
        });
        const payload = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
          const upstreamError = isObjectRecord(payload)
            && typeof payload.error === 'object'
            && payload.error !== null
            && 'message' in payload.error
            ? String((payload.error as Record<string, unknown>).message)
            : `Bridge returned ${upstream.status}`;
          return sendJson(res, upstream.status, { error: upstreamError });
        }
        logger.info(`[approvals] Forwarded ACP approval ${approvalId} to bridge option_id=${outgoingOptionId}`);
        return sendJson(res, 200, { ok: true, approval_id: approvalId, decision: decision ?? optionId });
      } catch (err) {
        logger.warn(`[approvals] Bridge forward failed for ${approvalId}: ${err instanceof Error ? err.message : err}`);
        return sendJson(res, 502, { error: 'Bridge unreachable for ACP approval' });
      }
    }
    if (typeof decision !== 'string') {
      sendJson(res, 400, {
        error: 'decision must be one of: "approved", "approved_for_session", "denied"',
      });
      return;
    }
    const reason = typeof body.reason === 'string' && body.reason.length > 0 ? body.reason : undefined;
    const delivered = approvalPolicyStore.resolveApproval(approvalId, decision as 'approved' | 'approved_for_session' | 'denied', reason);
    if (delivered) {
      logger.info(`[approvals] Resolved approval ${approvalId} decision=${decision}`);
      return sendJson(res, 200, { ok: true, approval_id: approvalId, decision });
    }
    return sendJson(res, 404, { error: `Unknown or expired approval: ${approvalId}` });
  });

  // ─── Providers ────────────────────────────────────────────────────────────

  app.get('/api/hermes/providers', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/v1/providers');
  });

  // ─── Mixture of Agents ─────────────────────────────────────────────────

  app.get('/api/hermes/moa', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/moa');
  });

  app.put('/api/hermes/moa', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/moa', {
      method: 'PUT',
      body: JSON.stringify(req.body),
    });
  });

  // ─── Ops: fallback, checkpoints, memory, curator, goals, … ─────────────

  app.get('/api/hermes/fallback', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/fallback');
  });

  app.put('/api/hermes/fallback', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/fallback', {
      method: 'PUT',
      body: JSON.stringify(req.body),
    });
  });

  app.get('/api/hermes/checkpoints', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/checkpoints');
  });

  app.get('/api/hermes/delegation/live/latest', async (req: Request, res: Response) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    await proxyTo(req, res, `/delegation/live/latest${qs}`);
  });

  app.get('/api/hermes/delegation/live/:delegationId', async (req: Request, res: Response) => {
    const id = encodeURIComponent(String(req.params.delegationId || ''));
    await proxyTo(req, res, `/delegation/live/${id}`);
  });

  app.get(
    '/api/hermes/delegation/live/:delegationId/task/:taskIndex',
    async (req: Request, res: Response) => {
      const id = encodeURIComponent(String(req.params.delegationId || ''));
      const index = encodeURIComponent(String(req.params.taskIndex || '0'));
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      await proxyTo(req, res, `/delegation/live/${id}/task/${index}${qs}`);
    },
  );

  app.post('/api/hermes/checkpoints/prune', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/checkpoints/prune', { method: 'POST', body: '{}' });
  });

  app.post('/api/hermes/checkpoints/restore', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/checkpoints/restore', {
      method: 'POST',
      body: JSON.stringify(req.body ?? {}),
    });
  });

  app.get('/api/hermes/memory/status', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/memory/status');
  });

  app.get('/api/hermes/curator/status', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/curator/status');
  });

  app.post('/api/hermes/curator/run', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/curator/run', { method: 'POST', body: '{}' });
  });

  app.get('/api/hermes/computer-use/status', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/computer-use/status');
  });

  app.get('/api/hermes/bundles', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/bundles');
  });

  app.get('/api/hermes/bundles/:name', async (req: Request, res: Response) => {
    const name = encodeURIComponent(String(req.params.name || ''));
    await proxyTo(req, res, `/bundles/${name}`);
  });

  app.post('/api/hermes/bundles/create', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/bundles/create', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  app.post('/api/hermes/bundles/delete', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/bundles/delete', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  app.post('/api/hermes/bundles/reload', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/bundles/reload', { method: 'POST', body: '{}' });
  });

  app.get('/api/hermes/dashboard/url', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/dashboard/url');
  });

  app.get('/api/hermes/goals', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/goals');
  });

  app.put('/api/hermes/goals', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/goals', {
      method: 'PUT',
      body: JSON.stringify(req.body),
    });
  });

  app.get('/api/hermes/tool-search', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/tool-search');
  });

  app.put('/api/hermes/tool-search', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/tool-search', {
      method: 'PUT',
      body: JSON.stringify(req.body),
    });
  });

  app.get('/api/hermes/insights', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/insights${getQuerySuffix(req)}`);
  });

  app.get('/api/hermes/journey', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/journey');
  });

  app.post('/api/hermes/computer-use/install', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/computer-use/install', { method: 'POST', body: '{}' });
  });

  app.get('/api/hermes/computer-use/doctor', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/computer-use/doctor');
  });

  app.get('/api/hermes/pets', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/pets');
  });

  app.get('/api/hermes/pets/gallery', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/pets/gallery${getQuerySuffix(req)}`);
  });

  app.post('/api/hermes/pets/select', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/pets/select', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  app.get('/api/hermes/plugins', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/plugins${getQuerySuffix(req)}`);
  });

  app.post('/api/hermes/plugins/enable', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/plugins/enable', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  app.post('/api/hermes/plugins/disable', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/plugins/disable', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  app.get('/api/hermes/hooks', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/hooks');
  });

  app.get('/api/hermes/hooks/doctor', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/hooks/doctor');
  });

  app.get('/api/hermes/lsp/status', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/lsp/status');
  });

  app.post('/api/hermes/claw/migrate', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/claw/migrate', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  app.get('/api/hermes/gateway/capabilities', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/gateway/capabilities${getQuerySuffix(req)}`);
  });

  app.post('/api/hermes/kanban/swarm', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/kanban/swarm', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  app.get('/api/hermes/projects', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/projects${getQuerySuffix(req)}`);
  });

  app.post('/api/hermes/projects', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/projects', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  app.post('/api/hermes/projects/use', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/projects/use', {
      method: 'POST',
      body: JSON.stringify(req.body ?? {}),
    });
  });

  app.post('/api/hermes/projects/bind-board', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/projects/bind-board', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  app.get('/api/hermes/security/audit', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/security/audit${getQuerySuffix(req)}`);
  });

  app.get('/api/hermes/secrets/status', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/secrets/status');
  });

  // ─── Auth credential pool (hermes auth) ─────────────────────────────────

  app.get('/api/hermes/auth/pool', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/auth/pool');
  });

  app.get('/api/hermes/auth/pool/:provider/status', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/auth/pool/${encodeURIComponent(req.params.provider)}/status`);
  });

  app.post('/api/hermes/auth/pool/reset', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/auth/pool/reset', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  app.post('/api/hermes/auth/pool/remove', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/auth/pool/remove', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  app.post('/api/hermes/auth/pool/add', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/auth/pool/add', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  // ─── Nous Portal (hermes portal) ─────────────────────────────────────────

  app.get('/api/hermes/portal/info', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/portal/info');
  });

  app.get('/api/hermes/portal/status', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/portal/status');
  });

  app.get('/api/hermes/portal/tools', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/portal/tools');
  });

  app.get('/api/hermes/portal/open-url', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/portal/open-url');
  });

  app.get('/api/hermes/portal/open', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/portal/open');
  });

  app.post('/api/hermes/portal/oauth/start', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/portal/oauth/start', { method: 'POST' });
  });

  app.get('/api/hermes/portal/oauth/poll/:sessionId', async (req: Request, res: Response) => {
    await proxyTo(
      req,
      res,
      `/portal/oauth/poll/${encodeURIComponent(req.params.sessionId)}`,
    );
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

  app.post('/api/hermes/sessions/:id/fork', async (req: Request, res: Response) => {
    await proxyTo(req, res, `/sessions/${encodeURIComponent(req.params.id)}/fork`, {
      method: 'POST',
      body: JSON.stringify(req.body ?? {}),
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

  app.get('/api/hermes/workspace/system', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/system');
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

  // Live MCP dashboard telemetry (status, metrics, activity) and per-server logs.
  app.get('/api/hermes/workspace/mcp-telemetry', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/mcp-telemetry');
  });

  app.get('/api/hermes/workspace/mcp-tool-index', async (req: Request, res: Response) => {
    await proxyTo(req, res, '/workspace/mcp-tool-index');
  });

  app.get('/api/hermes/workspace/mcp-servers/:name/logs', async (req: Request, res: Response) => {
    await proxyTo(
      req,
      res,
      `/workspace/mcp-servers/${encodeURIComponent(req.params.name)}/logs${getQuerySuffix(req)}`,
    );
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

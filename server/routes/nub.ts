/**
 * Nub: sign in with the user's nub account (maiavm.com) and use it as a
 * provider, plus a bridge to their cloud nub agent.
 *
 *   POST /api/nub/auth/start   → device code + Telegram link to approve
 *   GET  /api/nub/auth/poll    → pending | … | ready (+ model key, once)
 *   GET  /api/nub/status       → linked? which agent? key prefix
 *   POST /api/nub/key          → fresh model key for the linked session
 *   POST /api/nub/logout       → revoke on maiavm, forget locally
 *   POST /api/nub/ask          → one message to the nub agent
 *   POST /api/nub/mcp          → MCP endpoint Hermes calls (bearer token)
 *
 * The desktop session stays on the server (lib/nub/store.ts). The model key
 * is returned to the renderer, which stores it like any provider key.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Express, Request } from 'express';
import { bridge } from '../lib/bridge-client';
import { logger } from '../lib/logger';
import { sendJson } from '../lib/helpers';
import { askNubAgent, NubNotLinkedError } from '../lib/nub/agent';
import { NubApiError, NubClient, type MintedKey } from '../lib/nub/client';
import { handleNubMcpMessage } from '../lib/nub/mcp';
import { clearNubAuth, loadNubAuth, newMcpToken, saveNubAuth, type NubAuth } from '../lib/nub/store';

/** Unbound device codes live 10 minutes on maiavm; bound ones longer (VM boot). */
const PENDING_LINK_TTL_MS = 40 * 60_000;

type PendingLink = { nonce: string; createdAt: number };
const pendingLinks = new Map<string, PendingLink>();

function rememberLink(code: string, nonce: string) {
  const now = Date.now();
  for (const [key, link] of pendingLinks) {
    if (now - link.createdAt > PENDING_LINK_TTL_MS) pendingLinks.delete(key);
  }
  pendingLinks.set(code, { nonce, createdAt: now });
}

export function nubMcpUrl(): string {
  return `http://127.0.0.1:${process.env.PORT || 3001}/api/nub/mcp`;
}

/**
 * Points Hermes's `nub` MCP server at this Spark server. Best-effort: Nub
 * still works as a provider when the bridge is down or Hermes is absent.
 */
export async function registerNubMcp(auth: NubAuth): Promise<boolean> {
  try {
    await bridge.json(
      '/workspace/nub-mcp',
      { method: 'POST', body: JSON.stringify({ url: nubMcpUrl(), token: auth.mcpToken }) },
      { timeoutMs: 15_000 },
    );
    return true;
  } catch (err) {
    logger.warn(`[nub] could not register the nub MCP server with Hermes: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function unregisterNubMcp(): Promise<void> {
  await bridge
    .json('/workspace/nub-mcp', { method: 'DELETE' }, { timeoutMs: 15_000 })
    .catch((err: unknown) => logger.warn(`[nub] could not remove the nub MCP server: ${err instanceof Error ? err.message : String(err)}`));
}

/** On startup: re-point Hermes at this server (the port can change per launch). */
export async function syncNubMcpOnStartup(): Promise<void> {
  const auth = await loadNubAuth();
  if (auth) await registerNubMcp(auth);
}

function publicKey(key: MintedKey) {
  return {
    apiKey: key.rawKey,
    keyPrefix: key.keyPrefix,
    keyExpiresAt: key.expiresAt,
    models: key.models.map((model) => model.id),
  };
}

function errorStatus(err: unknown): number {
  if (err instanceof NubNotLinkedError) return 409;
  if (err instanceof NubApiError) return err.status >= 400 && err.status < 600 ? err.status : 502;
  return 502;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function bearerMatches(req: Request, expected: string): boolean {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return presented.length > 0 && timingSafeEqual(a, b);
}

export function registerNubRoutes(app: Express, makeClient: (origin?: string) => NubClient = (origin) => new NubClient(origin)) {
  app.post('/api/nub/auth/start', async (_req, res) => {
    try {
      const nonce = randomBytes(32).toString('hex');
      const start = await makeClient().startLink(createHash('sha256').update(nonce).digest('hex'));
      rememberLink(start.code, nonce);
      sendJson(res, 200, {
        code: start.code,
        telegramUrl: start.telegramUrl,
        pairingUrl: start.pairingUrl ?? null,
        expiresAt: start.expiresAt ?? null,
        pollInterval: Math.max(2, start.pollInterval ?? 2),
      });
    } catch (err) {
      sendJson(res, errorStatus(err), { error: errorMessage(err) });
    }
  });

  app.get('/api/nub/auth/poll', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const pending = pendingLinks.get(code);
    if (!pending) return sendJson(res, 404, { status: 'not_found' });
    try {
      const client = makeClient();
      const poll = await client.pollLink(code, pending.nonce);
      if (poll.status !== 'ready') {
        if (poll.status !== 'pending' && poll.status !== 'needs_subscription' && poll.status !== 'provisioning' && poll.status !== 'error') {
          pendingLinks.delete(code);
        }
        return sendJson(res, 200, poll);
      }
      pendingLinks.delete(code);

      const previous = await loadNubAuth();
      const auth: NubAuth = {
        origin: client.origin,
        desktopToken: poll.desktopToken,
        mcpToken: previous?.mcpToken ?? newMcpToken(),
        keyPrefix: null,
        keyExpiresAt: null,
        instance: poll.instance,
        linkedAt: Date.now(),
      };
      // Save before minting so a key failure can be retried via /api/nub/key.
      await saveNubAuth(auth);
      const key = await client.mintKey(auth.desktopToken);
      await saveNubAuth({ ...auth, keyPrefix: key.keyPrefix, keyExpiresAt: key.expiresAt });
      const mcpRegistered = await registerNubMcp(auth);
      sendJson(res, 200, { status: 'ready', instance: auth.instance, mcpRegistered, ...publicKey(key) });
    } catch (err) {
      sendJson(res, errorStatus(err), { status: 'error', error: errorMessage(err) });
    }
  });

  app.get('/api/nub/status', async (_req, res) => {
    const auth = await loadNubAuth();
    if (!auth) return sendJson(res, 200, { linked: false });
    let instance = auth.instance;
    let reachable = true;
    try {
      instance = (await makeClient(auth.origin).me(auth.desktopToken)).instance;
      if (JSON.stringify(instance) !== JSON.stringify(auth.instance)) await saveNubAuth({ ...auth, instance });
    } catch (err) {
      reachable = false;
      if (err instanceof NubApiError && err.status === 401) {
        return sendJson(res, 200, { linked: false, expired: true });
      }
    }
    sendJson(res, 200, {
      linked: true,
      reachable,
      origin: auth.origin,
      instance,
      keyPrefix: auth.keyPrefix,
      keyExpiresAt: auth.keyExpiresAt,
    });
  });

  app.post('/api/nub/key', async (_req, res) => {
    const auth = await loadNubAuth();
    if (!auth) return sendJson(res, 409, { error: new NubNotLinkedError().message });
    try {
      const key = await makeClient(auth.origin).mintKey(auth.desktopToken);
      await saveNubAuth({ ...auth, keyPrefix: key.keyPrefix, keyExpiresAt: key.expiresAt });
      sendJson(res, 200, publicKey(key));
    } catch (err) {
      sendJson(res, errorStatus(err), { error: errorMessage(err) });
    }
  });

  app.post('/api/nub/logout', async (_req, res) => {
    const auth = await loadNubAuth();
    if (!auth) return sendJson(res, 200, { ok: true, revoked: false });
    let revoked = true;
    try {
      await makeClient(auth.origin).revokeSession(auth.desktopToken);
    } catch (err) {
      revoked = false;
      logger.warn(`[nub] maiavm did not confirm the revoke: ${errorMessage(err)}`);
    }
    await clearNubAuth();
    await unregisterNubMcp();
    sendJson(res, 200, { ok: true, revoked });
  });

  app.post('/api/nub/ask', async (req, res) => {
    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    if (!message.trim()) return sendJson(res, 400, { error: 'message is required' });
    try {
      sendJson(res, 200, { reply: await askNubAgent(message) });
    } catch (err) {
      sendJson(res, errorStatus(err), { error: errorMessage(err) });
    }
  });

  // Streamable-HTTP MCP, JSON responses only. Hermes reaches it on loopback;
  // the bearer token keeps anything else that can reach this port (e.g. a
  // tailnet `tailscale serve`) from spending the user's nub agent.
  app.post('/api/nub/mcp', async (req, res) => {
    const auth = await loadNubAuth();
    if (!auth || !bearerMatches(req, auth.mcpToken)) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    const body: unknown = req.body;
    if (Array.isArray(body)) {
      const responses = (await Promise.all(body.map(handleNubMcpMessage))).filter(Boolean);
      return responses.length ? sendJson(res, 200, responses) : res.status(202).end();
    }
    const response = await handleNubMcpMessage(body);
    return response ? sendJson(res, 200, response) : res.status(202).end();
  });

  app.get('/api/nub/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').end();
  });

  app.delete('/api/nub/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').end();
  });
}

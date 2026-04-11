import type { Express, Request, Response } from 'express';
import { sendJson } from '../lib/helpers';

const HERMES_BRIDGE_URL = process.env.HERMES_BRIDGE_URL || 'http://localhost:3002';

async function proxyTo(
  res: Response,
  path: string,
  options?: RequestInit,
): Promise<void> {
  try {
    const response = await fetch(`${HERMES_BRIDGE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    let data: unknown = {};
    try {
      data = await response.json();
    } catch {
      // Non-JSON response
    }

    if (!response.ok) {
      const errorData = data as Record<string, unknown>;
      const error =
        typeof errorData.error === 'string' && errorData.error
          ? errorData.error
          : `Bridge returned ${response.status}`;
      return sendJson(res, response.status, { error });
    }

    return sendJson(res, response.status, data as Record<string, unknown>);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to reach hermes-bridge';
    console.error(`[hermes-admin] Proxy error for ${path}:`, message);
    return sendJson(res, 502, { error: message });
  }
}

export function registerHermesAdminRoute(app: Express) {
  const getQuerySuffix = (req: Request) => (
    req.originalUrl.includes('?')
      ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
      : ''
  );

  // ─── Cron Jobs ──────────────────────────────────────────────────────────

  app.get('/api/hermes/cron', async (req: Request, res: Response) => {
    await proxyTo(res, `/cron${getQuerySuffix(req)}`);
  });

  app.post('/api/hermes/cron', async (req: Request, res: Response) => {
    await proxyTo(res, '/cron', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
  });

  app.delete('/api/hermes/cron/:id', async (req: Request, res: Response) => {
    await proxyTo(res, `/cron/${encodeURIComponent(req.params.id)}`, {
      method: 'DELETE',
    });
  });

  app.post('/api/hermes/cron/:id/pause', async (req: Request, res: Response) => {
    await proxyTo(res, `/cron/${encodeURIComponent(req.params.id)}/pause`, {
      method: 'POST',
    });
  });

  app.post('/api/hermes/cron/:id/resume', async (req: Request, res: Response) => {
    await proxyTo(res, `/cron/${encodeURIComponent(req.params.id)}/resume`, {
      method: 'POST',
    });
  });

  app.post('/api/hermes/cron/:id/run', async (req: Request, res: Response) => {
    await proxyTo(res, `/cron/${encodeURIComponent(req.params.id)}/run`, {
      method: 'POST',
    });
  });

  app.get('/api/hermes/cron/:id/history', async (req: Request, res: Response) => {
    await proxyTo(res, `/cron/${encodeURIComponent(req.params.id)}/history`);
  });

  // ─── Sessions ───────────────────────────────────────────────────────────

  app.get('/api/hermes/sessions', async (_req: Request, res: Response) => {
    await proxyTo(res, '/sessions');
  });

  app.get('/api/hermes/sessions/:id', async (req: Request, res: Response) => {
    await proxyTo(res, `/sessions/${encodeURIComponent(req.params.id)}`);
  });

  app.delete('/api/hermes/sessions/:id', async (req: Request, res: Response) => {
    await proxyTo(res, `/sessions/${encodeURIComponent(req.params.id)}`, {
      method: 'DELETE',
    });
  });

  // ─── Hermes Workspace ───────────────────────────────────────────────────

  app.get('/api/hermes/workspace/overview', async (_req: Request, res: Response) => {
    await proxyTo(res, '/workspace/overview');
  });

  app.get('/api/hermes/workspace/usage', async (_req: Request, res: Response) => {
    await proxyTo(res, '/workspace/usage');
  });

  app.get('/api/hermes/workspace/files', async (_req: Request, res: Response) => {
    await proxyTo(res, '/workspace/files');
  });

  app.get('/api/hermes/workspace/files/:key', async (req: Request, res: Response) => {
    await proxyTo(res, `/workspace/files/${encodeURIComponent(req.params.key)}`);
  });

  app.put('/api/hermes/workspace/files/:key', async (req: Request, res: Response) => {
    await proxyTo(res, `/workspace/files/${encodeURIComponent(req.params.key)}`, {
      method: 'PUT',
      body: JSON.stringify(req.body),
    });
  });

  app.get('/api/hermes/workspace/skills', async (_req: Request, res: Response) => {
    await proxyTo(res, '/workspace/skills');
  });

  app.get('/api/hermes/workspace/skills/content', async (req: Request, res: Response) => {
    await proxyTo(res, `/workspace/skills/content${getQuerySuffix(req)}`);
  });
}

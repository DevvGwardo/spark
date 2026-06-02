import type { Express, Request, Response } from 'express';
import { sendJson } from '../lib/helpers';
import { logger } from '../lib/logger';
import {
  getBridgeStatus,
  startManagedBridge,
  installBridgeDeps,
} from '../lib/bridge-manager';

/**
 * Bridge management endpoints for the web/headless path (no Electron IPC).
 * Mirrors the subset of electron's bridge:* IPC that the setup UI needs, so
 * a browser can check status, install deps, and start the bridge.
 */
export function registerBridgeRoutes(app: Express) {
  app.get('/api/bridge/status', async (_req: Request, res: Response) => {
    try {
      sendJson(res, 200, await getBridgeStatus());
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'status failed' });
    }
  });

  app.post('/api/bridge/start', async (_req: Request, res: Response) => {
    try {
      sendJson(res, 200, await startManagedBridge());
    } catch (err) {
      sendJson(res, 500, { status: 'failed', message: err instanceof Error ? err.message : 'start failed' });
    }
  });

  app.post('/api/bridge/install-deps', async (_req: Request, res: Response) => {
    try {
      // pip output is logged server-side; the response carries the final result.
      const result = await installBridgeDeps((line) => logger.info('[bridge:install] ' + line));
      sendJson(res, result.ok ? 200 : 500, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, message: err instanceof Error ? err.message : 'install failed' });
    }
  });
}

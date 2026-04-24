import express from 'express';
import cors from 'cors';
import { registerChatStoreRoutes } from './chat-store';
import { registerChatRoute } from './routes/chat';
import { registerGitHubRoutes } from './routes/github';
import { registerValidateRoute } from './routes/validate';
import { registerProxyRoute } from './routes/proxy';
import { registerTranslateRoute } from './routes/translate';
import { registerHermesAdminRoute } from './routes/hermes-admin';
import { registerHermesRuntimesRoute } from './routes/hermes-runtimes';
import { registerHermesUpdateRoute } from './routes/hermes-update';
import { registerProfilesRoutes } from './routes/profiles';
import { registerTranscribeRoute } from './routes/transcribe';
import { sendJson } from './lib/helpers';
import { MAX_BODY_SIZE } from './config';
import { workspaceIndex } from './workspace-indexer';

import { registerHermesStreamResumeRoute } from './lib/hermes';

// Re-export for external consumers
export { shouldDirectProxyCompatibleProvider } from './lib/hermes';

export const HEALTH_ROUTES = [
  '/functions/v1/chat',
  '/functions/v1/chat-store/conversations',
  '/functions/v1/chat-store/messages',
  '/functions/v1/chat-store/conversations/:id/messages',
  '/functions/v1/chat-store/conversations/:id/files',
  '/functions/v1/github-integration',
  '/functions/v1/github-analyzer',
  '/functions/v1/validate-key',
  '/functions/v1/chat-proxy',
  '/functions/v1/translate',
  '/api/hermes/cron',
  '/api/hermes/sessions',
  '/api/hermes/workspace/overview',
  '/api/hermes/workspace/usage',
  '/api/hermes/workspace/files',
  '/api/hermes/workspace/skills',
  '/api/hermes/workspace/skills/hub',
  '/api/hermes/workspace/skills/hub/install',
  '/api/hermes/update/status',
  '/api/hermes/update',
  '/api/hermes/profiles',
  '/functions/v1/transcribe',
] as const;

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: MAX_BODY_SIZE }));
  registerChatStoreRoutes(app);

  registerChatRoute(app);
  registerGitHubRoutes(app);
  registerValidateRoute(app);
  registerProxyRoute(app);
  registerTranslateRoute(app);
  registerHermesAdminRoute(app);
  registerHermesRuntimesRoute(app);
  registerHermesUpdateRoute(app);
  registerProfilesRoutes(app);
  registerTranscribeRoute(app);
  registerHermesStreamResumeRoute(app);

  // ─── Workspace search ───────────────────────────────────────────────────────
  app.get('/functions/v1/workspace/search', async (req, res) => {
    try {
      const rootPath = req.query.path as string;
      const query = req.query.q as string;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

      if (!rootPath || !query) {
        return sendJson(res, 400, { error: 'Missing required query params: path, q' });
      }

      const entries = await workspaceIndex.scan(rootPath);
      const results = workspaceIndex.search(query, entries, limit);

      sendJson(res, 200, { results, total: entries.length, cached: true });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
  });

  // ─── Health check ──────────────────────────────────────────────────────────
  app.get('/functions/v1/health', (_req, res) => {
    sendJson(res, 200, { ok: true, routes: HEALTH_ROUTES });
  });

  // ─── 404 catch-all (debug unmatched routes) ─────────────────────────────────
  app.use((req, res) => {
    console.warn(`[server] 404 Not Found: ${req.method} ${req.originalUrl}`);
    sendJson(res, 404, { error: `Route not found: ${req.method} ${req.originalUrl}` });
  });

  return app;
}

// ─── Start server ────────────────────────────────────────────────────────────

export function startServer(port?: number) {
  const resolvedPort = Number(port || process.env.PORT || 3001);

  if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
    console.error(`[server] Invalid port: ${resolvedPort}. Must be an integer between 1 and 65535.`);
    process.exit(1);
  }

  const app = createApp();
  return new Promise<{ app: typeof app; port: number }>((resolve, reject) => {
    const server = app.listen(resolvedPort, () => {
      console.log(`Local API server running on http://localhost:${resolvedPort}`);
      console.log('Routes:');
      console.log('  POST /functions/v1/chat');
      console.log('  POST /functions/v1/github-integration');
      console.log('  POST /functions/v1/github-analyzer');
      console.log('  POST /functions/v1/validate-key');
      console.log('  POST /functions/v1/chat-proxy');
      resolve({ app, port: resolvedPort });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[server] Port ${resolvedPort} is already in use.`);
      } else {
        console.error(`[server] Failed to start: ${err.message}`);
      }
      reject(err);
    });
  });
}

// Auto-start when run directly (npm run server), not when imported by Electron
const isElectron = typeof process !== 'undefined' && !!process.versions?.electron;
if (!isElectron) {
  const isEntry = process.argv[1] && import.meta.url.includes(process.argv[1].replace(/\\/g, '/'));
  if (isEntry) {
    startServer();
  }
}

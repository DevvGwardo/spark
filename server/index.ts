import express from 'express';
import cors from 'cors';
import { registerChatStoreRoutes } from './chat-store';
import { registerChatRoute } from './routes/chat';
import { registerGitHubRoutes } from './routes/github';
import { registerValidateRoute } from './routes/validate';
import { registerProxyRoute } from './routes/proxy';
import { registerTranslateRoute } from './routes/translate';
import { sendJson } from './lib/helpers';

// Re-export for external consumers
export { shouldDirectProxyCompatibleProvider } from './lib/hermes';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  registerChatStoreRoutes(app);

  registerChatRoute(app);
  registerGitHubRoutes(app);
  registerValidateRoute(app);
  registerProxyRoute(app);
  registerTranslateRoute(app);

  // ─── Health check ──────────────────────────────────────────────────────────
  app.get('/functions/v1/health', (_req, res) => {
    sendJson(res, 200, { ok: true, routes: ['/functions/v1/chat', '/functions/v1/github-integration', '/functions/v1/github-analyzer', '/functions/v1/validate-key', '/functions/v1/chat-proxy', '/functions/v1/translate'] });
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
  const resolvedPort = port || process.env.PORT || 3001;
  const app = createApp();
  return new Promise<{ app: typeof app; port: number }>((resolve) => {
    app.listen(resolvedPort, () => {
      console.log(`Local API server running on http://localhost:${resolvedPort}`);
      console.log('Routes:');
      console.log('  POST /functions/v1/chat');
      console.log('  POST /functions/v1/github-integration');
      console.log('  POST /functions/v1/github-analyzer');
      console.log('  POST /functions/v1/validate-key');
      console.log('  POST /functions/v1/chat-proxy');
      resolve({ app, port: Number(resolvedPort) });
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

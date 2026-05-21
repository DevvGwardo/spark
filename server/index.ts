import express from 'express';
import cors from 'cors';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
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
import { registerKanbanRoutes } from './routes/kanban';
import { registerOrchestratorRoutes } from './routes/orchestrator';
import { registerTranscribeRoute } from './routes/transcribe';
import { registerRoomRoutes } from './routes/rooms';
import { sendJson } from './lib/helpers';
import { MAX_BODY_SIZE } from './config';
import { workspaceIndex } from './workspace-indexer';

import { registerHermesStreamResumeRoute } from './lib/hermes';
import { registerRemoteRevivalRoutes } from './routes/remote-revival';
import { taskOrchestrator } from './task-orchestrator';
import { getLanIp, generateTerminalQr, generateQrSvgDataUri, formatConnectionInfo } from './lib/qr-display';
import { startTunnel, killTunnel, getTunnelState, cloudflaredAvailable, brewAvailable, installCloudflared } from './lib/tunnel';

const __serverFilename = fileURLToPath(import.meta.url);
const __serverDirname = dirname(__serverFilename);
const PROJECT_ROOT = join(__serverDirname, '..');

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
  '/api/hermes/runtimes',
  '/api/hermes/chat/start',
  '/api/hermes/chat/stream',
  '/api/hermes/update/status',
  '/api/hermes/update',
  '/api/hermes/profiles',
  '/api/hermes/kanban',
  '/api/hermes/orchestrator/status',
  '/api/hermes/orchestrator/start',
  '/api/hermes/orchestrator/stop',
  '/api/hermes/orchestrator/dispatch-now',
  '/api/hermes/orchestrator/cancel/:cardId',
  '/api/hermes/orchestrator/card-complete',
  '/api/remote/hermes-status',
  '/api/remote/wake',
  '/api/remote/ping-bridge',
  '/api/remote/smart-plug',
  '/functions/v1/transcribe',
] as const;

export function createApp(opts?: { serveFrontend?: boolean }) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: MAX_BODY_SIZE }));

  // ─── Production: serve the built frontend ─────────────────────────────────
  const distPath = join(PROJECT_ROOT, 'dist');
  if (opts?.serveFrontend) {
    if (existsSync(distPath)) {
      console.log(`[server] Serving frontend from ${distPath}`);
      app.use(express.static(distPath));
    } else {
      console.warn(`[server] dist/ not found at ${distPath} — frontend not available`);
    }
  }

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
  registerKanbanRoutes(app);
  registerOrchestratorRoutes(app);
  registerTranscribeRoute(app);
  registerHermesStreamResumeRoute(app);
  registerRoomRoutes(app);
  registerRemoteRevivalRoutes(app);

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

  // ─── Remote access QR page ─────────────────────────────────────────────────
  if (opts?.serveFrontend) {
    // JSON endpoint for the frontend component
    app.get('/api/remote/info', async (_req, res) => {
      const ip = getLanIp();
      const port = Number(process.env.PORT || 3001);
      const { lanUrl, localUrl } = formatConnectionInfo(ip, port);
      const tunnelState = getTunnelState();
      // Use tunnel URL if available (works from anywhere), otherwise LAN URL
      const url = tunnelState.running && tunnelState.url ? tunnelState.url : (ip ? lanUrl : localUrl);
      const qrSvg = await generateQrSvgDataUri(url);
      sendJson(res, 200, { url, lanUrl, localUrl, qrSvg, tunnelUrl: tunnelState.url });
    });

    // Tunnel management endpoints
    app.get('/api/remote/tunnel/status', (_req, res) => {
      const t = getTunnelState();
      sendJson(res, 200, {
        running: t.running,
        url: t.url,
        provider: t.provider,
        error: t.error,
        cloudflaredAvailable: cloudflaredAvailable(),
        brewAvailable: brewAvailable(),
      });
    });

    app.post('/api/remote/tunnel/start', async (_req, res) => {
      const port = Number(process.env.PORT || 3001);
      // If already running, return current state
      const current = getTunnelState();
      if (current.running) {
        sendJson(res, 200, current);
        return;
      }
      // Try to start
      const result = await startTunnel(port);
      sendJson(res, result.running ? 200 : 500, result);
    });

    app.post('/api/remote/tunnel/stop', (_req, res) => {
      killTunnel();
      sendJson(res, 200, { running: false });
    });

    app.post('/api/remote/tunnel/install', async (_req, res) => {
      if (cloudflaredAvailable()) {
        sendJson(res, 200, { ok: true, message: 'cloudflared is already installed.' });
        return;
      }
      const result = await installCloudflared();
      sendJson(res, result.ok ? 200 : 500, result);
    });

    app.get('/remote', async (_req, res) => {
      const ip = getLanIp();
      const port = Number(process.env.PORT || 3001);
      const { lanUrl, localUrl } = formatConnectionInfo(ip, port);
      const url = ip ? lanUrl : localUrl;
      const qrSvg = await generateQrSvgDataUri(url);

      res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CloudChat — Remote Access</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100dvh; padding: 2rem;
    }
    .card {
      background: #141414;
      border: 1px solid #252525;
      border-radius: 20px;
      padding: 2.5rem;
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
    p { font-size: 0.8rem; color: #888; margin-bottom: 1.5rem; line-height: 1.5; }
    .qr-wrap {
      background: #fff;
      border-radius: 16px;
      padding: 1rem;
      margin-bottom: 1.5rem;
      display: inline-block;
    }
    .qr-wrap img { display: block; width: 220px; height: 220px; }
    .url {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 0.75rem 1rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.8rem;
      color: #a78bfa;
      word-break: break-all;
      user-select: all;
    }
    .url-label { font-size: 0.7rem; color: #555; margin-top: 0.75rem; }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 1.25rem;
      background: #8b5cf6;
      color: #fff;
      border: none;
      border-radius: 12px;
      padding: 0.75rem 1.5rem;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
    }
    .btn:hover { background: #7c3aed; }
    .steps { text-align: left; margin-top: 1.5rem; }
    .steps li {
      font-size: 0.75rem;
      color: #888;
      line-height: 1.6;
      margin-bottom: 0.25rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>📱 CloudChat Remote</h1>
    <p>Scan the QR code with your phone camera<br>to open CloudChat on your mobile device</p>
    <div class="qr-wrap"><img src="${qrSvg}" alt="QR Code"></div>
    <div class="url">${url}</div>
    <div class="url-label">Same Wi-Fi network required</div>
    <a class="btn" href="/">Open CloudChat →</a>
    <ol class="steps">
      <li>1. Connect your phone to the same Wi-Fi as this computer</li>
      <li>2. Open your camera app and point at the QR code</li>
      <li>3. Tap the notification to open CloudChat</li>
    </ol>
  </div>
</body>
</html>`);
    });
  }

  // ─── SPA fallback for client-routed paths ────────────────────────────────────
  if (opts?.serveFrontend) {
    const indexHtml = join(distPath, 'index.html');
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      if (!req.accepts('html')) return next();
      if (existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        next();
      }
    });
  }

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

  const serveFrontend = process.env.SERVE_FRONTEND === 'true';
  const app = createApp({ serveFrontend });
  return new Promise<{ app: typeof app; port: number }>((resolve, reject) => {
    const server = app.listen(resolvedPort, async () => {
      console.log(`Local API server running on http://localhost:${resolvedPort}`);
      console.log('Routes:');
      console.log('  POST /functions/v1/chat');
      console.log('  POST /functions/v1/github-integration');
      console.log('  POST /functions/v1/github-analyzer');
      console.log('  POST /functions/v1/validate-key');
      console.log('  POST /functions/v1/chat-proxy');

      // ─── Terminal QR code for mobile access ─────────────────────────────
      if (serveFrontend) {
        const ip = getLanIp();
        const { lanUrl, localUrl } = formatConnectionInfo(ip, resolvedPort);
        const url = ip ? lanUrl : localUrl;

        console.log('');
        console.log('━━━ 📱 Mobile Access ━━━');
        console.log('');
        console.log(`  Local:  ${localUrl}`);
        if (ip) {
          console.log(`  LAN:    ${lanUrl}`);
          console.log(`  QR:     ${lanUrl}/remote`);
          console.log('');
          try {
            const qr = await generateTerminalQr(lanUrl);
            console.log(qr);
          } catch {
            console.log('  [QR generation skipped]');
          }
          console.log('');
          console.log('  Open /remote on this server from any browser to see the QR page.');
          console.log('  Or scan the code above with your phone camera.');
        } else {
          console.log('  (No LAN IP detected — connect to Wi-Fi for mobile access)');
        }
        console.log('━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
      }
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

// ─── Auto-start when run directly (npm run server)
const isEntry = process.argv[1] && import.meta.url.includes(process.argv[1].replace(/\\/g, '/'));
if (isEntry) {
  startServer();

  // Start orchestrator on standalone server boot (configurable via env)
  if (process.env.KANBAN_AUTO_START !== 'false') {
    taskOrchestrator.start();
  }
}

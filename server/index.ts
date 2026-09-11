import express, { type Request } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { timingSafeEqual } from 'crypto';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { registerChatStoreRoutes } from './chat-store';
import { registerCronArchiveRoutes } from './cron-archive-store';
import { registerChatRoute } from './routes/chat';
import { registerGitHubRoutes } from './routes/github';
import { registerValidateRoute } from './routes/validate';
import { registerProxyRoute } from './routes/proxy';
import { registerTranslateRoute } from './routes/translate';
import { registerHermesAdminRoute, warnIfBridgeMisconfigured } from './routes/hermes-admin';
import { registerHermesRuntimesRoute } from './routes/hermes-runtimes';
import { registerHermesUpdateRoute } from './routes/hermes-update';
import { registerProfilesRoutes } from './routes/profiles';
import { registerKanbanRoutes } from './routes/kanban';
import { registerOrchestratorRoutes } from './routes/orchestrator';
import { registerTeamRoutes } from './routes/team';
import { registerTranscribeRoute } from './routes/transcribe';
import { registerImagesRoute } from './routes/images';
import { registerRoomRoutes } from './routes/rooms';
import { sendJson, csrfProtection, ALLOWED_ORIGINS } from './lib/helpers';
import { logger, requestIdMiddleware } from './lib/logger';
import { MAX_BODY_SIZE } from './config';

import { registerHermesStreamResumeRoute } from './lib/hermes';
import { registerRemoteRevivalRoutes } from './routes/remote-revival';
import { registerBridgeRoutes } from './routes/bridge';
import { registerWorkspaceRoutes } from './routes/workspace';
import { registerFactoryRoutes } from './routes/factory';
import { registerMcpWorkersRoute } from './routes/mcp-workers.route';
import { registerMcpExtensionsRoute } from './routes/mcp-extensions.route';
import { startManagedBridge, stopManagedBridge } from './lib/bridge-manager';
import { taskOrchestrator } from './task-orchestrator';
import { shutdownTeamCoordinator } from './team-coordinator';
import { getLanIp, generateTerminalQr, generateQrSvgDataUri, formatConnectionInfo } from './lib/qr-display';
import { startTunnel, killTunnel, getTunnelState, cloudflaredAvailable, brewAvailable, installCloudflared } from './lib/tunnel';

const __serverFilename = fileURLToPath(import.meta.url);
const __serverDirname = dirname(__serverFilename);
const PROJECT_ROOT = join(__serverDirname, '..');

// Re-export for external consumers
export { shouldDirectProxyCompatibleProvider } from './lib/hermes';

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackAddress(normalized.slice('::ffff:'.length));
  }
  return normalized === '127.0.0.1' || normalized.startsWith('127.');
}

function isLoopbackRequest(req: Request): boolean {
  return isLoopbackAddress(req.socket.remoteAddress);
}

/**
 * Constant-time comparison for the tunnel access token so the ?key= /
 * cookie checks don't leak timing information about the token.
 */
function tokensEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export const HEALTH_ROUTES = [
  '/functions/v1/chat',
  '/functions/v1/chat-store/conversations',
  '/functions/v1/chat-store/messages',
  '/functions/v1/chat-store/conversations/:id/messages',
  '/functions/v1/chat-store/conversations/:id/files',
  '/functions/v1/workspace/read',
  '/functions/v1/workspace/diff',
  '/functions/v1/workspace/list',
  '/functions/v1/fetch-url',
  '/functions/v1/github-integration',
  '/functions/v1/github-analyzer',
  '/functions/v1/validate-key',
  '/functions/v1/chat-proxy',
  '/functions/v1/translate',
  '/api/hermes/cron',
  '/api/hermes/sessions',
  '/api/hermes/workspace/overview',
  '/api/hermes/workspace/usage',
  '/api/hermes/workspace/logs',
  '/api/hermes/workspace/system',
  '/api/hermes/webhooks',
  '/api/hermes/pairing',
  '/api/hermes/workspace/files',
  '/api/hermes/workspace/skills',
  '/api/hermes/workspace/skills/hub',
  '/api/hermes/workspace/skills/hub/install',
  '/api/hermes/runtimes',
  '/api/hermes/chat/start',
  '/api/hermes/chat/stream',
  '/api/hermes/chat/cancel',
  '/api/hermes/update/status',
  '/api/hermes/update/progress',
  '/api/hermes/update',
  '/api/hermes/profiles',
  '/api/hermes/kanban',
  '/api/hermes/orchestrator/status',
  '/api/hermes/orchestrator/start',
  '/api/hermes/orchestrator/stop',
  '/api/hermes/orchestrator/dispatch-now',
  '/api/hermes/orchestrator/cancel/:cardId',
  '/api/hermes/orchestrator/card-complete',
  '/api/hermes/team/create',
  '/api/hermes/team/active',
  '/api/hermes/team/delegation',
  '/api/hermes/team/:id',
  '/api/hermes/team/:id/dispatch',
  '/api/hermes/team/:id/pause',
  '/api/hermes/team/:id/resume',
  '/api/hermes/team/:id/reassign',
  '/api/hermes/team/:id/context',
  '/api/hermes/team/:id/blocked',
  '/api/hermes/team/delegation/:id',
  '/api/hermes/team/synthesize/:id',
  '/api/hermes/team/complexity-check',
  '/api/remote/hermes-status',
  '/api/remote/wake',
  '/api/remote/ping-bridge',
  '/api/remote/smart-plug',
  '/functions/v1/transcribe',
  '/api/factory/status',
  '/api/factory/dispatch',
  '/api/factory/queue',
  '/api/factory/kanban/sync',
] as const;

export function createApp(opts?: { serveFrontend?: boolean }) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  // Gzip responses (JS bundles, JSON) — big win on LAN/tunnel mobile access.
  // Streaming responses (SSE and the AI data stream) must NOT be compressed:
  // gzip buffers output and would break incremental token delivery.
  app.use(compression({ filter: (req, res) => {
    if ((res.getHeader('Content-Type') || '').toString().includes('text/event-stream')) return false;
    if (res.getHeader('x-vercel-ai-data-stream')) return false;
    return compression.filter(req, res);
  } }));
  // Origin-aware CORS. Never reflect arbitrary origins: unauthenticated GET
  // endpoints (e.g. profile .env, chat-store conversations) must stay unreadable
  // cross-origin. Only allowlist dev-server origins plus loopback hosts (LAN
  // phone access). Requests without an Origin header (same-origin, curl,
  // Electron file://) are unaffected — no ACAO header is emitted.
  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, false);
      if (ALLOWED_ORIGINS.has(origin)) return callback(null, true);
      try {
        const host = new URL(origin).hostname;
        const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
        return callback(null, isLoopback);
      } catch {
        return callback(null, false);
      }
    },
  }));
  app.use(requestIdMiddleware);
  app.use(csrfProtection);

  // ─── Public-tunnel access gate ─────────────────────────────────────────────
  // Tunnel traffic terminates at the local cloudflared/localtunnel process, so
  // it arrives from 127.0.0.1. Some providers rewrite Host to the local origin
  // and preserve the public hostname in X-Forwarded-Host; trust that forwarded
  // host only for loopback proxy traffic. While a tunnel is running, any request
  // addressed to the tunnel hostname must present the per-tunnel token (?key=…
  // on first visit, cookie afterwards). Local and LAN access is unaffected.
  const REMOTE_KEY_COOKIE = 'spark_remote_key';
  app.use((req, res, next) => {
    const tunnel = getTunnelState();
    if (!tunnel.running || !tunnel.url || !tunnel.accessToken) return next();

    const tunnelHost = new URL(tunnel.url).host.toLowerCase();
    const requestHost = (req.headers.host || '').toLowerCase();
    const forwardedHost = (req.headers['x-forwarded-host'] as string | undefined)
      ?.split(',')[0]
      ?.trim()
      ?.toLowerCase();
    const isTunnelRequest =
      requestHost === tunnelHost ||
      (isLoopbackRequest(req) && forwardedHost === tunnelHost);
    if (!isTunnelRequest) return next();

    const cookies = req.headers.cookie || '';
    const cookieMatch = cookies.match(new RegExp(`(?:^|;\\s*)${REMOTE_KEY_COOKIE}=([^;]+)`));
    if (cookieMatch?.[1] && tokensEqual(cookieMatch[1], tunnel.accessToken)) return next();

    const queryKey = typeof req.query.key === 'string' ? req.query.key : null;
    if (queryKey && tokensEqual(queryKey, tunnel.accessToken)) {
      res.setHeader(
        'Set-Cookie',
        `${REMOTE_KEY_COOKIE}=${tunnel.accessToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
      );
      return next();
    }

    // req.path (not req.originalUrl) — the token arrives as ?key= and must
    // not leak into logs.
    logger.warn(`[server] blocked unauthenticated tunnel request: ${req.method} ${req.path}`);
    res.status(401);
    if (req.accepts('html') && !req.path.startsWith('/api/')) {
      res
        .type('html')
        .send('<!doctype html><html><body style="background:#0a0a0a;color:#e0e0e0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100dvh"><div style="text-align:center"><h1 style="font-size:1.1rem">🔒 Spark Remote</h1><p style="color:#888;font-size:.85rem">This link requires an access key.<br>Scan the QR code from the Spark desktop app to connect.</p></div></body></html>');
    } else {
      sendJson(res, 401, { error: 'Remote access key required' });
    }
  });

  app.use(express.json({ limit: MAX_BODY_SIZE }));

  // ─── Production: serve the built frontend ─────────────────────────────────
  // FRONTEND_DIST_DIR lets the Electron app point at its packaged renderer
  // (out/renderer) so remote devices can load the full UI over HTTP. The web
  // `npm run serve` flow leaves it unset and falls back to dist/.
  const compiledFrontendDir = join(__serverDirname, '..');
  const distPath =
    process.env.FRONTEND_DIST_DIR ||
    (existsSync(join(compiledFrontendDir, 'index.html'))
      ? compiledFrontendDir
      : join(PROJECT_ROOT, 'dist'));
  if (opts?.serveFrontend) {
    if (existsSync(distPath)) {
      logger.info(`[server] Serving frontend from ${distPath}`);
      app.use(express.static(distPath));
    } else {
      logger.warn(`[server] dist/ not found at ${distPath} — frontend not available`);
    }
  }

  registerChatStoreRoutes(app);
  registerCronArchiveRoutes(app);

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
  registerTeamRoutes(app);
  registerTranscribeRoute(app);
  registerImagesRoute(app);
  registerHermesStreamResumeRoute(app);
  registerRoomRoutes(app);
  registerRemoteRevivalRoutes(app);
  registerBridgeRoutes(app);
  registerWorkspaceRoutes(app);
  registerFactoryRoutes(app);
  registerMcpWorkersRoute(app);
  registerMcpExtensionsRoute(app);

  // Workspace search lives in registerWorkspaceRoutes (hardened root checks).
  // ─── Health check ──────────────────────────────────────────────────────────
  app.get('/functions/v1/health', (_req, res) => {
    sendJson(res, 200, { ok: true, routes: HEALTH_ROUTES });
  });

  // ─── Remote access QR page ─────────────────────────────────────────────────
  if (opts?.serveFrontend) {
    // Tunnel URLs shown to the user (and baked into the QR) carry the access
    // key so scanning the code authenticates the phone in one step.
    const keyedTunnelUrl = (t: ReturnType<typeof getTunnelState>) =>
      t.url && t.accessToken ? `${t.url}/?key=${t.accessToken}` : t.url;
    const publicTunnelUrl = (t: ReturnType<typeof getTunnelState>, req: Request) =>
      isLoopbackRequest(req) ? keyedTunnelUrl(t) : t.url;

    // JSON endpoint for the frontend component
    app.get('/api/remote/info', async (req, res) => {
      try {
        const ip = getLanIp();
        const port = Number(process.env.PORT || 3001);
        const { lanUrl, localUrl } = formatConnectionInfo(ip, port);
        const tunnelState = getTunnelState();
        const tunnelUrl = publicTunnelUrl(tunnelState, req);
        // Use tunnel URL if available (works from anywhere), otherwise LAN URL
        const url = tunnelState.running && tunnelState.url
          ? tunnelUrl!
          : (ip ? lanUrl : localUrl);
        const qrSvg = await generateQrSvgDataUri(url);
        sendJson(res, 200, { url, lanUrl, localUrl, qrSvg, tunnelUrl });
      } catch (err) {
        logger.error(`[server] /api/remote/info failed: ${err instanceof Error ? err.message : String(err)}`);
        sendJson(res, 500, { error: 'Internal server error' });
      }
    });

    // Tunnel management endpoints
    app.get('/api/remote/tunnel/status', (req, res) => {
      const t = getTunnelState();
      sendJson(res, 200, {
        running: t.running,
        url: publicTunnelUrl(t, req),
        provider: t.provider,
        error: t.error,
        cloudflaredAvailable: cloudflaredAvailable(),
        brewAvailable: brewAvailable(),
      });
    });

    app.post('/api/remote/tunnel/start', async (req, res) => {
      const port = Number(process.env.PORT || 3001);
      // If already running, return current state
      const current = getTunnelState();
      if (current.running) {
        sendJson(res, 200, { ...current, url: publicTunnelUrl(current, req), accessToken: undefined });
        return;
      }
      // Try to start
      const result = await startTunnel(port);
      sendJson(res, result.running ? 200 : 500, { ...result, url: publicTunnelUrl(result, req), accessToken: undefined });
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
      try {
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
  <title>Spark — Remote Access</title>
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
    <h1>📱 Spark Remote</h1>
    <p>Scan the QR code with your phone camera<br>to open Spark on your mobile device</p>
    <div class="qr-wrap"><img src="${qrSvg}" alt="QR Code"></div>
    <div class="url">${url}</div>
    <div class="url-label">Same Wi-Fi network required</div>
    <a class="btn" href="/">Open Spark →</a>
    <ol class="steps">
      <li>1. Connect your phone to the same Wi-Fi as this computer</li>
      <li>2. Open your camera app and point at the QR code</li>
      <li>3. Tap the notification to open Spark</li>
    </ol>
  </div>
</body>
</html>`);
      } catch (err) {
        logger.error(`[server] /remote failed: ${err instanceof Error ? err.message : String(err)}`);
        sendJson(res, 500, { error: 'Internal server error' });
      }
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
  // req.path, not req.originalUrl — query strings (e.g. a tunnel ?key=)
  // must not leak into logs or responses.
  app.use((req, res) => {
    logger.warn(`[server] 404 Not Found: ${req.method} ${req.path}`);
    sendJson(res, 404, { error: `Route not found: ${req.method} ${req.path}` });
  });

  // ─── Global error handler ───────────────────────────────────────────────────
  // Express 4 does not forward rejected promises from async handlers, but sync
  // throws and next(err) land here instead of crashing the process.
  app.use((err: unknown, req: Request, res: express.Response, _next: express.NextFunction) => {
    logger.error(
      `[server] Unhandled error on ${req.method} ${req.path}: ${err instanceof Error ? err.stack || err.message : String(err)}`,
    );
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, 500, { error: 'Internal server error' });
  });

  return app;
}

// ─── Start server ────────────────────────────────────────────────────────────

export function startServer(port?: number) {
  const resolvedPort = Number(port || process.env.PORT || 3001);

  if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
    logger.error(`[server] Invalid port: ${resolvedPort}. Must be an integer between 1 and 65535.`);
    process.exit(1);
  }

  // Advertise the port we actually bound to (Electron picks a free one
  // dynamically) so the remote-access QR / tunnel point at the real server.
  process.env.PORT = String(resolvedPort);

  const serveFrontend = process.env.SERVE_FRONTEND === 'true';
  const app = createApp({ serveFrontend });
  return new Promise<{ app: typeof app; port: number }>((resolve, reject) => {
    const server = app.listen(resolvedPort, async () => {
      logger.info(`Local API server running on http://localhost:${resolvedPort}`);
      logger.info('Routes:');
      logger.info('  POST /functions/v1/chat');
      logger.info('  POST /functions/v1/github-integration');
      logger.info('  POST /functions/v1/github-analyzer');
      logger.info('  POST /functions/v1/validate-key');
      logger.info('  POST /functions/v1/chat-proxy');

      // Surface a mispointed HERMES_BRIDGE_URL (gateway vs full bridge) early.
      warnIfBridgeMisconfigured();

      // ─── Terminal QR code for mobile access ─────────────────────────────
      if (serveFrontend) {
        const ip = getLanIp();
        const { lanUrl, localUrl } = formatConnectionInfo(ip, resolvedPort);

        logger.info('');
        logger.info('━━━ 📱 Mobile Access ━━━');
        logger.info('');
        logger.info(`  Local:  ${localUrl}`);
        if (ip) {
          logger.info(`  LAN:    ${lanUrl}`);
          logger.info(`  QR:     ${lanUrl}/remote`);
          logger.info('');
          try {
            const qr = await generateTerminalQr(lanUrl);
            logger.info(qr);
          } catch {
            logger.info('  [QR generation skipped]');
          }
          logger.info('');
          logger.info('  Open /remote on this server from any browser to see the QR page.');
          logger.info('  Or scan the code above with your phone camera.');
        } else {
          logger.info('  (No LAN IP detected — connect to Wi-Fi for mobile access)');
        }
        logger.info('━━━━━━━━━━━━━━━━━━━━━');
        logger.info('');
      }
      resolve({ app, port: resolvedPort });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(`[server] Port ${resolvedPort} is already in use.`);
      } else {
        logger.error(`[server] Failed to start: ${err.message}`);
      }
      reject(err);
    });
  });
}

// ─── Auto-start when run directly (npm run server) ─────────────────────────
// Never auto-start inside Electron (dev or packaged): the main process starts
// the embedded server itself via startEmbeddedServerOnce(). The old argv[1]
// check matched Electron dev (argv[1] = '.') and spawned a second Express
// instance squatting :3001 — two servers sharing the same SQLite files, plus a
// port clash with any unrelated service that wants :3001.
const isEntry = !process.versions.electron &&
  !!process.argv[1] &&
  import.meta.url.includes(process.argv[1].replace(/\\/g, '/'));
if (isEntry) {
  startServer();

  // Start orchestrator on standalone server boot (configurable via env)
  if (process.env.KANBAN_AUTO_START !== 'false') {
    taskOrchestrator.start();
  }

  // Auto-start & supervise the Hermes bridge for headless/serve deployments
  // (MANAGE_BRIDGE=true). The Electron app manages its own bridge instead.
  if (process.env.MANAGE_BRIDGE === 'true') {
    startManagedBridge().catch((err) => {
      logger.warn(`[server] managed bridge start failed: ${err instanceof Error ? err.message : err}`);
    });
  }
  const shutdown = () => {
    // Kill the public tunnel first: while it lives, its process still accepts
    // connections, so the access-token gate must stay armed until it's dead.
    killTunnel();
    // Stop team-agent subprocesses so a `npm run server` exit doesn't orphan
    // run-kanban-agent.py children.
    shutdownTeamCoordinator();
    if (process.env.MANAGE_BRIDGE === 'true') {
      stopManagedBridge();
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

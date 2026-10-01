import express, { type Request } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { registerChatStoreRoutes } from './chat-store';
import { registerCronArchiveRoutes } from './cron-archive-store';
import { registerChatRoute } from './routes/chat';
import { registerGitHubRoutes } from './routes/github';
import { registerValidateRoute } from './routes/validate';
import { registerProxyRoute } from './routes/proxy';
import { registerTranslateRoute } from './routes/translate';
import { registerCompactRoute } from './routes/compact';
import { registerHermesAdminRoute, warnIfBridgeMisconfigured } from './routes/hermes-admin';
import { registerHermesRuntimesRoute } from './routes/hermes-runtimes';
import { registerHermesUpdateRoute } from './routes/hermes-update';
import { registerProfilesRoutes } from './routes/profiles';
import { registerKanbanRoutes } from './routes/kanban';
import { registerOrchestratorRoutes } from './routes/orchestrator';
import { registerRalphRoutes } from './routes/ralph';
import { registerTeamRoutes } from './routes/team';
import { registerTranscribeRoute } from './routes/transcribe';
import { registerImagesRoute } from './routes/images';
import { registerRoomRoutes } from './routes/rooms';
import { sendJson, csrfProtection, ALLOWED_ORIGINS } from './lib/helpers';
import { logger, requestIdMiddleware } from './lib/logger';
import { MAX_BODY_SIZE } from './config';

import { registerHermesStreamResumeRoute } from './lib/hermes';
import { registerBridgeRoutes } from './routes/bridge';
import { registerWorkspaceRoutes } from './routes/workspace';
import { registerFactoryRoutes } from './routes/factory';
import { registerMcpWorkersRoute } from './routes/mcp-workers.route';
import { registerMcpExtensionsRoute } from './routes/mcp-extensions.route';
import { registerRemoteStatusRoutes } from './routes/remote-status';
import { startManagedBridge, stopManagedBridge } from './lib/bridge-manager';
import { taskOrchestrator } from './task-orchestrator';
import { shutdownTeamCoordinator } from './team-coordinator';
import { generateTerminalQr, generateQrSvgDataUri } from './lib/qr-display';
import { getTailscaleStatus, getTailscaleServeInfo, buildServeCommand } from './lib/tailscale';

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
  '/api/remote/info',
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
    if (res.getHeader('x-vercel-ai-ui-message-stream')) return false;
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
      app.use(
        express.static(distPath, {
          setHeaders: (res, path) => {
            if (path.includes('/assets/')) {
              // Vite hashes these files, so they are safe to cache forever.
              res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            } else {
              // HTML files and unhashed root assets should not be cached to ensure updates propagate.
              res.setHeader('Cache-Control', 'no-cache');
            }
          },
        }),
      );
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
  registerCompactRoute(app);
  registerHermesAdminRoute(app);
  registerHermesRuntimesRoute(app);
  registerHermesUpdateRoute(app);
  registerProfilesRoutes(app);
  registerKanbanRoutes(app);
  registerOrchestratorRoutes(app);
  registerRalphRoutes(app);
  registerTeamRoutes(app);
  registerTranscribeRoute(app);
  registerImagesRoute(app);
  registerHermesStreamResumeRoute(app);
  registerRoomRoutes(app);
  registerBridgeRoutes(app);
  registerWorkspaceRoutes(app);
  registerFactoryRoutes(app);
  registerMcpWorkersRoute(app);
  registerMcpExtensionsRoute(app);
  registerRemoteStatusRoutes(app);

  // Workspace search lives in registerWorkspaceRoutes (hardened root checks).
  // ─── Health check ──────────────────────────────────────────────────────────
  app.get('/functions/v1/health', (_req, res) => {
    sendJson(res, 200, { ok: true, routes: HEALTH_ROUTES });
  });

  // ─── Remote access (Tailscale) ─────────────────────────────────────────────
  // Spark is reachable from the user's own tailnet, never the public internet.
  // This only *detects* Tailscale — running `tailscale serve` is the user's
  // call to make, so we report state and hand back a copy-paste command.
  if (opts?.serveFrontend) {
    const remotePort = Number(process.env.PORT || 3001);

    // JSON endpoint for the frontend component
    app.get('/api/remote/info', async (_req, res) => {
      try {
        const [status, serve] = await Promise.all([
          getTailscaleStatus(),
          getTailscaleServeInfo(remotePort),
        ]);
        const localUrl = `http://localhost:${remotePort}`;
        // Only advertise a tailnet URL that is actually wired up.
        const url = serve.configured && serve.url ? serve.url : localUrl;
        // Only encode a QR a phone can actually resolve — a localhost URL would
        // scan into a dead link. The UI shows the setup command instead.
        const qrSvg = serve.configured && serve.url ? await generateQrSvgDataUri(url) : '';
        sendJson(res, 200, {
          url,
          localUrl,
          qrSvg,
          tailscale: {
            installed: status.installed,
            running: status.running,
            needsLogin: status.needsLogin,
            hostname: status.hostname,
            url: status.url,
            authUrl: status.authUrl,
            serveConfigured: serve.configured,
            error: status.error ?? serve.error,
          },
          setupCommand: buildServeCommand(remotePort),
        });
      } catch (err) {
        logger.error(`[server] /api/remote/info failed: ${err instanceof Error ? err.message : String(err)}`);
        sendJson(res, 500, { error: 'Internal server error' });
      }
    });

    app.get('/remote', async (_req, res) => {
      try {
        const port = Number(process.env.PORT || 3001);
        const [status, serve] = await Promise.all([
          getTailscaleStatus(),
          getTailscaleServeInfo(port),
        ]);
        const ready = serve.configured && Boolean(serve.url);
        const url = ready && serve.url ? serve.url : `http://localhost:${port}`;
        const setupCommand = buildServeCommand(port);
        // Only encode a QR that a phone can actually resolve — a localhost URL
        // would scan into a dead link.
        const qrSvg = ready ? await generateQrSvgDataUri(url) : '';

        const hint = ready
          ? 'Reachable from any device on your tailnet'
          : !status.installed
            ? 'Tailscale is not installed on this computer'
            : !status.running
              ? 'Tailscale is not running'
              : 'Not exposed to the tailnet yet — run the command below';

        const steps = ready
          ? `<li>1. Install Tailscale on your phone and sign in to the same tailnet</li>
      <li>2. Open your camera app and point at the QR code</li>
      <li>3. Tap the notification to open Spark</li>`
          : `<li>1. Start Tailscale on this computer</li>
      <li>2. Run <code>${setupCommand}</code></li>
      <li>3. Reload this page to get the QR code</li>`;

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
    .steps code {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.7rem;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      padding: 0.1rem 0.35rem;
      color: #a78bfa;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>📱 Spark Remote</h1>
    <p>${ready
      ? 'Scan the QR code with your phone camera<br>to open Spark on your mobile device'
      : 'Expose Spark to your tailnet<br>to enable mobile access'}</p>
    ${ready
      ? `<div class="qr-wrap"><img src="${qrSvg}" alt="QR Code"></div>
    <div class="url">${url}</div>`
      : `<div class="url">${setupCommand}</div>`}
    <div class="url-label">${hint}</div>
    <a class="btn" href="/">Open Spark →</a>
    <ol class="steps">
      ${steps}
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

      // ─── Tailscale remote access ────────────────────────────────────────
      if (serveFrontend) {
        const [tsStatus, tsServe] = await Promise.all([
          getTailscaleStatus(),
          getTailscaleServeInfo(resolvedPort),
        ]);
        const localUrl = `http://localhost:${resolvedPort}`;

        logger.info('');
        logger.info('━━━ 📱 Remote Access (Tailscale) ━━━');
        logger.info('');
        logger.info(`  Local:  ${localUrl}`);
        if (!tsStatus.installed) {
          logger.info('  Tailscale is not installed — remote access is off.');
          logger.info('  Install it from https://tailscale.com/download');
        } else if (!tsStatus.running) {
          logger.info('  Tailscale is stopped — start it to reach Spark from your tailnet.');
          if (tsStatus.url) logger.info(`  Tailnet URL once running: ${tsStatus.url}`);
        } else if (tsServe.configured && tsServe.url) {
          logger.info(`  Tailnet: ${tsServe.url}`);
          logger.info(`  QR page: ${localUrl}/remote`);
          logger.info('');
          try {
            const qr = await generateTerminalQr(tsServe.url);
            logger.info(qr);
          } catch {
            logger.info('  [QR generation skipped]');
          }
        } else {
          logger.info(`  Tailnet: ${tsStatus.url ?? '(unknown)'} (not exposed yet)`);
          logger.info('');
          logger.info('  Expose Spark to your tailnet with:');
          logger.info(`    ${buildServeCommand(resolvedPort)}`);
          logger.info('');
          logger.info(`  Then open ${localUrl}/remote for the QR code.`);
        }
        logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
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
// Compare URL-encoded paths: import.meta.url percent-encodes spaces
// (repo lives at "/Volumes/T7 Shield/...") while argv[1] does not, so the
// raw includes() check was always false on this machine and `npm run server`
// silently never started. Normalize both sides through fileURLToPath.
const isEntry = !process.versions.electron &&
  !!process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
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
    // Stop team-agent subprocesses so a `npm run server` exit doesn't orphan
    // run-kanban-agent.py children.
    shutdownTeamCoordinator();
    // Await the bridge stop (SIGINT → 5s → SIGKILL) so it isn't orphaned.
    void stopManagedBridge()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

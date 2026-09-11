// Clean-room schema; no vendor content copied.
// HTTP surface for .mcpb extension installs. Statically imports the
// backend installer (server/lib/mcp-extension-installer.ts) — the runtime
// poll-read loader was retired once the installer landed.
import { timingSafeEqual } from 'crypto';
import { Router, type Express, type Request, type Response } from 'express';
import { getTunnelState } from '../lib/tunnel';
import {
  installExtension,
  listExtensions,
  uninstallExtension,
  enableExtension,
} from '../lib/mcp-extension-installer';

export const mcpExtensionsRouter = Router();

function tokensEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// NOTE: surgical ~15-line duplication of the mcp-workers.route.ts tunnel
// gate (same getTunnelState + timingSafeEqual shape). Shared helper was
// out of scope for this phase; a follow-up can extract one.
function requireTunnelKey(req: Request, res: Response): boolean {
  const tunnel = getTunnelState();
  if (!tunnel.running || !tunnel.url || !tunnel.accessToken) return true;
  const queryKey = typeof req.query.key === 'string' ? req.query.key : null;
  if (queryKey && tokensEqual(queryKey, tunnel.accessToken)) return true;
  const cookies = req.headers.cookie || '';
  const cookieMatch = cookies.match(/(?:^|;\s*)spark_remote_key=([^;]+)/);
  if (cookieMatch?.[1] && tokensEqual(cookieMatch[1], tunnel.accessToken)) return true;
  res.status(401).json({ error: 'Remote access key required' });
  return false;
}

// Mirror of the supervisor statusCodeOf pattern (prefer err.statusCode,
// else message-match): installer errors default 400; rate/limit → 429,
// unavailable → 503.
function statusCodeOf(err: unknown): number {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const code = (err as { statusCode?: unknown }).statusCode;
    if (typeof code === 'number' && Number.isInteger(code)) return code;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/rate|limit/i.test(message)) return 429;
  if (/unavailable/i.test(message)) return 503;
  return 400;
}

// Fail-closed serverId gate: checked before the installer is touched.
// Express already URI-decodes req.params, so %2e-style traversal arrives
// decoded and fails this regex (no extra decode step — avoids double-decode).
// ':' is allowed so the worker-style `ext:<id>` (as returned by list) passes
// here and is normalized below; the installer re-gates strictly.
const SERVER_ID_RE = /^[a-z0-9-:]{1,256}$/;
function invalidServerId(id: unknown): boolean {
  return typeof id !== 'string' || !SERVER_ID_RE.test(id);
}
// Route params carry the worker-style serverId (`ext:<id>`, as returned by
// list); the installer takes the bare registry id. Normalize here so clients
// can feed list output straight back. Remainder still faces the installer's
// strict /^[a-z0-9-]{1,128}$/ (fail-closed on weird input like 'ext:a:b').
function toExtensionId(serverId: string): string {
  return serverId.startsWith('ext:') ? serverId.slice(4) : serverId;
}

// ≈20MiB raw cap + base64 overhead → 28MiB of base64 text. Second layer:
// express.json(MAX_BODY_SIZE, default 10mb) is the effective ceiling until
// the env raises it; this check documents intent and guards if it does.
const MAX_BASE64_CHARS = 28 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64Input(input: unknown): { ok: true; data: Buffer } | { ok: false } {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_BASE64_CHARS) {
    return { ok: false };
  }
  const compact = input.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) return { ok: false };
  try {
    const data = Buffer.from(compact, 'base64');
    if (data.length === 0) return { ok: false };
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

mcpExtensionsRouter.post('/api/mcp-extensions/install', async (req: Request, res: Response) => {
  if (!requireTunnelKey(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { filename, dataBase64, allowUnsigned } = body;
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 256) {
    return res.status(400).json({ error: 'Invalid filename (1-256 chars required)' });
  }
  if (allowUnsigned !== undefined && typeof allowUnsigned !== 'boolean') {
    return res.status(400).json({ error: 'Invalid allowUnsigned (boolean required)' });
  }
  const decoded = decodeBase64Input(dataBase64);
  if (!decoded.ok) {
    return res.status(400).json({ error: 'Invalid dataBase64' });
  }
  try {
    const record = await installExtension({
      filename,
      data: decoded.data,
      ...(allowUnsigned !== undefined ? { allowUnsigned } : {}),
    });
    return res.status(201).json(record);
  } catch (err) {
    const status = statusCodeOf(err);
    const message = err instanceof Error ? err.message : 'Install failed';
    return res.status(status).json({ error: message });
  }
});

mcpExtensionsRouter.get('/api/mcp-extensions', async (_req: Request, res: Response) => {
  try {
    const list = await listExtensions();
    return res.status(200).json(list);
  } catch (err) {
    const status = statusCodeOf(err);
    const message = err instanceof Error ? err.message : 'List failed';
    return res.status(status).json({ error: message });
  }
});

mcpExtensionsRouter.delete('/api/mcp-extensions/:serverId', async (req: Request, res: Response) => {
  if (!requireTunnelKey(req, res)) return;
  const serverId = req.params.serverId;
  if (invalidServerId(serverId)) {
    return res.status(400).json({ error: 'Invalid serverId' });
  }
  try {
    await uninstallExtension(toExtensionId(serverId));
    return res.status(200).json({ uninstalled: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Uninstall failed';
    if (/unknown|not found|no such/i.test(message)) {
      return res.status(404).json({ error: message });
    }
    return res.status(statusCodeOf(err)).json({ error: message });
  }
});

mcpExtensionsRouter.post('/api/mcp-extensions/:serverId/enable', async (req: Request, res: Response) => {
  if (!requireTunnelKey(req, res)) return;
  const serverId = req.params.serverId;
  if (invalidServerId(serverId)) {
    return res.status(400).json({ error: 'Invalid serverId' });
  }
  try {
    const snapshot = await enableExtension(toExtensionId(serverId));
    return res.status(200).json(snapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Enable failed';
    if (/unknown|not found|no such/i.test(message)) {
      return res.status(404).json({ error: message });
    }
    return res.status(statusCodeOf(err)).json({ error: message });
  }
});

export function registerMcpExtensionsRoute(app: Express): void {
  app.use(mcpExtensionsRouter);
}

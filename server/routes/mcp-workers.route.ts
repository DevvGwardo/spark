// Clean-room schema; no vendor content copied.
import { timingSafeEqual } from 'crypto';
import { Router, type Express, type Request, type Response } from 'express';
import { WorkerSpawnRequestSchema } from '../lib/mcp-worker-protocol';
import { callWorkerTool, spawnWorker, workerStatus, stopWorker, statusCodeOf } from '../lib/mcp-worker-supervisor';
import { getTunnelState } from '../lib/tunnel';

export const mcpWorkersRouter = Router();

function tokensEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// While a public tunnel runs, process-spawn/stop endpoints require the
// per-tunnel token (?key=… or spark_remote_key cookie). GET status stays open;
// with no tunnel running, LAN-trusted as before. Returns false + 401s when the
// gate blocks so handlers can `if (!requireTunnelKey(req, res)) return;`.
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

// Local copy of server/index.ts isLoopbackAddress: importing ../index from
// this route would create an import cycle, so the ~10-line check is duplicated
// here. Keep in sync with the canonical version.
function isLoopbackAddress(address: string | null | undefined): boolean {
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

// Same fail-closed serverId gate used by the sibling mcp-extensions route.
const SERVER_ID_RE = /^[a-z0-9-:]{1,256}$/;

function invalidRpcBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'Invalid RPC body';
  }
  const record = body as Record<string, unknown>;
  const { method, params, id, timeoutMs } = record;
  if (typeof method !== 'string' || method.length < 1 || method.length > 256 || method.trim().length === 0) {
    return 'Invalid method';
  }
  // MCP method names use '/', '.', '$', '_' (tools/call, notifications/*) —
  // allow those, but reject control chars (log injection via error paths).
  // eslint-disable-next-line no-control-regex -- intentional C0/C1 reject-list for RPC method names
  if (/[\u0000-\u001f\u007f-\u009f]/.test(method)) {
    return 'Invalid method';
  }
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    return 'Invalid params';
  }
  if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') {
    return 'Invalid id';
  }
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000)
  ) {
    return 'Invalid timeoutMs';
  }
  return null;
}

mcpWorkersRouter.get('/api/mcp-workers/status', (_req: Request, res: Response) => {
  res.status(200).json(workerStatus());
});

mcpWorkersRouter.post('/api/mcp-workers/spawn', async (req: Request, res: Response) => {
  if (!requireTunnelKey(req, res)) return;
  const parsed = WorkerSpawnRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid worker spawn request' });
  }
  try {
    const snapshot = await spawnWorker(parsed.data);
    return res.status(200).json(snapshot);
  } catch (err) {
    const status = statusCodeOf(err);
    const message = err instanceof Error ? err.message : 'Spawn failed';
    return res.status(status).json({ error: message });
  }
});

mcpWorkersRouter.post('/api/mcp-workers/:serverId/rpc', async (req: Request, res: Response) => {
  if (!requireTunnelKey(req, res)) return;
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return res.status(403).json({ error: 'RPC access restricted to loopback' });
  }
  const serverId = req.params.serverId;
  if (typeof serverId !== 'string' || !SERVER_ID_RE.test(serverId)) {
    return res.status(400).json({ error: 'Invalid serverId' });
  }
  const bodyError = invalidRpcBody(req.body);
  if (bodyError) {
    return res.status(400).json({ error: bodyError });
  }
  const { method, params, id, timeoutMs } = req.body as {
    method: string;
    params?: Record<string, unknown>;
    id?: string | number;
    timeoutMs?: number;
  };
  try {
    const response = await callWorkerTool(
      serverId,
      method,
      params,
      timeoutMs !== undefined ? { timeoutMs } : undefined,
    );
    if (id !== undefined) response.id = id;
    return res.status(200).json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'RPC failed';
    if (/request timed out/i.test(message)) {
      return res.status(504).json({ error: message });
    }
    return res.status(statusCodeOf(err)).json({ error: message });
  }
});

mcpWorkersRouter.delete('/api/mcp-workers/:serverId', async (req: Request, res: Response) => {  if (!requireTunnelKey(req, res)) return;
  const serverId = req.params.serverId;
  if (!serverId) {
    return res.status(400).json({ error: 'Missing serverId' });
  }
  try {
    await stopWorker(serverId);
    return res.status(200).json({ stopped: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Stop failed';
    return res.status(500).json({ error: message });
  }
});

export function registerMcpWorkersRoute(app: Express): void {
  app.use(mcpWorkersRouter);
}

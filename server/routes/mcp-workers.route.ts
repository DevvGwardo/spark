// Clean-room schema; no vendor content copied.
import { timingSafeEqual } from 'crypto';
import { Router, type Express, type Request, type Response } from 'express';
import { WorkerSpawnRequestSchema } from '../lib/mcp-worker-protocol';
import { spawnWorker, workerStatus, stopWorker, statusCodeOf } from '../lib/mcp-worker-supervisor';
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

mcpWorkersRouter.delete('/api/mcp-workers/:serverId', async (req: Request, res: Response) => {
  if (!requireTunnelKey(req, res)) return;
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

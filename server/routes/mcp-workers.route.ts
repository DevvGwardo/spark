// Clean-room schema; no vendor content copied.
import { Router, type Express, type Request, type Response } from 'express';
import { WorkerSpawnRequestSchema } from '../lib/mcp-worker-protocol';
import { spawnWorker, workerStatus, stopWorker, statusCodeOf } from '../lib/mcp-worker-supervisor';

export const mcpWorkersRouter = Router();



mcpWorkersRouter.get('/api/mcp-workers/status', (_req: Request, res: Response) => {
  res.status(200).json(workerStatus());
});

mcpWorkersRouter.post('/api/mcp-workers/spawn', async (req: Request, res: Response) => {
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

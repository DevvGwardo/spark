import type { Express, Request, Response } from 'express';
import { taskOrchestrator } from '../task-orchestrator';
import { sendJson } from '../lib/helpers';

export function registerOrchestratorRoutes(app: Express) {
  // GET /api/hermes/orchestrator/status
  app.get('/api/hermes/orchestrator/status', (_req: Request, res: Response) => {
    try {
      const status = taskOrchestrator.getStatus();
      sendJson(res, 200, status);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get orchestrator status';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/orchestrator/start
  app.post('/api/hermes/orchestrator/start', (_req: Request, res: Response) => {
    try {
      taskOrchestrator.start();
      sendJson(res, 200, { ok: true, enabled: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start orchestrator';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/orchestrator/stop
  app.post('/api/hermes/orchestrator/stop', (_req: Request, res: Response) => {
    try {
      taskOrchestrator.stop();
      sendJson(res, 200, { ok: true, enabled: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to stop orchestrator';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/orchestrator/dispatch-now
  app.post('/api/hermes/orchestrator/dispatch-now', async (_req: Request, res: Response) => {
    try {
      const result = await taskOrchestrator.dispatchNow();
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to dispatch';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/orchestrator/cancel/:cardId
  app.post('/api/hermes/orchestrator/cancel/:cardId', async (req: Request, res: Response) => {
    try {
      const { cardId } = req.params;
      const cancelled = await taskOrchestrator.cancelTask(cardId);
      if (!cancelled) {
        return sendJson(res, 404, { error: 'Task not found or already completed' });
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to cancel task';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/orchestrator/card-complete — webhook from kanban PATCH handler
  app.post('/api/hermes/orchestrator/card-complete', async (req: Request, res: Response) => {
    try {
      const { cardId, status } = req.body as { cardId?: string; status?: string };
      if (!cardId) {
        return sendJson(res, 400, { error: 'cardId is required' });
      }
      const validStatuses = ['review', 'done', 'blocked'];
      const resolvedStatus = validStatuses.includes(status ?? '') ? (status as 'review' | 'done' | 'blocked') : 'done';

      const handled = await taskOrchestrator.handleCardCompletion(cardId, resolvedStatus);
      if (!handled) {
        return sendJson(res, 404, { error: 'Card not found in active tasks' });
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to handle card completion';
      sendJson(res, 500, { error: message });
    }
  });

    // GET /api/hermes/orchestrator/queue — full queue state with card details
  app.get('/api/hermes/orchestrator/queue', async (_req: Request, res: Response) => {
    try {
      const state = await taskOrchestrator.getQueueState();
      sendJson(res, 200, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get queue state';
      sendJson(res, 500, { error: message });
    }
  });

// POST /api/hermes/orchestrator/dispatch-card/:cardId — dispatch a specific card
  // as a background agent task (no chat panel, no tab switching)
  app.post('/api/hermes/orchestrator/dispatch-card/:cardId', async (req: Request, res: Response) => {
    try {
      const { cardId } = req.params;
      if (!cardId) {
        return sendJson(res, 400, { error: 'cardId is required' });
      }
      const result = await taskOrchestrator.dispatchCard(cardId);
      if (!result.ok) {
        return sendJson(res, 409, { error: result.error || 'Failed to dispatch card' });
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to dispatch card';
      sendJson(res, 500, { error: message });
    }
  });
}

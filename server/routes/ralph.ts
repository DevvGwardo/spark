import { Request, Response } from 'express';

import {
  cancelRalphRun,
  getRalphRun,
  listRalphRuns,
  startRalphRun,
} from '../ralph-loop';
import type { RalphRun } from '../../shared/ralph';

// ─── Ralph loop routes ─────────────────────────────────────────────────────
// POST /api/hermes/ralph            { objective, maxRounds?, workspaceDir? } → run
// GET  /api/hermes/ralph            → all runs (newest first)
// GET  /api/hermes/ralph/:id        → one run
// POST /api/hermes/ralph/:id/cancel → cancel an in-flight run

/** Public view of a run: in-flight runs get an explicit status label. */
function serializeRun(run: RalphRun) {
  const inFlight = run.finishedAt === null;
  return {
    ...run,
    statusLabel: inFlight ? 'running' : run.status,
  };
}

export function registerRalphRoutes(app: import('express').Express): void {
  app.post('/api/hermes/ralph', (req: Request, res: Response) => {
    const body = req.body ?? {};
    const objective = typeof body.objective === 'string' ? body.objective : '';
    if (!objective.trim()) {
      res.status(400).json({ error: 'objective is required' });
      return;
    }
    const maxRounds = body.maxRounds === undefined ? undefined : Number(body.maxRounds);
    if (maxRounds !== undefined && (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 256)) {
      res.status(400).json({ error: 'maxRounds must be an integer between 1 and 256' });
      return;
    }
    const workspaceDir =
      typeof body.workspaceDir === 'string' && body.workspaceDir.trim()
        ? body.workspaceDir
        : undefined;
    try {
      const run = startRalphRun({ objective, maxRounds, workspaceDir });
      res.json({ run: serializeRun(run) });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'failed to start ralph run',
      });
    }
  });

  app.get('/api/hermes/ralph', (_req: Request, res: Response) => {
    res.json({ runs: listRalphRuns().map(serializeRun) });
  });

  app.get('/api/hermes/ralph/:id', (req: Request, res: Response) => {
    const run = getRalphRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'run not found' });
      return;
    }
    res.json({ run: serializeRun(run) });
  });

  app.post('/api/hermes/ralph/:id/cancel', (req: Request, res: Response) => {
    const ok = cancelRalphRun(req.params.id);
    if (!ok) {
      res.status(409).json({ error: 'run not found or already finished' });
      return;
    }
    res.json({ ok: true });
  });
}

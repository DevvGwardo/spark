import { logger } from '../lib/logger';
import type { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { teamCoordinator, isComplexTask } from '../team-coordinator';
import { createTeamContextStore } from '../team-context-store';
import { analyzeTask } from '../team-formation';
import { publishToMesh, registerMeshPeer, pollMeshDelegations } from '../mesh-bridge';
import { sendJson, RateLimiter } from '../lib/helpers';

// ─── Rate limiting ──────────────────────────────────────────────────────────

const createTeamLimiter = new RateLimiter(60_000, 10);   // 10 team creations per minute
const publishContextLimiter = new RateLimiter(30_000, 30); // 30 context publishes per 30s

// ─── Context store (opened at module import) ────────────────────────────────

const contextStore = createTeamContextStore();

// Register process-exit handler to close the SQLite connection gracefully
let exitHandlerRegistered = false;
function ensureExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.on('exit', () => {
    try { contextStore.close(); } catch { /* ignore */ }
  });
  process.on('SIGINT', () => {
    try { contextStore.close(); } catch { /* ignore */ }
    process.exit(0);
  });
}
ensureExitHandler();

// ─── Helpers ────────────────────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 100_000; // 100KB cap on context entries and results

/** Strip common prompt-injection markers from agent-controlled text. */
function sanitizeContent(raw: string): string {
  let s = String(raw).slice(0, MAX_CONTENT_LENGTH);
  // Strip HTML-like tag markers that can be used for injection
  s = s.replace(/<\/?(system|assistant|user|tool|function)>/gi, '');
  s = s.replace(/ignore\s+(all\s+)?(previous|above|below)\s+instructions/gi, '[redacted]');
  s = s.replace(/forget\s+(all\s+)?(previous|above|below)/gi, '[redacted]');
  s = s.replace(/role\s*[:=]\s*["']?(system|assistant|user)["']?/gi, '[redacted]');
  return s;
}

/** Wrap agent-controlled text so it appears as data, not instructions. */
function wrapContextContent(content: string): string {
  const sanitized = sanitizeContent(content);
  return `--- BEGIN CONTEXT ---\n${sanitized}\n--- END CONTEXT ---`;
}

export function registerTeamRoutes(app: Express) {
  // ─── Team CRUD ───────────────────────────────────────────────────────────

  // POST /api/hermes/team/create — Create a team for a task
  app.post('/api/hermes/team/create', async (req: Request, res: Response) => {
    try {
      const clientIp = req.ip || 'unknown';
      if (!createTeamLimiter.isAllowed(`create:${clientIp}`)) {
        return sendJson(res, 429, { error: 'Too many team creations. Please wait.' });
      }

      const { cardId, title, spec, acceptanceCriteria, teamMode } = req.body;

      if (!cardId && !title) {
        return sendJson(res, 400, { error: 'Either cardId or title is required' });
      }

      const card = {
        id: cardId || '',
        title: title || 'Untitled',
        spec: spec || '',
        acceptanceCriteria: Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [],
        teamMode: !!teamMode,
      };

      // Create the team
      const team = await teamCoordinator.createTeam(card);

      // Decompose the task
      const subtasks = await teamCoordinator.decomposeTask(card);

      // Assign subtasks to agents
      const assigned = teamCoordinator.assignSubtasks(subtasks, team.agents);

      team.subtasks = assigned;

      sendJson(res, 201, {
        team: {
          id: team.id,
          taskId: team.taskId,
          agents: team.agents.map((a) => ({
            profileName: a.profileName,
            displayName: a.displayName,
            expertise: a.expertise,
            status: a.status,
          })),
          subtasks: team.subtasks.map((s) => ({
            id: s.id,
            title: s.title,
            description: s.description,
            assignedTo: s.assignedTo,
            dependencies: s.dependencies,
            status: s.status,
          })),
          status: team.status,
          createdAt: team.createdAt,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create team';
      sendJson(res, 500, { error: message });
    }
  });

  // GET /api/hermes/team/:id — Get team status
  app.get('/api/hermes/team/:id', (req: Request, res: Response, next: NextFunction) => {
    // "active" and "completed" have dedicated list routes registered below;
    // let them fall through instead of being matched as a team id (which 404s).
    if (req.params.id === 'active' || req.params.id === 'completed') return next();
    try {
      const { id } = req.params;
      const team = teamCoordinator.getTeam(id);
      if (!team) {
        return sendJson(res, 404, { error: 'Team not found' });
      }
      sendJson(res, 200, { team });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get team';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/team/:id/dispatch — Start the team working
  app.post('/api/hermes/team/:id/dispatch', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const ok = await teamCoordinator.dispatchTeam(id);
      if (!ok) {
        return sendJson(res, 409, { error: 'Team not found or not in forming status' });
      }
      sendJson(res, 200, { ok: true, status: 'active' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to dispatch team';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/team/:id/pause — Pause team execution (SIGSTOP child processes)
  app.post('/api/hermes/team/:id/pause', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const ok = teamCoordinator.pauseTeam(id);
      if (!ok) {
        return sendJson(res, 409, { error: 'Team not found or not in a pausable status (active/forming)' });
      }
      sendJson(res, 200, { ok: true, status: 'paused' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to pause team';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/team/:id/resume — Resume team execution (SIGCONT child processes)
  app.post('/api/hermes/team/:id/resume', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const ok = teamCoordinator.resumeTeam(id);
      if (!ok) {
        return sendJson(res, 409, { error: 'Team not found or not in paused status' });
      }
      sendJson(res, 200, { ok: true, status: 'active' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resume team';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/team/:id/reassign — Reassign a subtask to a different agent
  app.post('/api/hermes/team/:id/reassign', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { subtaskId, newAgent } = req.body;

      if (!subtaskId || !newAgent) {
        return sendJson(res, 400, { error: 'subtaskId and newAgent are required' });
      }

      const team = teamCoordinator.getTeam(id);
      if (!team) {
        return sendJson(res, 404, { error: 'Team not found' });
      }

      const subtask = team.subtasks.find((s) => s.id === subtaskId);
      if (!subtask) {
        return sendJson(res, 404, { error: 'Subtask not found' });
      }

      const agent = team.agents.find((a) => a.profileName === newAgent);
      if (!agent) {
        return sendJson(res, 404, { error: 'Agent not found in team' });
      }

      // Clear previous assignment
      if (subtask.assignedTo) {
        const prevAgent = team.agents.find((a) => a.profileName === subtask.assignedTo);
        if (prevAgent && prevAgent.currentSubtask === subtaskId) {
          prevAgent.currentSubtask = null;
          prevAgent.status = 'idle';
        }
      }

      subtask.assignedTo = newAgent;
      subtask.status = 'pending';

      sendJson(res, 200, { ok: true, subtask });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to reassign subtask';
      sendJson(res, 500, { error: message });
    }
  });

  // ─── Team Context ────────────────────────────────────────────────────────

  // GET /api/hermes/team/:id/context — Get shared team context entries
  app.get('/api/hermes/team/:id/context', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const type = req.query.type as string | undefined;
      const tag = req.query.tag as string | undefined;
      const author = req.query.author as string | undefined;

      const entries = contextStore.query(id, { type, tag, author });
      sendJson(res, 200, { entries, total: entries.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to query context';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/team/:id/blocked — Report a blocked subtask (called by agent tools)
  app.post('/api/hermes/team/:id/blocked', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { subtaskId, reason } = req.body;

      if (!subtaskId || !reason) {
        return sendJson(res, 400, { error: 'subtaskId and reason are required' });
      }

      await teamCoordinator.handleBlocked(id, subtaskId, String(reason));
      sendJson(res, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to report blocked';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/team/:id/context — Publish to team context (called by agent tools)
  app.post('/api/hermes/team/:id/context', (req: Request, res: Response) => {
    try {
      const clientIp = req.ip || 'unknown';
      if (!publishContextLimiter.isAllowed(`publish:${clientIp}`)) {
        return sendJson(res, 429, { error: 'Too many context publishes. Please wait.' });
      }

      const { id } = req.params;
      const { type, content, author, importance, tags } = req.body;

      if (!content || !author) {
        return sendJson(res, 400, { error: 'content and author are required' });
      }

      const validTypes = ['finding', 'decision', 'artifact', 'question', 'handoff'];
      const resolvedType = validTypes.includes(type) ? type : 'finding';

      // Sanitize and wrap agent-controlled content to prevent prompt injection
      const sanitized = wrapContextContent(String(content).slice(0, MAX_CONTENT_LENGTH));

      const entry = contextStore.publish(id, {
        type: resolvedType,
        content: sanitized,
        author: String(author).slice(0, 100),
        importance: (typeof importance === 'number' && Number.isFinite(importance))
          ? Math.max(1, Math.min(3, importance)) : 2,
        tags: Array.isArray(tags) ? tags.map(String).slice(0, 20) : [],
      });

      sendJson(res, 201, { entry });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to publish context';
      sendJson(res, 500, { error: message });
    }
  });

  // ─── Active / Completed Teams ───────────────────────────────────────────

  // GET /api/hermes/team/active — List all active teams (including paused)
  app.get('/api/hermes/team/active', (_req: Request, res: Response) => {
    try {
      const activeTeams = teamCoordinator.getActiveTeams();
      sendJson(res, 200, {
        teams: activeTeams.map((t) => ({
          id: t.id,
          taskId: t.taskId,
          agentCount: t.agents.length,
          status: t.status,
          createdAt: t.createdAt,
        })),
        total: activeTeams.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list active teams';
      sendJson(res, 500, { error: message });
    }
  });

  // GET /api/hermes/team/completed — List completed teams
  app.get('/api/hermes/team/completed', (_req: Request, res: Response) => {
    try {
      const doneTeams = teamCoordinator.getTeams({ status: 'done' });
      sendJson(res, 200, {
        teams: doneTeams.map((t) => ({
          id: t.id,
          taskId: t.taskId,
          agentCount: t.agents.length,
          status: t.status,
          createdAt: t.createdAt,
        })),
        total: doneTeams.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list completed teams';
      sendJson(res, 500, { error: message });
    }
  });

  // ─── Delegations ─────────────────────────────────────────────────────────

  // POST /api/hermes/team/delegation — Create a delegation between agents
  app.post('/api/hermes/team/delegation', (req: Request, res: Response) => {
    try {
      const { teamId, fromAgent, toAgent, subtaskTitle, handoffContext } = req.body;

      if (!teamId || !fromAgent || !toAgent) {
        return sendJson(res, 400, { error: 'teamId, fromAgent, and toAgent are required' });
      }

      const team = teamCoordinator.getTeam(teamId);
      if (!team) {
        return sendJson(res, 404, { error: 'Team not found' });
      }

      const delegation = {
        id: randomUUID(),
        fromAgent,
        toAgent,
        subtaskId: '',
        status: 'pending' as const,
        handoffContext: handoffContext || '',
        result: null,
      };

      // Create a new subtask for the delegated work
      const subtask = {
        id: randomUUID(),
        title: subtaskTitle || `Delegated from ${fromAgent} to ${toAgent}`,
        description: handoffContext || '',
        assignedTo: toAgent,
        dependencies: [],
        status: 'pending' as const,
        result: null,
      };

      delegation.subtaskId = subtask.id;
      team.subtasks.push(subtask);
      team.delegations.push(delegation);

      sendJson(res, 201, { delegation, subtask });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create delegation';
      sendJson(res, 500, { error: message });
    }
  });

  // PATCH /api/hermes/team/delegation — Update delegation by body params (called by team_signal_completion)
  app.patch('/api/hermes/team/delegation', async (req: Request, res: Response) => {
    try {
      const { teamId, subtaskId, status: newStatus, result } = req.body;

      if (!teamId || !subtaskId) {
        return sendJson(res, 400, { error: 'teamId and subtaskId are required' });
      }

      if (newStatus === 'completed' && result) {
        // Cap result to 100KB
        const cappedResult = String(result).slice(0, MAX_CONTENT_LENGTH);

        // Handle subtask completion — also update delegation status
        const team = teamCoordinator.getTeam(teamId);
        if (team) {
          const delegation = team.delegations.find((d) => d.subtaskId === subtaskId);
          if (delegation) {
            delegation.status = 'completed';
            delegation.result = cappedResult;
          }
        }
        await teamCoordinator.handleSubtaskComplete(teamId, subtaskId, cappedResult);
        return sendJson(res, 200, { ok: true });
      }

      // Update delegation status
      const team = teamCoordinator.getTeam(teamId);
      if (!team) {
        return sendJson(res, 404, { error: 'Team not found' });
      }

      const delegation = team.delegations.find((d) => d.subtaskId === subtaskId);
      if (delegation) {
        if (newStatus) delegation.status = newStatus;
        if (result) delegation.result = String(result).slice(0, MAX_CONTENT_LENGTH);
      }

      sendJson(res, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update delegation';
      sendJson(res, 500, { error: message });
    }
  });

  // PATCH /api/hermes/team/delegation/:id — Update delegation status
  app.patch('/api/hermes/team/delegation/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { teamId, subtaskId, status: newStatus, result } = req.body;

      if (!teamId) {
        return sendJson(res, 400, { error: 'teamId is required' });
      }

      if (subtaskId && newStatus === 'completed' && result) {
        const cappedResult = String(result).slice(0, MAX_CONTENT_LENGTH);

        // Handle subtask completion — also update delegation status
        const team = teamCoordinator.getTeam(teamId);
        if (team) {
          const delegation = team.delegations.find((d) => d.id === id || d.subtaskId === subtaskId);
          if (delegation) {
            delegation.status = 'completed';
            delegation.result = cappedResult;
          }
        }
        await teamCoordinator.handleSubtaskComplete(teamId, subtaskId, cappedResult);
        return sendJson(res, 200, { ok: true });
      }

      // Update delegation status
      const team = teamCoordinator.getTeam(teamId);
      if (!team) {
        return sendJson(res, 404, { error: 'Team not found' });
      }

      const delegation = team.delegations.find((d) => d.id === id);
      if (!delegation) {
        return sendJson(res, 404, { error: 'Delegation not found' });
      }

      if (newStatus) {
        delegation.status = newStatus;
      }
      if (result) {
        delegation.result = String(result).slice(0, MAX_CONTENT_LENGTH);
      }

      sendJson(res, 200, { delegation });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update delegation';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/team/synthesize/:id — Trigger synthesis
  app.post('/api/hermes/team/synthesize/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const team = teamCoordinator.getTeam(id);
      if (!team) {
        return sendJson(res, 404, { error: 'Team not found' });
      }

      // Await inline so failures are surfaced to the caller
      try {
        await teamCoordinator.synthesizeResults(id);
      } catch (err) {
        logger.error(`[team-routes] Synthesis error: ${err instanceof Error ? err.message : String(err)}`);
        // Ensure team doesn't stay stuck in 'synthesizing'
        const t = teamCoordinator.getTeam(id);
        if (t && t.status === 'synthesizing') {
          t.status = 'done';
        }
      }

      sendJson(res, 200, { ok: true, message: 'Synthesis completed' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to trigger synthesis';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/team/complexity-check — Check if a task is complex enough for a team
  app.post('/api/hermes/team/complexity-check', async (req: Request, res: Response) => {
    try {
      const { title, spec, acceptanceCriteria, agents } = req.body;

      if (!title) {
        return sendJson(res, 400, { error: 'title is required' });
      }

      const card = {
        id: '',
        title: String(title),
        spec: String(spec || ''),
        acceptanceCriteria: Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [],
      };

      // Use provided agent profiles when available for more accurate strategy
      const formationAgents = Array.isArray(agents) ? agents : [];
      const complex = isComplexTask(card);
      const formation = analyzeTask(String(title), formationAgents);
      sendJson(res, 200, {
        isComplex: complex,
        reason: formation.reason,
        strategy: formation.strategy,
        recommendedAgents: formation.recommendedAgents,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to check complexity';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/team/:id/mesh-sync — Sync team state to agentic-mesh
  app.post('/api/hermes/team/:id/mesh-sync', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const team = teamCoordinator.getTeam(id);
      if (!team) {
        return sendJson(res, 404, { error: 'Team not found' });
      }

      const syncResult: {
        peersRegistered: number;
        eventsPublished: string[];
        incomingDelegations: number;
        errors: string[];
      } = {
        peersRegistered: 0,
        eventsPublished: [],
        incomingDelegations: 0,
        errors: [],
      };

      // 1. Register all team agents as mesh peers
      for (const agent of team.agents) {
        try {
          await registerMeshPeer({
            profileName: agent.profileName,
            displayName: agent.displayName,
            expertise: agent.expertise,
          });
          syncResult.peersRegistered++;
        } catch (e) {
          syncResult.errors.push(`Failed to register peer ${agent.displayName}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // 2. Publish current team status
      try {
        const statusEvent = team.status === 'done' ? 'team_synthesized' as const
          : team.status === 'active' ? 'team_formed' as const
          : 'team_formed' as const;
        await publishToMesh(id, {
          type: statusEvent,
          payload: {
            taskId: team.taskId,
            agentCount: team.agents.length,
            subtaskCount: team.subtasks.length,
            status: team.status,
          },
        });
        syncResult.eventsPublished.push(statusEvent);
      } catch (e) {
        syncResult.errors.push(`Failed to publish status: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 3. Poll for incoming delegations
      try {
        const delegations = await pollMeshDelegations();
        syncResult.incomingDelegations = delegations.length;
      } catch (e) {
        syncResult.errors.push(`Failed to poll delegations: ${e instanceof Error ? e.message : String(e)}`);
      }

      sendJson(res, 200, { ok: true, sync: syncResult });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to sync with mesh';
      sendJson(res, 500, { error: message });
    }
  });
}

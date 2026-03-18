import { streamText } from 'ai';
import type { Request, Response } from 'express';
import { createProviderModel, getReasoningProviderOptions } from './provider-config';
import { normalizeChatMessages } from './message-normalization';

// ─── SSE helper ──────────────────────────────────────────────────────────────

const DEFAULT_SUBTASK_TIMEOUT_MS = 90 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_SUB_AGENTS_LIMIT = 6;
const MAX_RETRY_BACKOFF_MS = 10_000;

type ToolProfile = 'research' | 'coding' | 'general';

const VALID_TOOL_PROFILES = new Set<string>(['research', 'coding', 'general']);

function isValidToolProfile(value: unknown): value is ToolProfile {
  return typeof value === 'string' && VALID_TOOL_PROFILES.has(value);
}

// ─── Sub-Agent Registry ─────────────────────────────────────────────────────

interface SubAgentRecord {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'retrying' | 'cancelled';
  retryCount: number;
  maxRetries: number;
  model: string;
  toolProfile: ToolProfile;
  error?: string;
  result?: string;
  startedAt?: number;
  completedAt?: number;
  abortController: AbortController;
}

function registrySnapshot(registry: Map<string, SubAgentRecord>) {
  const entries: Array<{
    id: string;
    status: string;
    retryCount: number;
    model: string;
    startedAt?: number;
    elapsedMs?: number;
  }> = [];
  const now = Date.now();
  for (const record of registry.values()) {
    entries.push({
      id: record.id,
      status: record.status,
      retryCount: record.retryCount,
      model: record.model,
      startedAt: record.startedAt,
      elapsedMs: record.startedAt
        ? (record.completedAt ?? now) - record.startedAt
        : undefined,
    });
  }
  return entries;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function readPositiveIntEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function sendEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function getUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startHeartbeat(
  res: Response,
  phase: string,
  isClientDisconnected: () => boolean,
  intervalMs: number,
) {
  const timer = setInterval(() => {
    if (!isClientDisconnected()) {
      sendEvent(res, 'heartbeat', { phase });
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

function retryBackoffMs(retryCount: number): number {
  return Math.min(1000 * Math.pow(2, retryCount), MAX_RETRY_BACKOFF_MS);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    };

    if (signal?.aborted) {
      clearTimeout(timer);
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── Orchestrate handler factory ─────────────────────────────────────────────

export function createOrchestrateHandler() {
  return async (req: Request, res: Response) => {
    let clientDisconnected = false;
    const parentAbortController = new AbortController();

    // Track all intervals/timeouts for cleanup on disconnect
    const activeTimers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];

    req.on('close', () => {
      clientDisconnected = true;
      parentAbortController.abort();
      // Clean up all active timers
      for (const timer of activeTimers) {
        clearInterval(timer);
        clearTimeout(timer);
      }
      activeTimers.length = 0;
    });

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const allowedOrigins = new Set([
      'http://localhost:5173',
      'http://localhost:3000',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:3000',
      'app://.',
    ]);
    const requestOrigin = req.headers.origin;
    const corsOrigin = requestOrigin && allowedOrigins.has(requestOrigin)
      ? requestOrigin
      : 'http://localhost:5173';
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);

    try {
      const {
        // Single provider for all phases
        provider,
        model,
        api_key,
        reasoning_effort,
        // Legacy dual-provider fields — fall back to single provider
        orchestrator_provider,
        orchestrator_model,
        orchestrator_api_key,
        orchestrator_reasoning_effort,
        sub_agent_provider,
        sub_agent_model,
        sub_agent_api_key,
        sub_agent_reasoning_effort,
        messages,
        system_prompt,
        max_sub_agents = 3,
        temperature,
        // New fields for retry / fallback
        max_retries,
        fallback_model,
      } = req.body;

      const resolvedMaxRetries = typeof max_retries === 'number' && max_retries >= 0
        ? max_retries
        : DEFAULT_MAX_RETRIES;
      const resolvedFallbackModel = typeof fallback_model === 'string' && fallback_model.trim()
        ? fallback_model.trim()
        : undefined;

      // Resolve provider config — prefer new single-provider fields, fall back to legacy
      const resolvedProvider = provider || orchestrator_provider;
      const resolvedModel = model || orchestrator_model;
      const resolvedApiKey = api_key || orchestrator_api_key;
      const resolvedReasoningEffort = reasoning_effort || orchestrator_reasoning_effort;
      const resolvedSubProvider = provider || sub_agent_provider || resolvedProvider;
      const resolvedSubModel = model || sub_agent_model || resolvedModel;
      const resolvedSubApiKey = api_key || sub_agent_api_key || resolvedApiKey;
      const resolvedSubReasoningEffort = reasoning_effort || sub_agent_reasoning_effort || resolvedReasoningEffort;

      if (!resolvedApiKey) {
        sendEvent(res, 'error', { message: 'API key is required' });
        res.end();
        return;
      }

      // Extract the original user message (last user message in conversation)
      const userMessages = (Array.isArray(messages) ? messages : [] as Array<{ role?: string; content?: string }>)
        .filter((m) => m.role === 'user');
      const originalUserMessage = userMessages.length > 0
        ? userMessages[userMessages.length - 1].content
        : '';

      // ── Phase 1: Planning ────────────────────────────────────────────────

      sendEvent(res, 'status', { phase: 'planning', message: 'Breaking down your request...' });

      if (clientDisconnected) { res.end(); return; }

      const aiModel = createProviderModel(
        resolvedProvider,
        resolvedModel,
        resolvedApiKey,
        { origin: req.headers.origin as string | undefined }
      );
      const providerOptions = getReasoningProviderOptions(
        resolvedProvider,
        resolvedModel,
        resolvedReasoningEffort,
      );

      const planningSystemPrompt = `You are a task orchestrator. Break the user's request into independent sub-tasks for parallel execution.

You MUST respond with ONLY valid JSON — no markdown, no code fences, no extra text. Example:

{"plan":"Modernize the UI layout and components","tasks":[{"id":"1","description":"Redesign the header with a modern navigation bar using flexbox, rounded corners, and subtle shadows","toolProfile":"coding"},{"id":"2","description":"Research modern CSS design trends and best practices for dark-mode interfaces","toolProfile":"research"}]}

Rules:
- Respond with ONLY the JSON object, nothing else
- Each task must be completely self-contained with full context
- Sub-agents have NO shared context — include all details in each task description
- Use 1-${Math.min(max_sub_agents, MAX_SUB_AGENTS_LIMIT)} tasks depending on complexity
- For simple questions or short requests, use exactly 1 task
- For complex multi-part requests, split into 2-${Math.min(max_sub_agents, MAX_SUB_AGENTS_LIMIT)} tasks
- Task descriptions should be specific and actionable
- Each task MUST include a "toolProfile" field with one of: "research" (web search/lookup tasks), "coding" (code/repo tasks), "general" (everything else, default)`;

      const planningInput = normalizeChatMessages(
        messages,
        [planningSystemPrompt, typeof system_prompt === 'string' ? system_prompt : '']
          .filter(Boolean)
          .join('\n\n'),
      );

      let plan: { plan: string; tasks: Array<{ id: string; description: string; toolProfile?: string }> };
      const heartbeatIntervalMs = readPositiveIntEnv('ORCHESTRATOR_HEARTBEAT_MS', DEFAULT_HEARTBEAT_MS);
      const stopPlanningHeartbeat = startHeartbeat(
        res,
        'planning',
        () => clientDisconnected,
        heartbeatIntervalMs,
      );

      try {
        // Use streamText instead of generateText for provider compatibility
        // (Kimi Coding and similar APIs only support streaming mode reliably)
        const planStream = streamText({
          model: aiModel as any,
          messages: planningInput.messages as any,
          temperature: temperature ?? 0.7,
          ...(providerOptions ? { providerOptions } : {}),
          abortSignal: parentAbortController.signal,
        });

        let planText = '';
        for await (const chunk of (await planStream).textStream) {
          if (clientDisconnected) break;
          planText += chunk;
        }

        const rawText = planText.trim();

        // Try to parse JSON, handling potential markdown code blocks
        let jsonText = rawText;
        const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          jsonText = jsonMatch[1].trim();
        }

        plan = JSON.parse(jsonText);

        // Validate structure
        if (!plan.plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
          throw new Error('Invalid plan structure');
        }

        // Enforce max sub-agents limit
        const limit = Math.max(1, Math.min(MAX_SUB_AGENTS_LIMIT, max_sub_agents));
        if (plan.tasks.length > limit) {
          plan.tasks = plan.tasks.slice(0, limit);
        }

        // Normalize toolProfile on each task
        for (const task of plan.tasks) {
          if (!isValidToolProfile(task.toolProfile)) {
            task.toolProfile = 'general';
          }
        }
      } catch (parseError) {
        // Fallback: single task with the original message
        plan = {
          plan: 'Direct response to user request',
          tasks: [{ id: '1', description: originalUserMessage, toolProfile: 'general' }],
        };
      } finally {
        stopPlanningHeartbeat();
      }

      sendEvent(res, 'plan', { plan: plan.plan, tasks: plan.tasks });

      if (clientDisconnected) { res.end(); return; }

      // ── Phase 2: Execute sub-tasks with retry ──────────────────────────

      sendEvent(res, 'status', { phase: 'executing', message: 'Running sub-agents...' });

      const subtaskTimeoutMs = readPositiveIntEnv('ORCHESTRATOR_SUBTASK_TIMEOUT_MS', DEFAULT_SUBTASK_TIMEOUT_MS);

      // Build the sub-agent registry
      const registry = new Map<string, SubAgentRecord>();
      const parentAbortCleanups: Array<() => void> = [];

      for (const task of plan.tasks) {
        const taskAbort = new AbortController();
        // Cascade parent abort to each task
        const onParentAbort = () => taskAbort.abort();
        parentAbortController.signal.addEventListener('abort', onParentAbort);
        parentAbortCleanups.push(() => parentAbortController.signal.removeEventListener('abort', onParentAbort));

        registry.set(task.id, {
          id: task.id,
          description: task.description,
          status: 'pending',
          retryCount: 0,
          maxRetries: resolvedMaxRetries,
          model: resolvedSubModel,
          toolProfile: (isValidToolProfile(task.toolProfile) ? task.toolProfile : 'general') as ToolProfile,
          abortController: taskAbort,
        });
      }

      // Heartbeat that sends registry_update during execution phase
      const executionHeartbeat = setInterval(() => {
        if (!clientDisconnected) {
          sendEvent(res, 'registry_update', { registry: registrySnapshot(registry) });
        }
      }, heartbeatIntervalMs);
      activeTimers.push(executionHeartbeat);

      // Execute a single sub-task with retry logic
      async function executeSubTask(
        taskId: string,
      ): Promise<{ id: string; description: string; result: string }> {
        const record = registry.get(taskId)!;

        if (clientDisconnected) {
          record.status = 'cancelled';
          record.completedAt = Date.now();
          return { id: record.id, description: record.description, result: 'Error: Client disconnected' };
        }

        record.status = 'running';
        record.startedAt = Date.now();

        sendEvent(res, 'subtask_start', { taskId: record.id, description: record.description });

        while (true) {
          try {
            const currentModel = record.retryCount > 0 && resolvedFallbackModel
              ? resolvedFallbackModel
              : resolvedSubModel;
            record.model = currentModel;

            const subAgentModel = createProviderModel(
              resolvedSubProvider,
              currentModel,
              resolvedSubApiKey,
              { origin: req.headers.origin as string | undefined }
            );
            const subAgentProviderOptions = getReasoningProviderOptions(
              resolvedSubProvider,
              currentModel,
              resolvedSubReasoningEffort,
            );

            // Per-attempt timeout via a separate abort
            const attemptAbort = new AbortController();
            const timeout = setTimeout(() => attemptAbort.abort(), subtaskTimeoutMs);
            activeTimers.push(timeout);

            // If the task-level abort fires, also abort this attempt
            const onTaskAbort = () => attemptAbort.abort();
            record.abortController.signal.addEventListener('abort', onTaskAbort);

            try {
              const subTaskMessages = normalizeChatMessages(
                [{ role: 'user' as const, content: record.description }],
                `You are a helpful assistant working on a specific sub-task.\n\nTask: ${record.description}`,
              ).messages;

              const stream = streamText({
                model: subAgentModel as any,
                messages: subTaskMessages as any,
                temperature: temperature ?? 0.7,
                ...(subAgentProviderOptions ? { providerOptions: subAgentProviderOptions } : {}),
                abortSignal: attemptAbort.signal,
              });

              let taskResult = '';
              for await (const chunk of (await stream).textStream) {
                if (clientDisconnected) break;
                taskResult += chunk;
              }

              // Success
              record.status = 'done';
              record.result = taskResult;
              record.completedAt = Date.now();
              sendEvent(res, 'subtask_complete', { taskId: record.id, result: taskResult });
              return { id: record.id, description: record.description, result: taskResult };
            } finally {
              clearTimeout(timeout);
              record.abortController.signal.removeEventListener('abort', onTaskAbort);
            }
          } catch (err: unknown) {
            const message = getUnknownErrorMessage(err);
            const isAbort = err instanceof Error && err.name === 'AbortError';
            const isTimeout = isAbort && !clientDisconnected && !record.abortController.signal.aborted;

            // If the client disconnected or the task was explicitly cancelled, don't retry
            if (clientDisconnected || (isAbort && record.abortController.signal.aborted && !isTimeout)) {
              record.status = 'cancelled';
              record.completedAt = Date.now();
              const reason = clientDisconnected ? 'Client disconnected' : 'Task cancelled';
              record.error = reason;
              sendEvent(res, 'subtask_cancelled', { taskId: record.id, reason });
              return { id: record.id, description: record.description, result: `Error: ${reason}` };
            }

            const errorMsg = isTimeout
              ? `Sub-task timed out after ${Math.round(subtaskTimeoutMs / 1000)}s`
              : message || 'Sub-agent failed';

            console.error(`Sub-task ${record.id} failed (attempt ${record.retryCount + 1}):`, errorMsg);

            // Check if we can retry
            if (record.retryCount < record.maxRetries) {
              record.retryCount += 1;
              record.status = 'retrying';

              const nextModel = record.retryCount >= 2 && resolvedFallbackModel
                ? resolvedFallbackModel
                : resolvedSubModel;

              sendEvent(res, 'subtask_retry', {
                taskId: record.id,
                retryCount: record.retryCount,
                model: nextModel,
                reason: errorMsg,
              });

              // Exponential backoff
              const backoff = retryBackoffMs(record.retryCount - 1);
              try {
                await delay(backoff, record.abortController.signal);
              } catch {
                // Abort during backoff — treat as cancellation
                record.status = 'cancelled';
                record.completedAt = Date.now();
                record.error = 'Cancelled during retry backoff';
                sendEvent(res, 'subtask_cancelled', { taskId: record.id, reason: 'Cancelled during retry backoff' });
                return { id: record.id, description: record.description, result: 'Error: Cancelled during retry backoff' };
              }

              // Loop will continue with the next attempt
              continue;
            }

            // All retries exhausted
            record.status = 'failed';
            record.error = errorMsg;
            record.completedAt = Date.now();
            sendEvent(res, 'subtask_failed', {
              taskId: record.id,
              error: errorMsg,
              retryCount: record.retryCount,
              maxRetries: record.maxRetries,
            });
            const failResult = `Error: ${errorMsg}`;
            record.result = failResult;
            return { id: record.id, description: record.description, result: failResult };
          }
        }
      }

      // Run all sub-tasks concurrently with allSettled pattern
      const settled = await Promise.allSettled(
        plan.tasks.map((task) => executeSubTask(task.id))
      );

      // Stop the execution heartbeat
      clearInterval(executionHeartbeat);

      // Clean up parent abort listeners to prevent memory leaks
      for (const cleanup of parentAbortCleanups) cleanup();

      // Collect results — failed promises become error results
      const taskResults = settled.map((outcome, idx) => {
        if (outcome.status === 'fulfilled') {
          return outcome.value;
        }
        const task = plan.tasks[idx];
        return {
          id: task.id,
          description: task.description,
          result: `Error: ${getUnknownErrorMessage(outcome.reason)}`,
        };
      });

      // Send a final registry snapshot
      if (!clientDisconnected) {
        sendEvent(res, 'registry_update', { registry: registrySnapshot(registry) });
      }

      if (clientDisconnected) { res.end(); return; }

      // ── Phase 3: Synthesize results (streaming) ──────────────────────────

      sendEvent(res, 'status', { phase: 'synthesizing', message: 'Combining results...' });
      const stopSynthesisHeartbeat = startHeartbeat(
        res,
        'synthesizing',
        () => clientDisconnected,
        heartbeatIntervalMs,
      );

      const taskResultsText = taskResults
        .map((t) => `Task ${t.id}: ${t.description}\nResult: ${t.result}\n`)
        .join('\n');

      const synthesisPrompt = `The user's original request was:
${originalUserMessage}

Sub-agents completed the following tasks:
${taskResultsText}

Synthesize these results into a single, comprehensive response for the user. Be thorough and well-organized.`;
      const synthesisMessages = normalizeChatMessages(
        [{ role: 'user' as const, content: synthesisPrompt }],
        'You are a helpful assistant synthesizing results from multiple sub-tasks into a coherent response.',
      ).messages;

      try {
        const synthesisStream = streamText({
          model: aiModel as any,
          messages: synthesisMessages as any,
          temperature: temperature ?? 0.7,
          ...(providerOptions ? { providerOptions } : {}),
          abortSignal: parentAbortController.signal,
        });

        for await (const chunk of (await synthesisStream).textStream) {
          if (clientDisconnected) break;
          sendEvent(res, 'token', { content: chunk });
        }
      } finally {
        stopSynthesisHeartbeat();
      }

      sendEvent(res, 'done', {});
      res.end();
    } catch (err: unknown) {
      console.error('Orchestration error:', err);
      sendEvent(res, 'error', { message: getUnknownErrorMessage(err) || 'Orchestration failed' });
      sendEvent(res, 'done', {});
      res.end();
    }
  };
}

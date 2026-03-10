import { streamText } from 'ai';
import type { Request, Response } from 'express';
import { createProviderModel, getReasoningProviderOptions } from './provider-config';

// ─── SSE helper ──────────────────────────────────────────────────────────────

function sendEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function getUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Orchestrate handler factory ─────────────────────────────────────────────

export function createOrchestrateHandler() {
  return async (req: Request, res: Response) => {
    let clientDisconnected = false;
    const abortController = new AbortController();

    req.on('close', () => {
      clientDisconnected = true;
      abortController.abort();
    });

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
      const {
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
      } = req.body;

      if (!orchestrator_api_key || !sub_agent_api_key) {
        sendEvent(res, 'error', { message: 'API keys are required for both orchestrator and sub-agent providers' });
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

      const orchestratorModel = createProviderModel(
        orchestrator_provider,
        orchestrator_model,
        orchestrator_api_key,
        { origin: req.headers.origin as string | undefined }
      );
      const orchestratorProviderOptions = getReasoningProviderOptions(
        orchestrator_provider,
        orchestrator_model,
        orchestrator_reasoning_effort,
      );

      const planningSystemPrompt = `You are a task orchestrator. Break the user's request into independent sub-tasks for parallel execution.

You MUST respond with ONLY valid JSON — no markdown, no code fences, no extra text. Example:

{"plan":"Modernize the UI layout and components","tasks":[{"id":"1","description":"Redesign the header with a modern navigation bar using flexbox, rounded corners, and subtle shadows"},{"id":"2","description":"Update the color scheme to use a modern dark palette with accent colors"}]}

Rules:
- Respond with ONLY the JSON object, nothing else
- Each task must be completely self-contained with full context
- Sub-agents have NO shared context — include all details in each task description
- Use 1-${Math.min(max_sub_agents, 6)} tasks depending on complexity
- For simple questions or short requests, use exactly 1 task
- For complex multi-part requests, split into 2-${Math.min(max_sub_agents, 6)} tasks
- Task descriptions should be specific and actionable`;

      const planningMessages = [
        { role: 'system' as const, content: planningSystemPrompt },
        ...(system_prompt ? [{ role: 'system' as const, content: system_prompt }] : []),
        ...messages,
      ];

      let plan: { plan: string; tasks: Array<{ id: string; description: string }> };

      try {
        // Use streamText instead of generateText for provider compatibility
        // (Kimi Coding and similar APIs only support streaming mode reliably)
        const planStream = streamText({
          model: orchestratorModel,
          messages: planningMessages,
          temperature: temperature ?? 0.7,
          ...(orchestratorProviderOptions ? { providerOptions: orchestratorProviderOptions } : {}),
          abortSignal: abortController.signal,
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
        const limit = Math.max(1, Math.min(6, max_sub_agents));
        if (plan.tasks.length > limit) {
          plan.tasks = plan.tasks.slice(0, limit);
        }
      } catch (parseError) {
        // Fallback: single task with the original message
        plan = {
          plan: 'Direct response to user request',
          tasks: [{ id: '1', description: originalUserMessage }],
        };
      }

      sendEvent(res, 'plan', { plan: plan.plan, tasks: plan.tasks });

      if (clientDisconnected) { res.end(); return; }

      // ── Phase 2: Execute sub-tasks in parallel ───────────────────────────

      const subAgentModel = createProviderModel(
        sub_agent_provider,
        sub_agent_model,
        sub_agent_api_key,
        { origin: req.headers.origin as string | undefined }
      );
      const subAgentProviderOptions = getReasoningProviderOptions(
        sub_agent_provider,
        sub_agent_model,
        sub_agent_reasoning_effort,
      );

      sendEvent(res, 'status', { phase: 'executing', message: 'Running sub-agents...' });

      // Per-task timeout (60 seconds) to prevent hanging
      const SUBTASK_TIMEOUT_MS = 60_000;
      // Heartbeat interval so the client knows we're alive
      const HEARTBEAT_MS = 5_000;

      const taskResults = await Promise.all(
        plan.tasks.map(async (task) => {
          if (clientDisconnected) {
            return { id: task.id, description: task.description, result: 'Error: Client disconnected' };
          }

          sendEvent(res, 'subtask_start', { taskId: task.id, description: task.description });

          try {
            // Create a per-task abort that respects both client disconnect and timeout
            const taskAbort = new AbortController();
            const timeout = setTimeout(() => taskAbort.abort(), SUBTASK_TIMEOUT_MS);
            // If the parent aborts (client disconnect), also abort this task
            const onParentAbort = () => taskAbort.abort();
            abortController.signal.addEventListener('abort', onParentAbort);

            // Send periodic heartbeats so the client knows this task is still working
            const heartbeat = setInterval(() => {
              if (!clientDisconnected) {
                sendEvent(res, 'subtask_heartbeat', { taskId: task.id });
              }
            }, HEARTBEAT_MS);

            try {
              // Use streamText instead of generateText for better provider compatibility
              // (many APIs like Kimi Coding only support streaming mode reliably)
              const stream = streamText({
                model: subAgentModel,
                messages: [
                  {
                    role: 'system' as const,
                    content: `You are a helpful assistant working on a specific sub-task.\n\nTask: ${task.description}`,
                  },
                  { role: 'user' as const, content: task.description },
                ],
                temperature: temperature ?? 0.7,
                ...(subAgentProviderOptions ? { providerOptions: subAgentProviderOptions } : {}),
                abortSignal: taskAbort.signal,
              });

              let taskResult = '';
              for await (const chunk of (await stream).textStream) {
                if (clientDisconnected) break;
                taskResult += chunk;
              }
              sendEvent(res, 'subtask_complete', { taskId: task.id, result: taskResult });
              return { id: task.id, description: task.description, result: taskResult };
            } finally {
              clearInterval(heartbeat);
              clearTimeout(timeout);
              abortController.signal.removeEventListener('abort', onParentAbort);
            }
          } catch (err: unknown) {
            const message = getUnknownErrorMessage(err);
            const isTimeout = err instanceof Error && err.name === 'AbortError' && !clientDisconnected;
            const errorMsg = isTimeout
              ? 'Error: Sub-task timed out after 60s'
              : `Error: ${message || 'Sub-agent failed'}`;
            console.error(`Sub-task ${task.id} failed:`, message || err);
            sendEvent(res, 'subtask_complete', { taskId: task.id, result: errorMsg });
            return { id: task.id, description: task.description, result: errorMsg };
          }
        })
      );

      if (clientDisconnected) { res.end(); return; }

      // ── Phase 3: Synthesize results (streaming) ──────────────────────────

      sendEvent(res, 'status', { phase: 'synthesizing', message: 'Combining results...' });

      const taskResultsText = taskResults
        .map((t) => `Task ${t.id}: ${t.description}\nResult: ${t.result}\n`)
        .join('\n');

      const synthesisPrompt = `The user's original request was:
${originalUserMessage}

Sub-agents completed the following tasks:
${taskResultsText}

Synthesize these results into a single, comprehensive response for the user. Be thorough and well-organized.`;

      const synthesisStream = streamText({
        model: orchestratorModel,
        messages: [
          { role: 'system' as const, content: 'You are a helpful assistant synthesizing results from multiple sub-tasks into a coherent response.' },
          { role: 'user' as const, content: synthesisPrompt },
        ],
        temperature: temperature ?? 0.7,
        ...(orchestratorProviderOptions ? { providerOptions: orchestratorProviderOptions } : {}),
        abortSignal: abortController.signal,
      });

      for await (const chunk of (await synthesisStream).textStream) {
        if (clientDisconnected) break;
        sendEvent(res, 'token', { content: chunk });
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

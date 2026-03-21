import type { Express } from 'express';
import { streamText, tool, type DataStreamWriter } from 'ai';
import { z } from 'zod';
import { buildServerRepoTools, type ServerToolEvent } from '../agent-loop';
import {
  createProviderModel,
  getReasoningProviderOptions,
  OPENAI_COMPATIBLE,
  resolveHermesExecutionMode,
  resolveRuntimeProvider,
  usesFirstPartyProviderSdk,
} from '../provider-config';
import { runOpenClawTurn } from '../openclaw';
import { getRepoTurnIntentInstruction } from '../../src/lib/repo-intent';
import { bindClientDisconnect } from '../http-disconnect';
import { normalizeChatMessages } from '../message-normalization';
import { isAbortLikeError } from '../direct-sse-proxy';
import { buildCorsHeaders, chatRateLimiter, getClientIp, sendJson } from '../lib/helpers';
import {
  createSingleMessageDataStream,
  isValidGitHubPAT,
  normalizeLocalProviderError,
} from '../lib/github-utils';
import {
  proxyCompatibleProviderToDataStream,
  proxyHermesAgentLoopToDataStream,
  shouldDirectProxyCompatibleProvider,
} from '../lib/hermes';
import { buildLocalExecutionTools, parseAgentToolsets, getLocalToolsSystemPromptFragment } from '../local-tools';

// ─── /functions/v1/chat ──────────────────────────────────────────────────────

// Filter out problematic stream lines (e.g. empty error entries from some providers)
export function registerChatRoute(app: Express) {

app.post('/functions/v1/chat', async (req, res) => {
  if (!chatRateLimiter.isAllowed(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Too many requests. Please try again later.' });
  }

  let requestTimeout: ReturnType<typeof setTimeout> | null = null;
  const abortController = new AbortController();
  const disconnect = bindClientDisconnect(req, res, () => {
    abortController.abort();
    if (requestTimeout) {
      clearTimeout(requestTimeout);
      requestTimeout = null;
    }
  });

  try {
    const {
      provider = 'lovable',
      model,
      messages,
      temperature,
      top_p,
      max_tokens,
      api_key,
      system_prompt,
      activeRepo,
      repo_edit_intent,
      reasoning_effort,
      conversation_id,
      hermes_toolsets,
      hermes_minimax_key,
      repo_file_cache,
      repo_file_tree,
      agent_toolsets,
    } = req.body;

    // Resolve API key
    let apiKey = '';
    if (provider === 'openclaw') {
      apiKey = '';
    } else if (provider === 'lovable') {
      apiKey = process.env.LOVABLE_API_KEY || '';
      if (!apiKey) {
        return sendJson(res, 500, { error: 'Lovable AI is not configured' });
      }
    } else {
      apiKey = api_key;
      if (!apiKey) {
        return sendJson(res, 400, { error: `API key is required for ${provider}` });
      }
    }

    // Build system prompt, appending repo context if activeRepo is present
    let effectiveSystemPrompt = system_prompt || '';
    if (activeRepo) {
      const repoFileTree = Array.isArray(repo_file_tree)
        ? repo_file_tree.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
        : [];
      const repoEditIntent = !!repo_edit_intent;
      const repoContext = `You are working on the GitHub repository ${activeRepo.owner}/${activeRepo.name}. You have tools to read, edit, create, and delete files in this repo.

First determine whether the current user turn is asking for read-only repository help or for actual code changes.
- If the user is asking what the repo is, how it works, where something lives, or for analysis/review, stay read-only: inspect files as needed and answer directly.
- Only enter the edit workflow when the user explicitly asks you to modify the repository.
- Never treat repo selection by itself as permission to edit.

WORKFLOW — FOR CHANGE REQUESTS:
1. Use read_repo_file to explore and understand the relevant files.
2. Then use batch_edit_repo_files to apply ALL changes at once (preferred for multiple files), or edit_repo_file / create_repo_file individually.
3. Do NOT ask the user which file to edit or to share files with you — explore the repo yourself.
4. Do NOT ask clarifying questions. Use your judgment, explore the repo to understand the codebase, and make changes directly. If the request is ambiguous, make reasonable assumptions and explain them.
5. When the user asks you to update multiple things, make sure you update ALL of them, not just one.
6. IMPORTANT: If you need to edit many large files, split batch_edit_repo_files into multiple calls (max 3-4 files per batch) to avoid output truncation.
7. Never conclude that the repository is empty or inaccessible just because a guessed file path failed to read.

${repoFileTree.length > 0
  ? `The selected repository file tree is already available below. Use it to identify candidate files, and do NOT ask the user to provide file paths.

Repository file tree:
${repoFileTree.join('\n')}

`
  : `If the repository file tree is missing, do not guess placeholder paths like \`.\`, \`/\`, \`src/main\`, \`server\`, \`client\`, or \`package.json\`. Wait for real repo-tree guidance before reading files.

`}${getRepoTurnIntentInstruction(repoEditIntent)}

All changes are staged for a PR — they are not applied directly to the repo.`;
      effectiveSystemPrompt = effectiveSystemPrompt
        ? `${effectiveSystemPrompt}\n\n${repoContext}`
        : repoContext;
      // Inject cached file contents so the model doesn't need to re-read them
      if (repo_file_cache && typeof repo_file_cache === 'object') {
        const paths = Object.keys(repo_file_cache);
        if (paths.length > 0) {
          const fileSummaries = paths.map((p) => {
            const content = repo_file_cache[p];
            return `### ${p}\n\`\`\`\n${content}\n\`\`\``;
          });
          effectiveSystemPrompt += `\n\n--- Previously Read Files (cached) ---\nThe following files have already been read in this conversation. You do NOT need to call read_repo_file for these unless you suspect they have changed. Use the content below directly:\n\n${fileSummaries.join('\n\n')}`;
        }
      }
    }

    const normalizedChatInput = normalizeChatMessages(messages, effectiveSystemPrompt);

    if (provider === 'openclaw') {
      const latestUserMessage = [...(Array.isArray(messages) ? messages : [])]
        .reverse()
        .find((message: { role?: string; content?: string }) => message.role === 'user' && typeof message.content === 'string')
        ?.content
        ?.trim();

      if (!latestUserMessage) {
        return sendJson(res, 400, { error: 'OpenClaw requires a user message' });
      }

      const result = await runOpenClawTurn({
        message: latestUserMessage,
        sessionId: typeof conversation_id === 'string' && conversation_id
          ? conversation_id
          : `cloudchat-${crypto.randomUUID()}`,
        model: typeof model === 'string' ? model : undefined,
        systemPrompt: effectiveSystemPrompt,
      });

      const response = new Response(createSingleMessageDataStream(result.text, result.usage), {
        status: 200,
        headers: {
          ...buildCorsHeaders(req.headers.origin),
          'Content-Type': 'text/plain; charset=utf-8',
          'x-vercel-ai-data-stream': 'v1',
        },
      });

      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      res.status(response.status);

      if (!response.body) {
        res.end();
        return;
      }

      const reader = response.body.getReader();

      bindClientDisconnect(req, res, () => {
        reader.cancel().catch(() => {});
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          break;
        }
        const ok = res.write(Buffer.from(value));
        if (!ok) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
      return;
    }

    // File creation tools (always available for artifact/preview support)
    const fileTools = {
      create_html_file: tool({
        description:
          'Create an HTML file. Use this when the user asks you to create an HTML page, website, or web component. The file will be available for live preview.',
        parameters: z.object({
          filename: z.string().describe('The filename (e.g. "index.html")'),
          content: z.string().describe('The full HTML content'),
        }),
      }),
      create_css_file: tool({
        description:
          'Create a CSS stylesheet file. Use this when the user asks you to create CSS styles.',
        parameters: z.object({
          filename: z.string().describe('The filename (e.g. "styles.css")'),
          content: z.string().describe('The full CSS content'),
        }),
      }),
      create_js_file: tool({
        description:
          'Create a JavaScript file. Use this when the user asks you to create JS code for a web page.',
        parameters: z.object({
          filename: z.string().describe('The filename (e.g. "app.js")'),
          content: z.string().describe('The full JavaScript content'),
        }),
      }),
      create_react_component: tool({
        description:
          'Create a React component file (JSX/TSX). Use this when the user asks you to create a React component.',
        parameters: z.object({
          filename: z.string().describe('The filename (e.g. "App.jsx" or "Component.tsx")'),
          content: z.string().describe('The full JSX/TSX content (no import/export needed, just the component function)'),
        }),
      }),
      create_markdown_file: tool({
        description:
          'Create a Markdown file. Use this when the user asks you to create documentation, READMEs, notes, or any markdown content.',
        parameters: z.object({
          filename: z.string().describe('The filename (e.g. "README.md")'),
          content: z.string().describe('The full Markdown content'),
        }),
      }),
    };

    const rawGithubPAT = req.body.github_pat;
    const githubPAT = isValidGitHubPAT(rawGithubPAT) ? rawGithubPAT : undefined;
    const hasServerRepoContext = !!(activeRepo && githubPAT);
    const runtimeProvider = resolveRuntimeProvider(provider, { activeRepo });
    const hermesExecutionMode =
      provider === 'hermes' && runtimeProvider === 'hermes'
        ? resolveHermesExecutionMode({ activeRepo, githubPAT })
        : null;

    // Collect server tool events to inject into the data stream
    const serverToolEvents: ServerToolEvent[] = [];
    const emitToolEvent = (event: ServerToolEvent) => {
      serverToolEvents.push(event);
    };

    // Build local execution tools (terminal, files, code_execution) for any provider
    const localToolsets = parseAgentToolsets(agent_toolsets);
    const localTools = buildLocalExecutionTools(localToolsets);
    const hasLocalTools = Object.keys(localTools).length > 0;

    // Append local tools context to system prompt
    if (hasLocalTools) {
      const localToolsFragment = getLocalToolsSystemPromptFragment(localToolsets);
      if (localToolsFragment) {
        effectiveSystemPrompt = effectiveSystemPrompt
          ? effectiveSystemPrompt + localToolsFragment
          : localToolsFragment.trim();
      }
    }

    const repoTools = hasServerRepoContext
      ? buildServerRepoTools(
          {
            owner: activeRepo.owner,
            name: activeRepo.name,
            defaultBranch: activeRepo.default_branch || 'main',
            githubPAT,
            repoFileTree: Array.isArray(repo_file_tree)
              ? repo_file_tree.filter((p: unknown): p is string => typeof p === 'string' && (p as string).trim().length > 0)
              : [],
            repoFileCache: repo_file_cache && typeof repo_file_cache === 'object' ? repo_file_cache : {},
            repoEditIntent: !!repo_edit_intent,
          },
          emitToolEvent,
        )
      : {};

    console.log(
      `[chat] provider=${provider} runtime=${runtimeProvider} model=${model} activeRepo=${activeRepo?.owner}/${activeRepo?.name || '-'} serverRepoTools=${hasServerRepoContext} hermesExecutionMode=${hermesExecutionMode ?? '-'} msgs=${messages?.length}`,
    );
    if (activeRepo && !githubPAT && (provider === 'hermes' || runtimeProvider === 'hermes')) {
        console.warn(`[chat] WARNING: activeRepo set (${activeRepo.owner}/${activeRepo.name}) but no github_pat in request body — Hermes won't be able to read repo files`);
    }

    if (provider === 'hermes' && runtimeProvider === 'hermes' && hermesExecutionMode === 'agent-loop') {
      console.log(`[chat] Proxying Hermes agent-loop directly to AI SDK data stream. model=${model}`);
      await proxyHermesAgentLoopToDataStream({
        req,
        res,
        apiKey,
        model,
        messages: normalizedChatInput.messages,
        temperature,
        topP: top_p,
        maxTokens: max_tokens,
        hermesToolsets: hermes_toolsets,
        repoEditIntent: !!repo_edit_intent,
        activeRepo,
        githubPAT,
        hermesMiniMaxKey: hermes_minimax_key,
      });
      return;
    }

    if (shouldDirectProxyCompatibleProvider(provider, hasServerRepoContext) && !hasLocalTools) {
      console.log(`[chat] Proxying ${provider} directly to AI SDK data stream. model=${model}`);
      await proxyCompatibleProviderToDataStream({
        req,
        res,
        provider,
        apiKey,
        model,
        messages: normalizedChatInput.messages,
        temperature,
        topP: top_p,
        maxTokens: max_tokens,
      });
      return;
    }

    let aiModel;
    try {
      aiModel = createProviderModel(runtimeProvider, model, apiKey, {
        origin: req.headers.origin as string | undefined,
        extraHeaders: provider === 'hermes' && runtimeProvider === 'hermes'
          ? {
              ...(hermes_toolsets ? { 'X-Hermes-Toolsets': hermes_toolsets } : {}),
              ...(hermesExecutionMode ? { 'X-Hermes-Execution-Mode': hermesExecutionMode } : {}),
              ...(hermesExecutionMode === 'agent-loop' && activeRepo && githubPAT
                ? { 'X-Hermes-Repo-Edit-Intent': repo_edit_intent ? '1' : '0' }
                : {}),
              ...(hermesExecutionMode === 'agent-loop' && activeRepo && githubPAT ? {
                'X-Hermes-Repo-Owner': activeRepo.owner,
                'X-Hermes-Repo-Name': activeRepo.name,
              } : {}),
              ...(hermesExecutionMode === 'agent-loop' && activeRepo && githubPAT ? {
                'X-Hermes-Github-PAT': githubPAT,
              } : {}),
            }
          : undefined,
      });
    } catch (error) {
      console.error(`[chat] Failed to create provider model: ${error instanceof Error ? error.message : error}`);
      return sendJson(
        res,
        400,
        { error: error instanceof Error ? error.message : `Unknown provider: ${provider}` }
      );
    }

    // Cap output tokens — 64k causes hangs when models generate full file contents
    // as tool call arguments. 16k is enough for meaningful edits without stalling.
    const defaultMaxTokens = activeRepo ? 16384 : 32768;
    const providerOptions = getReasoningProviderOptions(provider, model, reasoning_effort);

    // Per-request timeout: abort if the entire streamText run exceeds 5 minutes.
    // This prevents indefinite hangs when a model step generates extremely slowly.
    requestTimeout = setTimeout(() => {
      if (!disconnect.isDisconnected()) {
        console.warn('[chat] Request timeout — aborting after 5 minutes');
        abortController.abort();
      }
    }, 5 * 60 * 1000);

    // Only include tools when the provider reliably supports tool_choice.
    // OpenRouter and other OpenAI-compatible providers host many models —
    // some (especially free/small ones) reject requests with tool_choice,
    // causing a 404. First-party SDK providers (Google, xAI, Groq, etc.)
    // always support tools. For compatible providers, only include tools
    // when there's an active server repo context (agentic mode) or local
    // tools are enabled, since those are explicitly opted-in by the user.
    const isToolSafeProvider = usesFirstPartyProviderSdk(provider);
    const includeBaseTools = hasServerRepoContext || isToolSafeProvider || hasLocalTools;
    const allTools = {
      ...(includeBaseTools ? fileTools : {}),
      ...repoTools,
      ...localTools,
    };
    const useServerAgentLoop = hasServerRepoContext || hasLocalTools;
    const hasTools = Object.keys(allTools).length > 0;
    console.log(`[chat] Starting streamText. maxTokens=${max_tokens ?? defaultMaxTokens} maxSteps=${useServerAgentLoop ? 'unlimited' : 1} tools=${hasTools ? Object.keys(allTools).join(',') : '(none)'} toolSafe=${isToolSafeProvider} localTools=${hasLocalTools}`);
    const result = streamText({
      model: aiModel,
      messages: normalizedChatInput.messages,
      temperature: temperature ?? 0.7,
      topP: top_p ?? 0.9,
      maxOutputTokens: max_tokens ?? defaultMaxTokens,
      abortSignal: abortController.signal,
      ...(providerOptions ? { providerOptions } : {}),
      ...(hasTools ? { tools: allTools, toolCallStreaming: true } : {}),
      // Let the model loop until it stops calling tools (no artificial cap).
      ...(hasTools && useServerAgentLoop ? { maxSteps: Infinity } : {}),
      onFinish: () => {
        if (requestTimeout) {
          clearTimeout(requestTimeout);
        }
      },
    });

    // Use pipeDataStreamToResponse for proper Node.js streaming.
    // This avoids issues with toDataStreamResponse where the finish
    // message can be emitted before content for some providers.
    result.pipeDataStreamToResponse(res, {
      headers: buildCorsHeaders(req.headers.origin),
      sendReasoning: true,
      data: serverToolEvents.length > 0
        ? serverToolEvents.map((event) => event as unknown as Record<string, unknown>)
        : undefined,
      getErrorMessage: (error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[chat] Stream error: ${msg}`);
        return msg;
      },
    });
  } catch (err: unknown) {
    if (requestTimeout) {
      clearTimeout(requestTimeout);
    }

    if ((disconnect.isDisconnected() || abortController.signal.aborted) && isAbortLikeError(err)) {
      return;
    }

    console.error('chat error:', err);

    let status = 500;
    let errorMessage = 'Unknown error';

    if (err && typeof err === 'object') {
      const errRecord = err as {
        errors?: unknown[];
        statusCode?: number;
        status?: number;
        responseBody?: string;
      };
      const errors = errRecord.errors;
      const innerError =
        Array.isArray(errors) && errors.length > 0 ? errors[errors.length - 1] : err;
      const innerErrorRecord = innerError as {
        statusCode?: number;
        status?: number;
        responseBody?: string;
      };

      const statusCode = innerErrorRecord.statusCode || innerErrorRecord.status;
      if (statusCode) status = statusCode;

      const responseBody = innerErrorRecord.responseBody;
      if (responseBody) {
        try {
          const parsed = JSON.parse(responseBody);
          const meta = parsed?.error?.metadata?.raw;
          errorMessage =
            meta || parsed?.error?.message || (err instanceof Error ? err.message : 'Provider error');
        } catch {
          errorMessage = err instanceof Error ? err.message : 'Provider error';
        }
      } else {
        errorMessage = err instanceof Error ? err.message : 'Provider error';
      }
    }

    console.error(`[chat] Request failed: status=${status} error=${errorMessage} provider=${req.body?.provider} model=${req.body?.model}`);

    const normalizedProviderError = normalizeLocalProviderError(req.body?.provider, errorMessage);
    if (normalizedProviderError) {
      status = normalizedProviderError.status;
      errorMessage = normalizedProviderError.error;
    }

    const lower = errorMessage.toLowerCase();
    if (lower.includes('data policy') || lower.includes('settings/privacy')) {
      status = 400;
      errorMessage =
        'OpenRouter blocked this free model due to your privacy settings. Enable free model publication in https://openrouter.ai/settings/privacy and try again.';
    }

    if (lower.includes('tool_choice') || lower.includes("don't support tools") || lower.includes('does not support tools')) {
      status = 400;
      errorMessage =
        `This model (${req.body?.model || 'unknown'}) does not support tool use. It can still be used for basic chat, but file creation and repo editing features won't work. Try a more capable model for tool-based features.`;
    }

    if (!res.headersSent) {
      sendJson(res, status, { error: errorMessage });
    }
  }
});

}

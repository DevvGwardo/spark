import type { Express } from 'express';
import { existsSync } from 'fs';
import { join, isAbsolute } from 'path';
import { StreamData, streamText, tool, type CoreMessage, type DataStreamWriter, type JSONValue } from 'ai';
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
import { ensureRepoClone } from '../repo-clone-manager';
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
  proxyHermesSwarmToDataStream,
  shouldDirectProxyCompatibleProvider,
} from '../lib/hermes';
import { buildLocalExecutionTools, parseAgentToolsets, getLocalToolsSystemPromptFragment } from '../local-tools';
import { MAX_AGENT_STEPS } from '../config';

// ─── /functions/v1/chat ──────────────────────────────────────────────────────

// Filter out problematic stream lines (e.g. empty error entries from some providers)
const REPO_PROMPT_FILE_TREE_LIMIT = 200;
const REPO_PROMPT_CACHE_FILE_LIMIT = 6;
const REPO_PROMPT_CACHE_FILE_CHAR_LIMIT = 4000;
const REPO_PROMPT_CACHE_TOTAL_CHAR_LIMIT = 16000;
const HERMES_LOCAL_REPO_TOOLSETS = new Set(['terminal', 'files', 'code_execution']);

function parseToolsetList(raw: unknown): Set<string> {
  if (typeof raw !== 'string') {
    return new Set();
  }

  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function resolveAttachedLocalRepoPath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string') {
    return null;
  }

  const normalizedPath = rawPath.trim();
  if (!normalizedPath || !isAbsolute(normalizedPath)) {
    return null;
  }

  return existsSync(join(normalizedPath, '.git')) ? normalizedPath : null;
}

function buildLocalRepoAccessPrompt(params: {
  provider: string;
  localRepoPath: string;
  repoFullName: string;
}): string {
  const base = [
    `A verified local checkout of ${params.repoFullName} is available at: ${params.localRepoPath}`,
    'Use that checkout as the source of truth for this turn.',
    'Do not ask the user to clone the repository, provide files, or provide a GitHub token.',
  ];

  if (params.provider === 'hermes') {
    return [
      ...base,
      'This turn is using a local checkout fallback instead of GitHub repo tools.',
      'Do not call read_repo_file, edit_repo_file, create_repo_file, or batch_edit_repo_files for this turn.',
      'Use your local file, terminal, or code-execution tools against the checkout path above.',
    ].join('\n');
  }

  return [
    ...base,
    'Inspect and modify files directly in that checkout path.',
  ].join('\n');
}

function selectRepresentativeRepoPaths(paths: string[], limit: number): string[] {
  const buckets = new Map<string, string[]>();

  for (const path of paths) {
    const topLevel = path.split('/')[0] || path;
    const bucket = buckets.get(topLevel) ?? [];
    bucket.push(path);
    buckets.set(topLevel, bucket);
  }

  const bucketEntries = Array.from(buckets.entries())
    .map(([topLevel, bucketPaths]) => ({
      topLevel,
      paths: [...bucketPaths].sort((left, right) => {
        const depthDiff = left.split('/').length - right.split('/').length;
        return depthDiff !== 0 ? depthDiff : left.localeCompare(right);
      }),
    }))
    .sort((left, right) => right.paths.length - left.paths.length || left.topLevel.localeCompare(right.topLevel));

  const selected: string[] = [];
  const seen = new Set<string>();
  let cursor = 0;

  while (selected.length < limit) {
    let addedThisRound = false;

    for (const bucket of bucketEntries) {
      const candidate = bucket.paths[cursor];
      if (!candidate || seen.has(candidate)) {
        continue;
      }

      seen.add(candidate);
      selected.push(candidate);
      addedThisRound = true;

      if (selected.length >= limit) {
        break;
      }
    }

    if (!addedThisRound) {
      break;
    }

    cursor += 1;
  }

  return selected;
}

function summarizeRepoTreeForPrompt(paths: string[]): string {
  if (paths.length === 0) {
    return '';
  }

  const topLevelCounts = new Map<string, number>();
  for (const path of paths) {
    const [topLevel] = path.split('/');
    if (!topLevel) continue;
    topLevelCounts.set(topLevel, (topLevelCounts.get(topLevel) ?? 0) + 1);
  }

  const topLevelSummary = Array.from(topLevelCounts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([entry, count]) => `${entry}${entry.includes('.') ? '' : '/'} (${count})`)
    .join(', ');

  const visiblePaths = selectRepresentativeRepoPaths(paths, REPO_PROMPT_FILE_TREE_LIMIT);
  const truncatedCount = Math.max(paths.length - visiblePaths.length, 0);

  return `${[
    `The selected repository file tree contains ${paths.length} files.`,
    topLevelSummary ? `Top-level entries by file count: ${topLevelSummary}.` : '',
    truncatedCount > 0
      ? `Showing ${visiblePaths.length} representative paths below. The remaining ${truncatedCount} paths are omitted to keep the prompt compact.`
      : 'The full file tree is listed below.',
    '',
    'Representative exact repository paths:',
    ...visiblePaths,
  ].filter(Boolean).join('\n')}`;
}

function formatCachedFilesForPrompt(cache: Record<string, unknown>): string {
  const entries = Object.entries(cache).filter((entry): entry is [string, string] =>
    typeof entry[0] === 'string' &&
    entry[0].trim().length > 0 &&
    typeof entry[1] === 'string' &&
    entry[1].length > 0,
  );

  if (entries.length === 0) {
    return '';
  }

  const sections: string[] = [];
  let totalChars = 0;
  let includedFiles = 0;

  for (const [path, content] of entries) {
    if (includedFiles >= REPO_PROMPT_CACHE_FILE_LIMIT || totalChars >= REPO_PROMPT_CACHE_TOTAL_CHAR_LIMIT) {
      break;
    }

    const remainingBudget = REPO_PROMPT_CACHE_TOTAL_CHAR_LIMIT - totalChars;
    const visibleContent = content.slice(0, Math.min(REPO_PROMPT_CACHE_FILE_CHAR_LIMIT, remainingBudget));
    if (!visibleContent) {
      break;
    }

    const truncated = visibleContent.length < content.length;
    sections.push(`### ${path}\n\`\`\`\n${visibleContent}${truncated ? '\n... [truncated]' : ''}\n\`\`\``);
    totalChars += visibleContent.length;
    includedFiles += 1;
  }

  if (sections.length === 0) {
    return '';
  }

  const omittedFiles = Math.max(entries.length - includedFiles, 0);
  return `${[
    '--- Previously Read Files (cached) ---',
    'Use these cached file contents directly unless you have a concrete reason to re-read them.',
    omittedFiles > 0
      ? `Showing ${includedFiles} cached files. ${omittedFiles} additional cached files are omitted to control prompt size.`
      : `Showing ${includedFiles} cached files.`,
    '',
    ...sections,
  ].join('\n\n')}`;
}

export function registerChatRoute(app: Express) {

app.post('/functions/v1/chat', async (req, res) => {
  if (!chatRateLimiter.isAllowed(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Too many requests. Please try again later.' });
  }

  // Basic request validation — reject obviously malformed payloads early.
  const { messages: rawMessages, model: rawModel } = req.body ?? {};
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return sendJson(res, 400, { error: 'messages must be a non-empty array' });
  }
  if (typeof rawModel !== 'string' || rawModel.trim().length === 0) {
    return sendJson(res, 400, { error: 'model must be a non-empty string' });
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
      provider,
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
      hermes_swarm_mode,
      repo_file_cache,
      repo_file_tree,
      agent_toolsets,
      custom_tools,
    } = req.body;

    const sanitizeFileTree = (tree: unknown): string[] =>
      Array.isArray(tree)
        ? tree.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
        : [];

    if (!provider) {
      return sendJson(res, 400, { error: 'provider is required' });
    }

    if (temperature !== undefined && (typeof temperature !== 'number' || temperature < 0 || temperature > 2)) {
      return sendJson(res, 400, { error: 'temperature must be a number between 0 and 2' });
    }

    if (max_tokens !== undefined && (typeof max_tokens !== 'number' || max_tokens < 1 || max_tokens > 200_000)) {
      return sendJson(res, 400, { error: 'max_tokens must be between 1 and 200,000' });
    }

    // Resolve API key
    let apiKey = '';
    if (provider === 'openclaw') {
      apiKey = '';
    } else {
      apiKey = api_key;
      if (!apiKey) {
        return sendJson(res, 400, { error: `API key is required for ${provider}` });
      }
    }

    // Validate repo accessibility before building system prompt.
    // If the repo doesn't exist or the PAT can't access it, strip repo context
    // so the AI doesn't waste turns trying to access a phantom repo.
    const rawGithubPAT = typeof req.body.github_pat === 'string' ? req.body.github_pat.trim() : req.body.github_pat;
    const githubPAT = isValidGitHubPAT(rawGithubPAT) ? rawGithubPAT : undefined;
    const requestedLocalRepoPath = resolveAttachedLocalRepoPath(activeRepo?.localPath);
    const hermesToolsetsRequested = parseToolsetList(hermes_toolsets);
    const hermesHasLocalRepoTools = Array.from(HERMES_LOCAL_REPO_TOOLSETS).some((toolset) => hermesToolsetsRequested.has(toolset));
    let resolvedLocalRepoPath = requestedLocalRepoPath;
    let repoAccessError: string | null = null;
    if (activeRepo && githubPAT && activeRepo.owner && activeRepo.name) {
      try {
        const repoCheckUrl = `https://api.github.com/repos/${encodeURIComponent(activeRepo.owner)}/${encodeURIComponent(activeRepo.name)}`;
        const validationAbort = new AbortController();
        const validationTimer = setTimeout(() => validationAbort.abort(), 5000);
        const repoCheckResp = await fetch(repoCheckUrl, {
          method: 'HEAD',
          headers: {
            Authorization: `Bearer ${githubPAT}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'CloudChat',
          },
          signal: validationAbort.signal,
        });
        clearTimeout(validationTimer);
        if (repoCheckResp.status === 404) {
          repoAccessError = `Repository ${activeRepo.owner}/${activeRepo.name} was not found. It may have been renamed, deleted, or your token may lack access. Please re-select the repository.`;
          console.warn(`[chat] Repo validation failed: ${activeRepo.owner}/${activeRepo.name} returned 404`);
        } else if (repoCheckResp.status === 401 || repoCheckResp.status === 403) {
          repoAccessError = `Your GitHub token does not have access to ${activeRepo.owner}/${activeRepo.name}. Check that the token has the 'repo' scope for private repositories.`;
          console.warn(`[chat] Repo validation failed: ${activeRepo.owner}/${activeRepo.name} returned ${repoCheckResp.status}`);
        }
      } catch (err) {
        // Don't block on validation timeout — let the AI handle it downstream
        console.warn(`[chat] Repo validation check failed (non-blocking): ${err instanceof Error ? err.message : err}`);
      }
    }

    if (provider === 'openclaw' && activeRepo && githubPAT && activeRepo.owner && activeRepo.name) {
      try {
        const clone = await ensureRepoClone({
          owner: activeRepo.owner,
          repo: activeRepo.name,
          pat: githubPAT,
          branch: activeRepo.default_branch || 'main',
        });
        resolvedLocalRepoPath = clone.path;
        repoAccessError = null;
      } catch (error) {
        repoAccessError = `CloudChat could not prepare a local checkout for ${activeRepo.owner}/${activeRepo.name}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const hermesUsesLocalCloneFallback = provider === 'hermes' && !!activeRepo && !githubPAT && !!resolvedLocalRepoPath;

    if (
      provider === 'hermes'
      && activeRepo
      && !githubPAT
      && !resolvedLocalRepoPath
    ) {
      repoAccessError = `Hermes needs either a GitHub token with access to ${activeRepo.owner}/${activeRepo.name} or a verified local clone path before it can inspect the repository.`;
    } else if (
      hermesUsesLocalCloneFallback
      && !hermesHasLocalRepoTools
    ) {
      repoAccessError = 'Hermes found the attached local clone, but Files or Terminal access is disabled. Enable a local Hermes toolset or attach a GitHub token for repo access.';
    } else if (
      provider === 'openclaw'
      && activeRepo
      && !resolvedLocalRepoPath
    ) {
      repoAccessError = `OpenClaw needs either a GitHub token with access to ${activeRepo.owner}/${activeRepo.name} or a verified local clone path before it can inspect the repository.`;
    }

    // If repo validation failed, return error to client so they can re-select
    if (repoAccessError) {
      return sendJson(res, 422, { error: repoAccessError });
    }

    // Build system prompt, appending repo context if activeRepo is present
    let effectiveSystemPrompt = system_prompt || '';
    if (activeRepo) {
      const repoFileTree = sanitizeFileTree(repo_file_tree);
      const repoEditIntent = !!repo_edit_intent;
      const repoTreeSummary = summarizeRepoTreeForPrompt(repoFileTree);
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
8. Only use exact file paths that appear in the repo tree or that are returned by a read_repo_file error as a possible match. Do not infer unlisted sibling paths or directory names.

${repoFileTree.length > 0
  ? `${repoTreeSummary}

Use the repository paths above to identify candidate files, and do NOT ask the user to provide file paths.

`
  : `If the repository file tree is missing, do not guess placeholder paths like \`.\`, \`/\`, \`src/main\`, \`server\`, \`client\`, or \`package.json\`. Wait for real repo-tree guidance before reading files.

`}${getRepoTurnIntentInstruction(repoEditIntent)}

All changes are staged for a PR — they are not applied directly to the repo.`;
      effectiveSystemPrompt = effectiveSystemPrompt
        ? `${effectiveSystemPrompt}\n\n${repoContext}`
        : repoContext;
      // Inject cached file contents so the model doesn't need to re-read them
      if (repo_file_cache && typeof repo_file_cache === 'object') {
        const cachedFilesPrompt = formatCachedFilesForPrompt(repo_file_cache as Record<string, unknown>);
        if (cachedFilesPrompt) {
          effectiveSystemPrompt += `\n\n${cachedFilesPrompt}`;
        }
      }

      if (resolvedLocalRepoPath) {
        effectiveSystemPrompt += `\n\n${buildLocalRepoAccessPrompt({
          provider,
          localRepoPath: resolvedLocalRepoPath,
          repoFullName: `${activeRepo.owner}/${activeRepo.name}`,
        })}`;
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
        cwd: resolvedLocalRepoPath ?? undefined,
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

    // githubPAT was already extracted and validated above (before system prompt building)
    if (activeRepo && rawGithubPAT && !githubPAT) {
      console.warn(`[chat] WARNING: github_pat provided but failed validation (prefix=${typeof rawGithubPAT === 'string' ? rawGithubPAT.slice(0, 8) : typeof rawGithubPAT}...) — repo tools will be unavailable`);
    }
    const hasServerRepoContext = !!(activeRepo && githubPAT);
    const shouldForwardHermesRepoContext = provider === 'hermes' && !!(activeRepo && githubPAT);
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
            repoFileTree: sanitizeFileTree(repo_file_tree),
            repoFileCache: repo_file_cache && typeof repo_file_cache === 'object' ? repo_file_cache : {},
            repoEditIntent: !!repo_edit_intent,
          },
          emitToolEvent,
        )
      : {};

    console.log(
      `[chat] provider=${provider} runtime=${runtimeProvider} model=${model} activeRepo=${activeRepo?.owner}/${activeRepo?.name || '-'} serverRepoTools=${hasServerRepoContext} hermesExecutionMode=${hermesExecutionMode ?? '-'} msgs=${messages?.length}`,
    );
    if (activeRepo && !githubPAT && !resolvedLocalRepoPath && (provider === 'hermes' || runtimeProvider === 'hermes')) {
        console.warn(`[chat] WARNING: activeRepo set (${activeRepo.owner}/${activeRepo.name}) but no github_pat in request body — Hermes won't be able to read repo files`);
    }

    // Swarm mode: Architect → Implementor → Reviewer pipeline
    if (provider === 'hermes' && runtimeProvider === 'hermes' && hermes_swarm_mode) {
      console.log(`[chat] Proxying Hermes swarm pipeline. model=${model}`);
      await proxyHermesSwarmToDataStream({
        req,
        res,
        apiKey,
        model,
        messages: normalizedChatInput.messages,
        temperature,
        topP: top_p,
        maxTokens: max_tokens,
        hermesToolsets: hermes_toolsets,
        activeRepo: shouldForwardHermesRepoContext ? activeRepo : undefined,
        githubPAT: shouldForwardHermesRepoContext ? githubPAT : undefined,
        repoFileTree: shouldForwardHermesRepoContext ? sanitizeFileTree(repo_file_tree) : undefined,
        customTools: Array.isArray(custom_tools) ? custom_tools : undefined,
      });
      return;
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
        activeRepo: shouldForwardHermesRepoContext ? activeRepo : undefined,
        githubPAT: shouldForwardHermesRepoContext ? githubPAT : undefined,
        hermesMiniMaxKey: hermes_minimax_key,
        repoFileTree: shouldForwardHermesRepoContext ? sanitizeFileTree(repo_file_tree) : undefined,
        customTools: Array.isArray(custom_tools) ? custom_tools : undefined,
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
              // Always send repo owner/name when a repo is active so the
              // hermes-bridge can provide proper error messages even without a PAT.
              ...(hermesExecutionMode === 'agent-loop' && activeRepo
                ? {
                    'X-Hermes-Repo-Owner': activeRepo.owner,
                    'X-Hermes-Repo-Name': activeRepo.name,
                    'X-Hermes-Repo-Edit-Intent': repo_edit_intent ? '1' : '0',
                  }
                : {}),
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
    console.log(`[chat] Starting streamText. maxTokens=${max_tokens ?? defaultMaxTokens} maxSteps=${useServerAgentLoop ? MAX_AGENT_STEPS : 1} tools=${hasTools ? Object.keys(allTools).join(',') : '(none)'} toolSafe=${isToolSafeProvider} localTools=${hasLocalTools}`);
    const result = streamText({
      model: aiModel,
      messages: normalizedChatInput.messages as CoreMessage[],
      temperature: temperature ?? 0.7,
      topP: top_p ?? 0.9,
      maxTokens: max_tokens ?? defaultMaxTokens,
      abortSignal: abortController.signal,
      ...(providerOptions ? { providerOptions } : {}),
      ...(hasTools ? { tools: allTools, toolCallStreaming: true } : {}),
      // Bound agent steps to prevent runaway tool-call loops. The cap is
      // configurable via the MAX_AGENT_STEPS env var (default 50).
      ...(hasTools && useServerAgentLoop ? { maxSteps: MAX_AGENT_STEPS } : {}),
      onFinish: () => {
        if (requestTimeout) {
          clearTimeout(requestTimeout);
        }
      },
    });

    // Use pipeDataStreamToResponse for proper Node.js streaming.
    // This avoids issues with toDataStreamResponse where the finish
    // message can be emitted before content for some providers.
    let streamData: StreamData | undefined;
    if (serverToolEvents.length > 0) {
      streamData = new StreamData();
      for (const event of serverToolEvents) {
        streamData.appendMessageAnnotation(event as unknown as JSONValue);
      }
      streamData.close();
    }
    result.pipeDataStreamToResponse(res, {
      headers: buildCorsHeaders(req.headers.origin),
      sendReasoning: true,
      data: streamData,
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

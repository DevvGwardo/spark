import type { Express } from 'express';
import { StreamData, streamText, tool, type CoreMessage, type CoreTool, type JSONValue } from 'ai';
import { z } from 'zod';
import { buildServerRepoTools, type ServerToolEvent } from '../agent-loop';
import {
  createProviderModel,
  getReasoningProviderOptions,
  resolveHermesExecutionMode,
  resolveHermesUseRuns,
  resolveRuntimeProvider,
  usesFirstPartyProviderSdk,
} from '../provider-config';
import { runOpenClawTurn } from '../openclaw';
import { resolveAttachedLocalRepoPath } from '../lib/github-utils';
import { ensureRepoClone } from '../repo-clone-manager';
import { getRepoTurnIntentInstruction } from '../../src/lib/repo-intent';
import { bindClientDisconnect } from '../http-disconnect';
import { normalizeChatMessages } from '../message-normalization';
import { isAbortLikeError } from '../direct-sse-proxy';
import { buildCorsHeaders, chatRateLimiter, getClientIp, sendJson } from '../lib/helpers';
import { logger } from '../lib/logger';
import {
  createSingleMessageDataStream,
  isValidGitHubPAT,
  normalizeLocalProviderError,
} from '../lib/github-utils';
import {
  proxyCompatibleProviderToDataStream,
  proxyHermesAgentLoopToDataStream,
  proxyHermesSwarmToDataStream,
  proxyHermesLoopToDataStream,
  shouldDirectProxyCompatibleProvider,
  cancelHermesRun,
  getActiveHermesRuns,
  getHermesRunPartialText,
  bridgeRepoRootHeaders,
} from '../lib/hermes';
import { buildLocalExecutionTools, parseAgentToolsets, getLocalToolsSystemPromptFragment, type ToolExecutionInfo } from '../local-tools';
import { MAX_AGENT_STEPS } from '../config';
import { ensureProfileExists, getProfileFromRequest } from '../lib/hermes-profiles';
import { approvalPolicyStore } from '../approval-engine';
import { buildUsageEvent } from '../lib/usage-events';
import { coreToolsToOpenAiFunctions } from '../lib/tool-schema';

// ─── /functions/v1/chat ──────────────────────────────────────────────────────

// ─── Server tool-call event synthesis ───────────────────────────────────────
// The fixed event contract (B1 emits these on the bridge paths; the server
// synthesizes them for server-executed tools on the streamText path):
//   tool_call_begin {type, call_id, name, ts}
//   tool_call_delta {type, call_id, output}
//   tool_call_end   {type, call_id, name, success, exit_code, duration_ms,
//                    output_truncated, output_truncated_lines}
// Structured execution info (real exit codes for shell tools) is reported by
// local-tools.ts via the onExecuted hook and keyed by toolCallId.

const TOOL_CALL_OUTPUT_MAX_CHARS = 15_000;

function truncateToolCallOutput(output: string): string {
  if (output.length <= TOOL_CALL_OUTPUT_MAX_CHARS) {
    return output;
  }
  return `${output.slice(0, TOOL_CALL_OUTPUT_MAX_CHARS)}\n… [output truncated]`;
}

function wrapToolWithCallEvents(
  name: string,
  coreTool: CoreTool,
  emit: (event: ServerToolEvent) => void,
  executionInfo: Map<string, Pick<ToolExecutionInfo, 'exitCode' | 'outputTruncated' | 'outputTruncatedLines'>>,
): CoreTool {
  const originalExecute = coreTool.execute;
  // Client-executed tools (artifact creators) have no server execute handler —
  // nothing to synthesize.
  if (!originalExecute) {
    return coreTool;
  }

  return {
    ...coreTool,
    execute: async (args, options) => {
      const callId = options?.toolCallId ?? `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const ts = Date.now();
      emit({ type: 'tool_call_begin', call_id: callId, name, ts });

      const startedAt = Date.now();
      let success = true;
      let output = '';
      let _thrown: unknown = null;
      try {
        const result = await originalExecute(args, options);
        output = typeof result === 'string' ? result : JSON.stringify(result ?? '');
        return result;
      } catch (error) {
        success = false;
        _thrown = error;
        output = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        const durationMs = Date.now() - startedAt;
        const info = executionInfo.get(callId);
        emit({ type: 'tool_call_delta', call_id: callId, output: truncateToolCallOutput(output) });
        emit({
          type: 'tool_call_end',
          call_id: callId,
          name,
          success,
          exit_code: info?.exitCode ?? null,
          duration_ms: durationMs,
          output_truncated: info?.outputTruncated ?? false,
          output_truncated_lines: info?.outputTruncatedLines ?? 0,
        });
        executionInfo.delete(callId);
      }
    },
  };
}

const PLAN_MODE_SYSTEM_PROMPT = `You are operating in PLAN MODE (read-only exploration).

RULES (strict):
- You MAY: read files, search code, analyze structure, inspect configs, run read-only commands
- You MAY NOT: write files, edit files, delete files, run mutating commands, apply patches
- You MAY NOT: use write_file, patch, or execute_code tools
- For the terminal tool, only run read-only commands (ls, cat, grep, find, git log, git diff, git status, etc.)
- Do NOT use shell redirects (>, >>) or destructive commands (rm, mv, chmod)

YOUR GOAL:
- Explore the codebase to understand the current state
- Produce a clear, actionable implementation plan
- Your plan should be "decision complete" — detailed enough for another engineer to implement without asking questions
- Structure your plan with: goal, files to modify, specific changes, and expected outcome

When you are done exploring and ready to present your plan, clearly mark it with a section header like "## Implementation Plan".`;

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

// Resolve a pending server-side tool approval (approval-engine). Mirrors the
// bridge's /v1/approvals/{id} contract so the client can use one flow for
// both ACP approvals (bridge) and streamText-path tool approvals (server).
// Bridge root + auth for ACP approval forwarding (mirrors hermes-admin.ts).
// 127.0.0.1 (not localhost): the bridge binds IPv4 loopback, and on
// IPv6-first resolvers `localhost` can resolve to ::1 → ECONNREFUSED.
const HERMES_BRIDGE_ROOT = (process.env.HERMES_BRIDGE_URL || 'http://127.0.0.1:3002').replace(/\/v1\/?$/, '');
function hermesBridgeTokenHeader(): Record<string, string> {
  const token = (process.env.HERMES_BRIDGE_TOKEN || '').trim();
  return token ? { 'X-Hermes-Bridge-Token': token } : {};
}

app.post('/api/hermes/approvals/:id', async (req, res) => {
  const { id } = req.params;
  const body = (req.body ?? {}) as { decision?: unknown; reason?: unknown };
  const decision = body.decision;
  if (decision !== 'approved' && decision !== 'approved_for_session' && decision !== 'denied') {
    return sendJson(res, 400, {
      error: 'decision must be one of: "approved", "approved_for_session", "denied"',
    });
  }
  const reason = typeof body.reason === 'string' && body.reason.length > 0 ? body.reason : undefined;
  const delivered = approvalPolicyStore.resolveApproval(id, decision, reason);
  if (delivered) {
    logger.info(`[approvals] Resolved approval ${id} decision=${decision}`);
    return sendJson(res, 200, { ok: true, approval_id: id, decision });
  }
  // Not a server-engine approval — bridge ACP payloads (acp-* ids) park in
  // the Python bridge, so forward there. The route above this one only knows
  // its own approvals; without this forward, browser contexts (no
  // electronAPI fallback) can never resolve an ACP tool permission.
  if (id.startsWith('acp-')) {
    const optionId = decision === 'approved'
      ? 'allow_once'
      : decision === 'approved_for_session'
        ? 'allow_session'
        : 'deny';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let upstream: Response;
      try {
        upstream = await fetch(`${HERMES_BRIDGE_ROOT}/v1/approvals/${encodeURIComponent(id)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(hermesBridgeTokenHeader()),
          },
          body: JSON.stringify({ option_id: optionId, ...(reason ? { reason } : {}) }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      const rawText = await upstream.text().catch(() => '');
      let payload: { error?: { message?: string }; [k: string]: unknown } = {};
      try {
        payload = rawText ? JSON.parse(rawText) as typeof payload : {};
      } catch {
        payload = {};
      }
      if (!upstream.ok) {
        const message = payload?.error?.message || rawText.trim().slice(0, 500) || `Bridge returned ${upstream.status}`;
        return sendJson(res, upstream.status, {
          error: message,
        });
      }
      logger.info(`[approvals] Forwarded ACP approval ${id} to bridge decision=${decision}`);
      return sendJson(res, 200, { ok: true, approval_id: id, decision });
    } catch (err) {
      logger.warn(`[approvals] Bridge forward failed for ${id}: ${err instanceof Error ? err.message : err}`);
      return sendJson(res, 502, { error: 'Bridge unreachable for ACP approval' });
    }
  }
  return sendJson(res, 404, { error: `Unknown or expired approval: ${id}` });
});

// Explicit cancel for a background-capable hermes run. The UI Stop button
// calls this — a plain client disconnect (window closed) intentionally does
// NOT stop the run; it continues server-side and persists its result.
app.post('/api/hermes/chat/cancel', (req, res) => {
  const { conversationId } = (req.body ?? {}) as { conversationId?: unknown };
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    return sendJson(res, 400, { error: 'conversationId must be a non-empty string' });
  }
  const cancelled = cancelHermesRun(conversationId);
  sendJson(res, 200, { cancelled });
});

// Conversations with hermes runs still active server-side (including runs
// whose client window has closed). The UI polls this to keep the sidebar
// status accurate and to re-hydrate a conversation when its run finishes.
app.get('/api/hermes/chat/active', (_req, res) => {
  sendJson(res, 200, { runs: getActiveHermesRuns() });
});

// In-flight output of a background run, polled by a reopened panel so the
// user sees the run progressing (and can Stop it) after a window close.
app.get('/api/hermes/chat/active/:conversationId', (req, res) => {
  const text = getHermesRunPartialText(req.params.conversationId);
  sendJson(res, 200, { active: text !== null, text: text ?? '' });
});

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
  // Set when the 5-minute watchdog (not the client) aborts the stream, so
  // the catch below can tell a timeout truncation apart from a clean abort.
  let requestTimedOut = false;
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
      hermes_provider,
      hermes_swarm_mode,
      hermes_loop_mode,
      planMode: rawPlanMode,
      repo_file_cache,
      repo_file_tree,
      agent_toolsets,
      custom_tools,
      hermes_use_runs,
      auto_approve: rawAutoApprove,
      continuing_approved_proposal: rawContinuingApprovedProposal,
    } = req.body;

    const planMode = rawPlanMode === true || rawPlanMode === 'true';
    // Per-conversation auto-approve for server-side approval gates (additive;
    // the client settings UI sends this when the user opts into auto-approve).
    const autoApprove = rawAutoApprove === true || rawAutoApprove === 'true';
    // The client only sends this after the user approved a repo proposal, so
    // the repo edits in this turn are sanctioned.
    const continuingApprovedProposal = rawContinuingApprovedProposal === true;
    // Stable identity for approval buckets, OpenClaw sessions, and hermes
    // runs. Anonymous turns (no conversation_id) used to share one 'default'
    // bucket — two tabs shared approval rules and leaked state — and OpenClaw
    // minted a random session per request, killing continuity. Mint one id
    // per anonymous request and return it so the client can adopt it.
    const effectiveConversationId =
      typeof conversation_id === 'string' && conversation_id.trim().length > 0
        ? conversation_id.trim()
        : `cloudchat-${(() => {
            const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
            if (c?.randomUUID) return c.randomUUID();
            return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
          })()}`;
    if (effectiveConversationId !== conversation_id) {
      res.setHeader('X-Hermes-Conversation-Id', effectiveConversationId);
    }
    const conversationKey = effectiveConversationId;
    if (autoApprove) {
      approvalPolicyStore.setAutoApprove(conversationKey, true);
    }

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
    if (provider === 'openclaw' || provider === 'hermes') {
      // These providers can use local credentials fallback - no API key required from client
      apiKey = api_key ?? '';
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

    // Fail fast with a clear error if a PAT was provided but failed format validation
    if (activeRepo && rawGithubPAT && !githubPAT) {
      // SECURITY: Do not log PAT content — only log that validation failed
      logger.warn(`[chat] WARNING: github_pat provided but failed format validation — returning 422`);
      return sendJson(res, 422, {
        error: `Your GitHub token format is invalid. CloudChat needs a valid GitHub Personal Access Token with access to ${activeRepo.owner}/${activeRepo.name} to read and edit repository files. Please re-enter your token in Settings → GitHub.`,
      });
    }

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
          logger.warn(`[chat] Repo validation failed: ${activeRepo.owner}/${activeRepo.name} returned 404`);
        } else if (repoCheckResp.status === 401 || repoCheckResp.status === 403) {
          repoAccessError = `Your GitHub token does not have access to ${activeRepo.owner}/${activeRepo.name}. Check that the token has the 'repo' scope for private repositories.`;
          logger.warn(`[chat] Repo validation failed: ${activeRepo.owner}/${activeRepo.name} returned ${repoCheckResp.status}`);
        }
      } catch (err) {
        // Don't block on validation timeout — let the AI handle it downstream
        logger.warn(`[chat] Repo validation check failed (non-blocking): ${err instanceof Error ? err.message : err}`);
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

    // Hermes repo mode: give the agent a real local checkout so it can run
    // builds/tests/audits (hermes-desktop parity). With a checkout present the
    // agent keeps terminal/files toolsets and works in a bridge git worktree of
    // this clone; without one it is reduced to GitHub-API-only tools and cannot
    // run a build. The clone is a managed shallow clone, cached across requests.
    if (
      provider === 'hermes'
      && activeRepo && githubPAT && activeRepo.owner && activeRepo.name
      && !resolvedLocalRepoPath
    ) {
      try {
        const clone = await ensureRepoClone({
          owner: activeRepo.owner,
          repo: activeRepo.name,
          pat: githubPAT,
          branch: activeRepo.default_branch || 'main',
        });
        resolvedLocalRepoPath = clone.path;
      } catch (error) {
        // Fall back to GitHub-API repo tools; the system prompt below tells
        // the agent it has no build capability rather than letting it guess.
        logger.warn(
          `[chat] Hermes local checkout unavailable for ${activeRepo.owner}/${activeRepo.name}: ${error instanceof Error ? error.message : String(error)} — falling back to GitHub repo tools`,
        );
      }
    }

    const hermesUsesLocalCloneFallback = provider === 'hermes' && !!activeRepo && !githubPAT && !!resolvedLocalRepoPath;

    if (activeRepo && !githubPAT && !resolvedLocalRepoPath) {
      repoAccessError = `Your GitHub token is missing or invalid. CloudChat needs a valid GitHub Personal Access Token with access to ${activeRepo.owner}/${activeRepo.name} to read and edit repository files. Please re-enter your token in Settings → GitHub.`;
    } else if (
      hermesUsesLocalCloneFallback
      && !hermesHasLocalRepoTools
    ) {
      repoAccessError = 'Hermes found the attached local clone, but Files or Terminal access is disabled. Enable a local Hermes toolset or attach a GitHub token for repo access.';
    }

    // If repo validation failed, return error to client so they can re-select
    if (repoAccessError) {
      return sendJson(res, 422, { error: repoAccessError });
    }

    // Build system prompt, appending repo context if activeRepo is present
    let effectiveSystemPrompt = system_prompt || '';
    const hasRepoAccess = !!(activeRepo && (githubPAT || resolvedLocalRepoPath));
    if (activeRepo && hasRepoAccess) {
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

    if (activeRepo && !hasRepoAccess) {
      // Repo selected but no PAT and no local clone — tell the agent about the
      // repo but do NOT promise tools it won't have.
      const limitedContext = `You are discussing the GitHub repository ${activeRepo.owner}/${activeRepo.name}. GitHub file access is not available for this request (no valid token configured). Answer based on any context provided by the user. Do not attempt to read files or use repo tools.`;
      effectiveSystemPrompt = effectiveSystemPrompt
        ? `${effectiveSystemPrompt}\n\n${limitedContext}`
        : limitedContext;
    }

    // Repo mode with no local checkout: the agent has GitHub repo tools but no
    // terminal/build tools. Tell it explicitly so audit-style requests (e.g. a
    // type-safety audit) produce a static review instead of "can't run a build".
    if (provider === 'hermes' && activeRepo && hasRepoAccess && !resolvedLocalRepoPath) {
      const noBuildNote = `No local checkout is available in this session, so you have no terminal or build tools. For requests that require running a build (type-safety audits, tests, lint, etc.), perform a static review of the relevant files instead and clearly note that the build could not be executed.`;
      effectiveSystemPrompt = effectiveSystemPrompt
        ? `${effectiveSystemPrompt}\n\n${noBuildNote}`
        : noBuildNote;
    }

    // STEP 4: Prepend plan mode system prompt when active
    if (planMode) {
      effectiveSystemPrompt = PLAN_MODE_SYSTEM_PROMPT + '\n\n' + effectiveSystemPrompt;
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
        sessionId: effectiveConversationId,
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
    const hasServerRepoContext = !!(activeRepo && githubPAT);
    const shouldForwardHermesRepoContext = provider === 'hermes' && !!(activeRepo && githubPAT);
    const activeHermesProfile = provider === 'hermes' ? getProfileFromRequest(req) : null;
    if (activeHermesProfile) {
      try {
        ensureProfileExists(activeHermesProfile);
      } catch (err) {
        logger.warn(`[chat] Failed to auto-provision Hermes profile ${activeHermesProfile}: ${err instanceof Error ? err.message : err}`);
      }
    }
    const runtimeProvider = resolveRuntimeProvider(provider, { activeRepo });
    const hermesExecutionMode =
      provider === 'hermes' && runtimeProvider === 'hermes'
        ? resolveHermesExecutionMode({ activeRepo, githubPAT })
        : null;
    const hermesUseRuns =
      provider === 'hermes' && runtimeProvider === 'hermes'
        ? resolveHermesUseRuns({
            envEnabled: process.env.HERMES_USE_RUNS === '1',
            headerValue: req.headers['x-hermes-use-runs'],
            bodyValue: hermes_use_runs,
          })
        : false;

    // Collect server tool events to inject into the data stream. Unlike the
    // old code (which drained an empty array before piping), the StreamData is
    // created up front and events are appended IN REAL TIME — tool execute
    // handlers run lazily during piping, so events emitted mid-stream now
    // actually reach the client as `data` parts.
    const serverToolEvents: ServerToolEvent[] = [];
    const streamData = new StreamData();
    let streamDataClosed = false;
    const closeStreamData = () => {
      if (streamDataClosed) {
        return;
      }
      streamDataClosed = true;
      try {
        streamData.close();
      } catch {
        // Already closed via another path.
      }
    };
    const emitToolEvent = (event: ServerToolEvent) => {
      serverToolEvents.push(event);
      if (!streamDataClosed) {
        try {
          // `data` part (code 2) — the client pre-scanner collects custom
          // fields from these; message_annotations (code 8) is NOT scanned.
          streamData.append(event as unknown as JSONValue);
        } catch {
          // Stream already closed (e.g. error during teardown) — drop.
        }
      }
    };

    // Structured execution info (exit codes etc.) reported by local-tools.ts,
    // keyed by toolCallId so the tool_call_end synthesizer can use it.
    const toolExecutionInfo = new Map<
      string,
      Pick<ToolExecutionInfo, 'exitCode' | 'outputTruncated' | 'outputTruncatedLines'>
    >();
    const onToolExecuted = (info: ToolExecutionInfo) => {
      toolExecutionInfo.set(info.toolCallId, {
        exitCode: info.exitCode,
        outputTruncated: info.outputTruncated,
        outputTruncatedLines: info.outputTruncatedLines,
      });
    };

    // Approval gate for server-executed tools (run_command, execute_python,
    // repo write tools). Safe commands and matching policy rules are allowed
    // silently by the engine; anything else parks the execution and emits an
    // approval_request custom field the client renders as a modal.
    const requestApproval = async (input: {
      tool: string;
      command?: string;
      cwd?: string;
      reason: string;
    }): Promise<'approved' | 'denied' | 'timed_out' | 'abort'> => {
      const isRepoWriteTool =
        input.tool === 'edit_repo_file' ||
        input.tool === 'create_repo_file' ||
        input.tool === 'delete_repo_file' ||
        input.tool === 'batch_edit_repo_files';
      return approvalPolicyStore.authorize({
        conversationId: conversationKey,
        tool: input.tool,
        command: input.command,
        cwd: input.cwd,
        reason: input.reason,
        // Repo writes are additionally auto-approved for the turn following an
        // approved proposal (the client's proposal modal already gated them).
        autoApprove: continuingApprovedProposal && isRepoWriteTool,
        emit: (payload) => emitToolEvent(payload as unknown as ServerToolEvent),
      });
    };

    // Build local execution tools (terminal, files, code_execution) for any provider
    const localToolsets = parseAgentToolsets(agent_toolsets);
    let localTools = buildLocalExecutionTools(localToolsets, {
      requestApproval,
      onExecuted: onToolExecuted,
    });
    const planModeFileTools = planMode
      ? { create_html_file: fileTools.create_html_file }
      : fileTools;

    // STEP 3: Filter mutating tools when plan mode is active
    if (planMode && Object.keys(localTools).length > 0) {
      const {
        run_command,
        execute_python,
        write_file,
        ...readOnlyTools
      } = localTools;
      void run_command;
      void execute_python;
      void write_file;
      localTools = readOnlyTools as typeof localTools;
    }

    const hasLocalTools = Object.keys(localTools).length > 0;

    // Append local tools context to system prompt (only for non-plan mode or read-only tools)
    if (hasLocalTools && !planMode) {
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
          { requestApproval },
        )
      : {};
    const filteredRepoTools = planMode
      ? (() => {
          const {
            edit_repo_file,
            create_repo_file,
            delete_repo_file,
            batch_edit_repo_files,
            ...planModeRepoTools
          } = repoTools;
          void edit_repo_file;
          void create_repo_file;
          void delete_repo_file;
          void batch_edit_repo_files;
          return planModeRepoTools;
        })()
      : repoTools;

    logger.info(
      `[chat] provider=${provider} runtime=${runtimeProvider} model=${model} activeRepo=${activeRepo?.owner}/${activeRepo?.name || '-'} serverRepoTools=${hasServerRepoContext} hermesExecutionMode=${hermesExecutionMode ?? '-'} hermesUseRuns=${hermesUseRuns} msgs=${messages?.length}`,
    );
    if (activeRepo && !githubPAT && !resolvedLocalRepoPath) {
        logger.warn(`[chat] WARNING: activeRepo set (${activeRepo.owner}/${activeRepo.name}) but no valid github_pat in request body — repo tools unavailable`);
    }

    // Loop mode: rerun the agent until a judge verdict says the goal is met,
    // bounded by a max-iteration cap and an optional time budget.
    if (
      provider === 'hermes' &&
      runtimeProvider === 'hermes' &&
      hermes_loop_mode &&
      typeof hermes_loop_mode === 'object'
    ) {
      const loopConfig = {
        maxIterations: Number((hermes_loop_mode as { max_iterations?: unknown }).max_iterations) || 5,
        timeBudgetMinutes: Number((hermes_loop_mode as { time_budget_minutes?: unknown }).time_budget_minutes) || null,
      };
      logger.info(
        `[chat] Proxying Hermes loop mode. model=${model} maxIterations=${loopConfig.maxIterations} timeBudget=${loopConfig.timeBudgetMinutes ?? '-'}m`,
      );
      await proxyHermesLoopToDataStream({
        req,
        res,
        apiKey,
        model,
        messages: normalizedChatInput.messages,
        loop: loopConfig,
        temperature,
        topP: top_p,
        maxTokens: max_tokens,
        hermesToolsets: hermes_toolsets,
        hermesProvider: hermes_provider,
        repoEditIntent: !!repo_edit_intent,
        activeRepo: shouldForwardHermesRepoContext ? activeRepo : undefined,
        githubPAT: shouldForwardHermesRepoContext ? githubPAT : undefined,
        hermesWorktree: !!resolvedLocalRepoPath,
        repoRoot: resolvedLocalRepoPath ?? undefined,
        hermesMiniMaxKey: hermes_minimax_key,
        repoFileTree: shouldForwardHermesRepoContext ? sanitizeFileTree(repo_file_tree) : undefined,
        customTools: Array.isArray(custom_tools) ? custom_tools : undefined,
        activeProfile: activeHermesProfile ?? undefined,
        conversationId: effectiveConversationId,
        // Real system role on every iteration — the normalized (fake-user)
        // copy only leads iteration 1, so follow-up turns and the judge
        // would otherwise run with no system prompt at all.
        systemPrompt: effectiveSystemPrompt || undefined,
      });
      return;
    }

    // Swarm mode: Architect → Implementor → Reviewer pipeline
    if (provider === 'hermes' && runtimeProvider === 'hermes' && hermes_swarm_mode) {
      logger.info(`[chat] Proxying Hermes swarm pipeline. model=${model}`);
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
        hermesProvider: hermes_provider,
        repoEditIntent: !!repo_edit_intent,
        activeRepo: shouldForwardHermesRepoContext ? activeRepo : undefined,
        githubPAT: shouldForwardHermesRepoContext ? githubPAT : undefined,
        hermesWorktree: !!resolvedLocalRepoPath,
        repoRoot: resolvedLocalRepoPath ?? undefined,
        hermesMiniMaxKey: hermes_minimax_key,
        reasoningEffort: typeof reasoning_effort === 'string' ? reasoning_effort : undefined,
        planMode,
        repoFileTree: shouldForwardHermesRepoContext ? sanitizeFileTree(repo_file_tree) : undefined,
        customTools: Array.isArray(custom_tools) ? custom_tools : undefined,
        activeProfile: activeHermesProfile ?? undefined,
        conversationId: effectiveConversationId,
      });
      return;
    }

    if (
      provider === 'hermes'
      && runtimeProvider === 'hermes'
      && (hermesExecutionMode === 'agent-loop' || hermesExecutionMode === 'acp')
    ) {
      logger.info(`[chat] Proxying Hermes ${hermesExecutionMode} directly to AI SDK data stream. model=${model}`);
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
        hermesProvider: hermes_provider,
        repoEditIntent: !!repo_edit_intent,
        activeRepo: shouldForwardHermesRepoContext ? activeRepo : undefined,
        githubPAT: shouldForwardHermesRepoContext ? githubPAT : undefined,
        hermesWorktree: !!resolvedLocalRepoPath,
        repoRoot: resolvedLocalRepoPath ?? undefined,
        hermesMiniMaxKey: hermes_minimax_key,
        repoFileTree: shouldForwardHermesRepoContext ? sanitizeFileTree(repo_file_tree) : undefined,
        customTools: Array.isArray(custom_tools) ? custom_tools : undefined,
        activeProfile: activeHermesProfile ?? undefined,
        conversationId: effectiveConversationId,
        reasoningEffort: typeof reasoning_effort === 'string' ? reasoning_effort : undefined,
        hermesUseRuns,
        executionMode: hermesExecutionMode,
        // Plan mode: the bridge restricts itself to read-only exploration and
        // the server strips mutating tools from forwarded definitions.
        planMode,
      });
      return;
    }

    if (shouldDirectProxyCompatibleProvider(provider, hasServerRepoContext) && !hasLocalTools) {
      logger.info(`[chat] Proxying ${provider} directly to AI SDK data stream. model=${model} planMode=${planMode ? '1' : '0'}`);
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
        // Plan mode: forward only the read-only tool set (artifact creators)
        // upstream; mutating/terminal tools are never defined.
        ...(planMode
          ? {
              planMode: true,
              planModeTools: coreToolsToOpenAiFunctions(planModeFileTools as Record<string, CoreTool>),
            }
          : {}),
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
              ...(activeHermesProfile ? { 'X-Hermes-Profile': activeHermesProfile } : {}),
              // Always send repo owner/name when a repo is active so the
              // hermes-bridge can provide proper error messages even without a PAT.
              // Both agent-loop AND acp need checkout context (acp most of all —
              // it spawns its session cwd from these headers).
              ...((hermesExecutionMode === 'agent-loop' || hermesExecutionMode === 'acp') && activeRepo
                ? {
                    'X-Hermes-Repo-Owner': activeRepo.owner,
                    'X-Hermes-Repo-Name': activeRepo.name,
                    'X-Hermes-Repo-Edit-Intent': repo_edit_intent ? '1' : '0',
                  }
                : {}),
              // SECURITY: X-Hermes-Github-PAT is forwarded to the Hermes bridge.
              // The bridge must treat this header as sensitive — never log it,
              // and clear it from memory immediately after use.
              ...((hermesExecutionMode === 'agent-loop' || hermesExecutionMode === 'acp') && activeRepo && githubPAT ? {
                'X-Hermes-Github-PAT': githubPAT,
              } : {}),
              ...(resolvedLocalRepoPath ? { 'X-Hermes-Worktree': '1' } : {}),
              ...bridgeRepoRootHeaders(resolvedLocalRepoPath ?? undefined),
              ...{ 'X-Hermes-Conversation-Id': effectiveConversationId },
            }
          : undefined,
      });
    } catch (error) {
      logger.error(`[chat] Failed to create provider model: ${error instanceof Error ? error.message : error}`);
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
        logger.warn('[chat] Request timeout — aborting after 5 minutes');
        requestTimedOut = true;
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
    const includeBaseTools = hasServerRepoContext || isToolSafeProvider || hasLocalTools || planMode;
    const allTools = {
      ...(includeBaseTools ? planModeFileTools : {}),
      ...filteredRepoTools,
      ...localTools,
    };
    // Synthesize tool_call_begin/delta/end for every server-executed tool
    // (repo tools + local execution tools; artifact creators have no server
    // execute handler and are skipped). Real exit codes come from
    // local-tools.ts via toolExecutionInfo.
    const wrappedTools: Record<string, CoreTool> = {};
    for (const [name, coreTool] of Object.entries(allTools)) {
      wrappedTools[name] = wrapToolWithCallEvents(name, coreTool, emitToolEvent, toolExecutionInfo);
    }
    const useServerAgentLoop = hasServerRepoContext || hasLocalTools;
    const hasTools = Object.keys(allTools).length > 0;
    logger.info(`[chat] Starting streamText. maxTokens=${max_tokens ?? defaultMaxTokens} maxSteps=${useServerAgentLoop ? MAX_AGENT_STEPS : 1} tools=${hasTools ? Object.keys(allTools).join(',') : '(none)'} toolSafe=${isToolSafeProvider} localTools=${hasLocalTools}`);
    const result = streamText({
      model: aiModel,
      messages: normalizedChatInput.messages as CoreMessage[],
      temperature: temperature ?? 0.7,
      topP: top_p ?? 0.9,
      maxTokens: max_tokens ?? defaultMaxTokens,
      abortSignal: abortController.signal,
      ...(providerOptions ? { providerOptions } : {}),
      ...(hasTools ? { tools: wrappedTools, toolCallStreaming: true } : {}),
      // Bound agent steps to prevent runaway tool-call loops. The cap is
      // configurable via the MAX_AGENT_STEPS env var (default 50).
      ...(hasTools && useServerAgentLoop ? { maxSteps: MAX_AGENT_STEPS } : {}),
      onFinish: (finishResult) => {
        if (requestTimeout) {
          clearTimeout(requestTimeout);
        }
        if (finishResult.usage) {
          logger.info(JSON.stringify({
            type: 'usage',
            promptTokens: finishResult.usage.promptTokens,
            completionTokens: finishResult.usage.completionTokens,
            totalTokens: finishResult.usage.totalTokens,
          }));
          // Trailing `usage` custom field (contract: once at stream end).
          const usageEvent = buildUsageEvent(
            {
              inputTokens: finishResult.usage.promptTokens,
              outputTokens: finishResult.usage.completionTokens,
            },
            model,
          );
          emitToolEvent(usageEvent as unknown as ServerToolEvent);
        }
        // All tool execute handlers have run by now — the StreamData carries
        // every event appended during execution; closing it ends the merged
        // data stream after the main stream completes.
        closeStreamData();
      },
    });

    // Use pipeDataStreamToResponse for proper Node.js streaming.
    // This avoids issues with toDataStreamResponse where the finish
    // message can be emitted before content for some providers.
    result.pipeDataStreamToResponse(res, {
      headers: buildCorsHeaders(req.headers.origin),
      sendReasoning: true,
      data: streamData,
      getErrorMessage: (error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[chat] Stream error: ${msg}`);
        // Post-headers failures previously vanished: the stream just ended
        // and the in-flight tool call never got a result. Emit an error part
        // so the client renders the failure instead of a hung tool card.
        emitToolEvent({
          type: 'error',
          message: requestTimedOut ? `Request timed out after 5 minutes: ${msg}` : msg,
        });
        closeStreamData();
        return msg;
      },
    });
  } catch (err: unknown) {
    if (requestTimeout) {
      clearTimeout(requestTimeout);
    }

    if ((disconnect.isDisconnected() || abortController.signal.aborted) && isAbortLikeError(err)) {
      // Timeouts abort the signal too — log them distinctly instead of
      // masquerading as a clean client abort.
      if (requestTimedOut && !disconnect.isDisconnected()) {
        logger.warn('[chat] Request timed out after 5 minutes (stream truncated, error part emitted)');
      }
      return;
    }

    logger.error(`chat error: ${err instanceof Error ? err.message : String(err)}`);

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

    logger.error(`[chat] Request failed: status=${status} error=${errorMessage} provider=${req.body?.provider} model=${req.body?.model}`);

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

import express from 'express';
import cors from 'cors';
import { formatDataStreamPart, generateText, streamText, tool, type DataStreamWriter } from 'ai';
import { buildServerRepoTools, SERVER_AGENT_MAX_STEPS, type ServerToolEvent } from './agent-loop';
import { z } from 'zod';
import { createOrchestrateHandler } from './orchestrator';
import {
  ANTHROPIC_COMPATIBLE,
  createProviderModel,
  getModelDiscoveryHeaders,
  getReasoningProviderOptions,
  getProviderHeaders,
  HERMES_TOOL_CAPABLE_MODELS,
  MODEL_DISCOVERY_URLS,
  OPENAI_COMPATIBLE,
  resolveHermesExecutionMode,
  resolveRuntimeProvider,
  sanitizeCompatibleSseLine,
  VALIDATION_MODELS,
} from './provider-config';
import { getOpenClawModels, runOpenClawTurn } from './openclaw';
import { verifyRepoChanges, generatePrMetadata, type VerificationFileChange } from './repo-verifier';
import { ensureRepoClone, forkRepository, getManagedRepoClone } from './repo-clone-manager';
import { getRepoTurnIntentInstruction } from '../src/lib/repo-intent';
import { registerChatStoreRoutes } from './chat-store';
import { bindClientDisconnect } from './http-disconnect';
import { normalizeChatMessages } from './message-normalization';
import {
  isAbortLikeError,
  proxySseToDataStream,
  type NormalizedProxyEvent,
  type ProxyFinishReason,
  type ProxyUsage,
} from './direct-sse-proxy';

// ─── Shared helpers ──────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'app://.',  // Electron custom protocol
]);

function getCorsOrigin(requestOrigin: string | undefined): string {
  if (requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)) {
    return requestOrigin;
  }
  // For Electron file:// or same-origin requests
  return 'http://localhost:5173';
}

function buildCorsHeaders(requestOrigin: string | undefined) {
  return {
    'Access-Control-Allow-Origin': getCorsOrigin(requestOrigin),
    'Access-Control-Allow-Headers': 'authorization, content-type',
  };
}

function sendJson(res: express.Response, status: number, body: unknown) {
  res.status(status).json(body);
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────

class RateLimiter {
  private requests = new Map<string, number[]>();

  constructor(private windowMs: number, private maxRequests: number) {}

  isAllowed(key: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];
    const filtered = timestamps.filter(t => now - t < this.windowMs);
    if (filtered.length >= this.maxRequests) return false;
    filtered.push(now);
    this.requests.set(key, filtered);
    return true;
  }
}

const chatRateLimiter = new RateLimiter(60_000, 30);       // 30 requests per minute
const validateKeyRateLimiter = new RateLimiter(60_000, 10); // 10 requests per minute

function getClientIp(req: express.Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
}

// ─── GitHub PAT Validation ───────────────────────────────────────────────────

function isValidGitHubPAT(pat: unknown): pat is string {
  if (typeof pat !== 'string') return false;
  // GitHub PATs: ghp_, github_pat_, gho_, ghs_, ghr_ prefixes
  return /^(ghp_|github_pat_|gho_|ghs_|ghr_)[a-zA-Z0-9_]{1,255}$/.test(pat);
}

interface GitHubRepoPayload {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch: string;
  html_url: string;
  fork: boolean;
  owner: {
    login: string;
    avatar_url: string | null;
  };
  permissions?: {
    pull?: boolean;
    push?: boolean;
    admin?: boolean;
  };
  stargazers_count?: number;
  forks_count?: number;
  language?: string | null;
  localClone: {
    exists: boolean;
    path: string | null;
  };
}

interface GitHubIssuePayload {
  id: number;
  number: number;
  title: string;
  body: string;
  html_url: string;
  state: string;
  comments: number;
  created_at: string;
  updated_at: string;
  user: {
    login: string;
    avatar_url: string | null;
  };
  labels: Array<{
    id: number;
    name: string;
    color: string;
    description: string | null;
  }>;
}

function getUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function encodeGitHubContentPath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildGitHubContentsUrl(
  owner: string,
  repo: string,
  path = '',
  ref?: string,
): string {
  const suffix = (() => {
    const encodedPath = encodeGitHubContentPath(path);
    return encodedPath ? `/${encodedPath}` : '';
  })();
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${suffix}`,
  );
  if (ref) {
    url.searchParams.set('ref', ref);
  }
  return url.toString();
}

async function withLocalClone(repo: {
  id?: number;
  name?: string;
  full_name?: string;
  private?: boolean;
  description?: string | null;
  default_branch?: string;
  html_url?: string;
  fork?: boolean;
  owner?: { login?: string; avatar_url?: string | null };
  permissions?: { pull?: boolean; push?: boolean; admin?: boolean };
  stargazers_count?: number;
  forks_count?: number;
  language?: string | null;
}): Promise<GitHubRepoPayload> {
  const owner = repo.owner?.login || repo.full_name?.split('/')[0] || '';
  const name = repo.name || repo.full_name?.split('/')[1] || '';
  const localClone = owner && name
    ? await getManagedRepoClone(owner, name)
    : { exists: false, path: null };

  return {
    id: repo.id || 0,
    name,
    full_name: repo.full_name || `${owner}/${name}`,
    private: !!repo.private,
    description: repo.description || null,
    default_branch: repo.default_branch || 'main',
    html_url: repo.html_url || `https://github.com/${owner}/${name}`,
    fork: !!repo.fork,
    owner: {
      login: owner,
      avatar_url: repo.owner?.avatar_url || null,
    },
    permissions: repo.permissions,
    stargazers_count: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : undefined,
    forks_count: typeof repo.forks_count === 'number' ? repo.forks_count : undefined,
    language: repo.language ?? null,
    localClone,
  };
}

function toGitHubIssue(issue: {
  id?: number;
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  user?: { login?: string; avatar_url?: string | null };
  labels?: Array<{ id?: number; name?: string; color?: string; description?: string | null }>;
}): GitHubIssuePayload {
  return {
    id: issue.id || 0,
    number: issue.number || 0,
    title: issue.title || 'Untitled issue',
    body: issue.body || '',
    html_url: issue.html_url || '',
    state: issue.state || 'open',
    comments: issue.comments || 0,
    created_at: issue.created_at || new Date(0).toISOString(),
    updated_at: issue.updated_at || new Date(0).toISOString(),
    user: {
      login: issue.user?.login || 'unknown',
      avatar_url: issue.user?.avatar_url || null,
    },
    labels: Array.isArray(issue.labels)
      ? issue.labels.map((label) => ({
          id: label.id || 0,
          name: label.name || '',
          color: label.color || '94a3b8',
          description: label.description || null,
        }))
      : [],
  };
}

function normalizeLocalProviderError(provider: string | undefined, message: string) {
  const lower = message.toLowerCase();

  if (
    provider === 'hermes'
    && (lower.includes('cannot connect to api') || lower.includes('hermes bridge is not reachable'))
  ) {
    return {
      status: 503,
      error:
        `Hermes bridge is not reachable at ${OPENAI_COMPATIBLE.hermes}. ` +
        'Start hermes-bridge/main.py and try again.',
    };
  }

  if (provider === 'openclaw' && lower.includes('openclaw cli not found')) {
    return {
      status: 503,
      error:
        'OpenClaw agent is not available. Ensure the OpenClaw CLI is installed and accessible, then try again.',
    };
  }

  return null;
}

const REPO_ACTIVITY_DAYS = 30;
const REPO_ACTIVITY_COMMITS_PER_PAGE = 100;
const REPO_ACTIVITY_MAX_PAGES = 20;

function formatUtcDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function hasGitHubNextPage(linkHeader: string | null): boolean {
  return typeof linkHeader === 'string' && /rel="next"/.test(linkHeader);
}

async function fetchRecentRepoActivity(
  owner: string,
  repo: string,
  headers: Record<string, string>,
): Promise<{ days: number[]; totalCommits: number; commitsCapped: boolean; openedIssues: number; openedPullRequests: number }> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const bucketDates = Array.from({ length: REPO_ACTIVITY_DAYS }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - (REPO_ACTIVITY_DAYS - 1 - index));
    return date;
  });
  const bucketKeys = bucketDates.map(formatUtcDateKey);
  const dayCounts = new Map(bucketKeys.map((key) => [key, 0]));
  const since = new Date(bucketDates[0] ?? today);
  const until = new Date(today);
  until.setUTCHours(23, 59, 59, 999);
  const createdSince = formatUtcDateKey(since);

  const safeFetchCount = async (query: string): Promise<number> => {
    try {
      return await fetchGitHubSearchTotalCount(query, headers);
    } catch {
      return 0;
    }
  };

  // Fetch commits (paginated) and search counts in parallel so that
  // the search API calls aren't blocked behind 20 pages of commit requests
  const commitsFetcher = async () => {
    let capped = false;
    for (let page = 1; page <= REPO_ACTIVITY_MAX_PAGES; page += 1) {
      const commitsUrl = new URL(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`,
      );
      commitsUrl.searchParams.set('since', since.toISOString());
      commitsUrl.searchParams.set('until', until.toISOString());
      commitsUrl.searchParams.set('per_page', String(REPO_ACTIVITY_COMMITS_PER_PAGE));
      commitsUrl.searchParams.set('page', String(page));

      const commitsResponse = await fetch(commitsUrl.toString(), { headers });

      if (commitsResponse.status === 409) {
        return { capped: false };
      }

      if (!commitsResponse.ok) {
        const error = await commitsResponse.text();
        throw new Error(`GitHub API error: ${error}`);
      }

      const commits = (await commitsResponse.json()) as Array<{
        commit?: { committer?: { date?: string | null } | null; author?: { date?: string | null } | null } | null;
      }>;

      for (const entry of commits) {
        const rawDate = entry.commit?.committer?.date || entry.commit?.author?.date;
        if (!rawDate) {
          continue;
        }
        const date = new Date(rawDate);
        if (Number.isNaN(date.getTime())) {
          continue;
        }
        const key = formatUtcDateKey(date);
        if (dayCounts.has(key)) {
          dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1);
        }
      }

      if (commits.length < REPO_ACTIVITY_COMMITS_PER_PAGE || !hasGitHubNextPage(commitsResponse.headers.get('link'))) {
        break;
      }
      if (page === REPO_ACTIVITY_MAX_PAGES) {
        capped = true;
      }
    }
    return { capped };
  };

  const [commitsResult, openedIssues, openedPullRequests] = await Promise.all([
    commitsFetcher(),
    safeFetchCount(`repo:${owner}/${repo} is:issue created:>=${createdSince}`),
    safeFetchCount(`repo:${owner}/${repo} is:pr created:>=${createdSince}`),
  ]);

  const days = bucketKeys.map((key) => dayCounts.get(key) ?? 0);
  const totalCommits = days.reduce((sum, count) => sum + count, 0);

  return { days, totalCommits, commitsCapped: commitsResult.capped, openedIssues, openedPullRequests };
}

async function fetchGitHubSearchTotalCount(
  query: string,
  headers: Record<string, string>,
): Promise<number> {
  const url = new URL('https://api.github.com/search/issues');
  url.searchParams.set('q', query);
  url.searchParams.set('per_page', '1');

  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error: ${error}`);
  }

  const result = await response.json() as { total_count?: number };
  return typeof result.total_count === 'number' ? result.total_count : 0;
}

async function fetchGitHubRepoTree(
  owner: string,
  repo: string,
  branch: string,
  headers: Record<string, string>,
) {
  const encodedBranch = encodeURIComponent(branch);
  const branchResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/branches/${encodedBranch}`,
    { headers },
  );

  let treeSha: string | null = null;
  if (branchResponse.ok) {
    const branchData = await branchResponse.json() as {
      commit?: { commit?: { tree?: { sha?: string } } }
    };
    treeSha = branchData.commit?.commit?.tree?.sha ?? null;
  }

  const treeTarget = treeSha ?? encodedBranch;
  const treeResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${treeTarget}?recursive=1`,
    { headers },
  );

  if (!treeResponse.ok) {
    const error = await treeResponse.text();
    return {
      ok: false as const,
      status: treeResponse.status,
      error: `GitHub API error: ${error}`,
    };
  }

  const treeData = await treeResponse.json() as {
    tree: Array<{ path: string; type: string; size?: number; sha: string }>;
    truncated: boolean;
  };

  const items = treeData.tree
    .filter((item: { type: string }) => item.type === 'blob' || item.type === 'tree')
    .map((item: { path: string; type: string; size?: number; sha: string }) => ({
      path: item.path,
      type: item.type === 'tree' ? 'dir' : 'file',
      size: item.size || 0,
      sha: item.sha,
    }));

  return {
    ok: true as const,
    items,
    truncated: treeData.truncated,
  };
}

function createSingleMessageDataStream(text: string, usage?: { input?: number; output?: number; total?: number }) {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(formatDataStreamPart('text', text)));
      controller.enqueue(
        encoder.encode(
          formatDataStreamPart('finish_message', {
            finishReason: 'stop',
            usage: {
              promptTokens: usage?.input ?? 0,
              completionTokens: usage?.output ?? 0,
              totalTokens: usage?.total ?? (usage?.input ?? 0) + (usage?.output ?? 0),
            },
          }),
        ),
      );
      controller.close();
    },
  });
}

const DIRECT_COMPAT_PROXY_PROVIDERS = new Set([
  'minimax',
  'minimax-payg',
  'kimi',
  'kimi-coding',
]);

export function shouldDirectProxyCompatibleProvider(provider: string, hasServerRepoContext: boolean): boolean {
  return DIRECT_COMPAT_PROXY_PROVIDERS.has(provider) && !hasServerRepoContext;
}

function getCompatibleProviderChatUrl(provider: string): string {
  if (provider === 'kimi') {
    return 'https://api.moonshot.cn/v1/chat/completions';
  }

  if (provider === 'kimi-coding') {
    return 'https://api.kimi.com/coding/v1/chat/completions';
  }

  return `${OPENAI_COMPATIBLE[provider]}/chat/completions`;
}

function normalizeHermesTextPart(part: unknown): string {
  if (typeof part === 'string') {
    return part;
  }

  if (!part || typeof part !== 'object') {
    return '';
  }

  const record = part as {
    text?: unknown;
    content?: unknown;
    value?: unknown;
  };

  if (typeof record.text === 'string') {
    return record.text;
  }

  if (record.text && typeof record.text === 'object') {
    const nestedText = (record.text as { value?: unknown }).value;
    if (typeof nestedText === 'string') {
      return nestedText;
    }
  }

  if (typeof record.content === 'string') {
    return record.content;
  }

  if (typeof record.value === 'string') {
    return record.value;
  }

  return '';
}

function extractHermesDeltaText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part) => normalizeHermesTextPart(part)).join('');
  }

  return normalizeHermesTextPart(content);
}

function normalizeHermesFinishReason(reason: unknown): ProxyFinishReason {
  if (reason === 'tool_calls') {
    return 'tool-calls';
  }

  if (reason === 'stop' || reason === 'length' || reason === 'tool-calls') {
    return reason;
  }

  // Some OpenRouter models (e.g. Llama, Mistral) return non-standard values
  // like 'end_turn' or 'eos' instead of 'stop'. Map them so the client-side
  // auto-continue logic sees a clean 'stop' instead of 'unknown'.
  if (reason === 'end_turn' || reason === 'eos' || reason === 'max_tokens') {
    return reason === 'max_tokens' ? 'length' : 'stop';
  }

  return 'unknown';
}

function normalizeHermesUsage(usage: unknown): ProxyUsage {
  const record = usage && typeof usage === 'object'
    ? usage as {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
      }
    : {};

  const promptTokens = typeof record.prompt_tokens === 'number' ? record.prompt_tokens : 0;
  const completionTokens = typeof record.completion_tokens === 'number' ? record.completion_tokens : 0;
  const totalTokens = typeof record.total_tokens === 'number'
    ? record.total_tokens
    : promptTokens + completionTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function extractHermesChoiceText(choice: {
  delta?: { content?: unknown };
  message?: { content?: unknown };
}): string {
  const deltaText = extractHermesDeltaText(choice.delta?.content);
  if (deltaText) {
    return deltaText;
  }
  return extractHermesDeltaText(choice.message?.content);
}

function normalizeHermesAgentLoopPayload(payload: string): NormalizedProxyEvent | null {
  const parsed = JSON.parse(payload) as {
    usage?: unknown;
    tool_activity?: unknown;
    server_tool_event?: unknown;
    agent_status?: unknown;
    choices?: Array<{
      finish_reason?: unknown;
      delta?: {
        content?: unknown;
        tool_activity?: unknown;
        server_tool_event?: unknown;
        agent_status?: unknown;
      };
      message?: {
        content?: unknown;
      };
    }>;
  };

  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  const data: Record<string, unknown>[] = [];

  if (choice?.delta?.tool_activity && typeof choice.delta.tool_activity === 'object') {
    data.push({ type: 'hermes_tool_activity', activity: choice.delta.tool_activity as Record<string, unknown> });
  }
  if (choice?.delta?.server_tool_event && typeof choice.delta.server_tool_event === 'object') {
    data.push(choice.delta.server_tool_event as Record<string, unknown>);
  }
  if (choice?.delta?.agent_status && typeof choice.delta.agent_status === 'object') {
    data.push({ type: 'agent_status', status: choice.delta.agent_status as Record<string, unknown> });
  }
  if (parsed.tool_activity && typeof parsed.tool_activity === 'object') {
    data.push({ type: 'hermes_tool_activity', activity: parsed.tool_activity as Record<string, unknown> });
  }
  if (parsed.server_tool_event && typeof parsed.server_tool_event === 'object') {
    data.push(parsed.server_tool_event as Record<string, unknown>);
  }
  if (parsed.agent_status && typeof parsed.agent_status === 'object') {
    data.push({ type: 'agent_status', status: parsed.agent_status as Record<string, unknown> });
  }

  return {
    usage: normalizeHermesUsage(parsed.usage),
    finishReason: choice?.finish_reason !== undefined && choice?.finish_reason !== null
      ? normalizeHermesFinishReason(choice.finish_reason)
      : undefined,
    text: choice ? extractHermesChoiceText(choice) : '',
    data,
  };
}

function normalizeCompatibleProviderPayload(provider: string, payload: string): NormalizedProxyEvent | null {
  const sanitizedPayload = sanitizeCompatibleSseLine(provider, `data: ${payload}`).slice(6).trim();
  const parsed = JSON.parse(sanitizedPayload) as {
    error?: { message?: string };
    base_resp?: { status_code?: number; status_msg?: string };
    usage?: unknown;
    choices?: Array<{
      finish_reason?: unknown;
      delta?: { content?: unknown };
      message?: { content?: unknown };
    }>;
  };

  if (parsed.base_resp?.status_code && parsed.base_resp.status_code !== 0) {
    throw new Error(parsed.base_resp.status_msg || `${provider} API error`);
  }

  if (parsed.error?.message) {
    throw new Error(parsed.error.message);
  }

  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  if (!choice) {
    return {
      usage: normalizeHermesUsage(parsed.usage),
    };
  }

  return {
    usage: normalizeHermesUsage(parsed.usage),
    finishReason: choice.finish_reason !== undefined && choice.finish_reason !== null
      ? normalizeHermesFinishReason(choice.finish_reason)
      : undefined,
    text: extractHermesChoiceText(choice),
  };
}

async function proxyHermesAgentLoopToDataStream(input: {
  req: express.Request;
  res: express.Response;
  apiKey: string;
  model: string;
  messages: unknown[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  hermesToolsets?: string | null;
  repoEditIntent?: boolean;
  activeRepo?: { owner?: string; name?: string } | null;
  githubPAT?: string;
}) {
  const bridgeUrl = `${OPENAI_COMPATIBLE.hermes}/chat/completions`;
  const abortController = new AbortController();
  const startedAt = Date.now();
  const repoLabel = input.activeRepo?.owner && input.activeRepo?.name
    ? `${input.activeRepo.owner}/${input.activeRepo.name}`
    : '-';
  let firstEventLogged = false;

  const disconnect = bindClientDisconnect(input.req, input.res, () => {
    abortController.abort();
  });

  let bridgeResponse: Response;
  try {
    console.log(
      `[chat] Hermes agent-loop bridge fetch start. model=${input.model} repo=${repoLabel} toolsets=${input.hermesToolsets || '-'} t=${startedAt}`,
    );
    bridgeResponse = await fetch(bridgeUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
        ...(input.hermesToolsets ? { 'X-Hermes-Toolsets': input.hermesToolsets } : {}),
        'X-Hermes-Execution-Mode': 'agent-loop',
        ...(input.activeRepo?.owner && input.activeRepo?.name
          ? {
              'X-Hermes-Repo-Owner': input.activeRepo.owner,
              'X-Hermes-Repo-Name': input.activeRepo.name,
              'X-Hermes-Repo-Edit-Intent': input.repoEditIntent ? '1' : '0',
            }
          : {}),
        ...(input.githubPAT ? { 'X-Hermes-Github-PAT': input.githubPAT } : {}),
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        temperature: input.temperature ?? 0.7,
        top_p: input.topP ?? 0.9,
        max_tokens: input.maxTokens ?? 32768,
        stream: true,
      }),
      signal: abortController.signal,
    });
    console.log(
      `[chat] Hermes agent-loop bridge headers received in ${Date.now() - startedAt}ms. status=${bridgeResponse.status} model=${input.model} repo=${repoLabel}`,
    );
  } catch (error) {
    if (disconnect.isDisconnected() && isAbortLikeError(error)) {
      return;
    }
    throw new Error(
      `Hermes bridge is not reachable at ${OPENAI_COMPATIBLE.hermes}. ` +
      'Start hermes-bridge/main.py and try again.',
    );
  }

  if (!bridgeResponse.ok) {
    const errorText = await bridgeResponse.text().catch(() => '');
    throw new Error(errorText || `Hermes bridge error (${bridgeResponse.status})`);
  }

  await proxySseToDataStream({
    req: input.req,
    res: input.res,
    upstreamResponse: bridgeResponse,
    corsHeaders: buildCorsHeaders(input.req.headers.origin),
    normalizePayload: normalizeHermesAgentLoopPayload,
    onFirstEvent: (kind) => {
      if (firstEventLogged) {
        return;
      }
      firstEventLogged = true;
      console.log(
        `[chat] Hermes agent-loop first ${kind} event emitted in ${Date.now() - startedAt}ms. model=${input.model} repo=${repoLabel}`,
      );
    },
    emptyTextFallback:
      'Hermes returned an empty response for this turn. Retry the request. If this keeps happening, inspect the Hermes bridge logs.',
  });
}

async function proxyCompatibleProviderToDataStream(input: {
  req: express.Request;
  res: express.Response;
  provider: string;
  apiKey: string;
  model: string;
  messages: unknown[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}) {
  const abortController = new AbortController();
  const disconnect = bindClientDisconnect(input.req, input.res, () => {
    abortController.abort();
  });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(getCompatibleProviderChatUrl(input.provider), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        temperature: input.temperature ?? 0.7,
        top_p: input.topP ?? 0.9,
        max_tokens: input.maxTokens ?? 4096,
        stream: true,
      }),
      signal: abortController.signal,
    });
  } catch (error) {
    if (disconnect.isDisconnected() && isAbortLikeError(error)) {
      return;
    }
    throw error;
  }

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text().catch(() => '');
    throw new Error(`${input.provider} API error (${upstreamResponse.status}): ${errorText}`);
  }

  if (!upstreamResponse.body) {
    throw new Error(`${input.provider} returned no response body.`);
  }

  await proxySseToDataStream({
    req: input.req,
    res: input.res,
    upstreamResponse,
    corsHeaders: buildCorsHeaders(input.req.headers.origin),
    normalizePayload: (payload) => normalizeCompatibleProviderPayload(input.provider, payload),
    throwOnEmpty: `${input.provider} returned an empty response stream.`,
  });
}

// ─── /functions/v1/chat ──────────────────────────────────────────────────────

// Filter out problematic stream lines (e.g. empty error entries from some providers)
export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  registerChatStoreRoutes(app);

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
      repo_file_cache,
      repo_file_tree,
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
      });
      return;
    }

    if (shouldDirectProxyCompatibleProvider(provider, hasServerRepoContext)) {
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

    const allTools = { ...fileTools, ...repoTools };
    const useServerAgentLoop = hasServerRepoContext;
    console.log(`[chat] Starting streamText. maxTokens=${max_tokens ?? defaultMaxTokens} maxSteps=${useServerAgentLoop ? SERVER_AGENT_MAX_STEPS : 1} tools=${Object.keys(allTools).join(',')}`);
    const result = streamText({
      model: aiModel,
      messages: normalizedChatInput.messages,
      temperature: temperature ?? 0.7,
      topP: top_p ?? 0.9,
      maxOutputTokens: max_tokens ?? defaultMaxTokens,
      abortSignal: abortController.signal,
      ...(providerOptions ? { providerOptions } : {}),
      tools: allTools,
      toolCallStreaming: true,
      // When server-side execute handlers are present, maxSteps drives the
      // agentic loop. Without execute handlers, set to 1 so the SDK streams
      // tool calls to the client for execution.
      ...(useServerAgentLoop ? { maxSteps: SERVER_AGENT_MAX_STEPS } : {}),
      // Inject server tool events into the data stream so the client can
      // update its changeset store, file cache, and activity stats.
      onFinish: () => {
        if (requestTimeout) {
          clearTimeout(requestTimeout);
        }
        // Events are emitted synchronously from execute handlers during
        // the stream, so by the time onFinish fires all events are collected.
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

    if (!res.headersSent) {
      sendJson(res, status, { error: errorMessage });
    }
  }
});

// ─── /functions/v1/github-integration ────────────────────────────────────────

interface FileChange {
  path: string;
  content: string;
  action?: 'create' | 'edit' | 'delete';
}

type GitHubCheckState = 'success' | 'failure' | 'pending';

interface PullRequestCheck {
  name: string;
  provider: string;
  status: GitHubCheckState;
  detailsUrl: string | null;
  summary: string | null;
}

function getCheckState(status?: string | null, conclusion?: string | null): GitHubCheckState {
  if (status === 'queued' || status === 'in_progress' || status === 'waiting' || status === 'requested' || status === 'pending') {
    return 'pending';
  }

  if (status === 'completed') {
    if (!conclusion || conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') {
      return 'success';
    }
    return 'failure';
  }

  if (status === 'success') return 'success';
  if (status === 'failure' || status === 'error') return 'failure';
  return 'pending';
}

function getLegacyStatusProvider(context: string): { provider: string; name: string } {
  const separators = [' / ', ': ', ' - '];
  for (const separator of separators) {
    const index = context.indexOf(separator);
    if (index > 0) {
      return {
        provider: context.slice(0, index),
        name: context.slice(index + separator.length),
      };
    }
  }

  return {
    provider: 'Commit statuses',
    name: context,
  };
}

function summarizeChecks(checks: PullRequestCheck[]) {
  const summary = {
    total: checks.length,
    passed: 0,
    failed: 0,
    pending: 0,
  };

  const providers = new Map<string, {
    name: string;
    total: number;
    passed: number;
    failed: number;
    pending: number;
    checks: PullRequestCheck[];
  }>();

  for (const check of checks) {
    if (check.status === 'success') summary.passed += 1;
    if (check.status === 'failure') summary.failed += 1;
    if (check.status === 'pending') summary.pending += 1;

    const existing = providers.get(check.provider) || {
      name: check.provider,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      checks: [],
    };

    existing.total += 1;
    if (check.status === 'success') existing.passed += 1;
    if (check.status === 'failure') existing.failed += 1;
    if (check.status === 'pending') existing.pending += 1;
    existing.checks.push(check);
    providers.set(check.provider, existing);
  }

  const overall =
    summary.failed > 0
      ? 'failing'
      : summary.pending > 0
        ? 'pending'
        : summary.total > 0
          ? 'passing'
          : 'none';

  return {
    summary,
    overall,
    providers: [...providers.values()].sort((left, right) => {
      if (left.failed !== right.failed) return right.failed - left.failed;
      if (left.pending !== right.pending) return right.pending - left.pending;
      return left.name.localeCompare(right.name);
    }),
  };
}

async function fetchPullRequestStatus(
  owner: string,
  repo: string,
  number: number,
  headers: Record<string, string>,
) {
  const prRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
    { headers },
  );

  if (!prRes.ok) {
    throw new Error(`Failed to fetch PR: ${await prRes.text()}`);
  }

  const pr = await prRes.json();
  const headSha = pr?.head?.sha as string | undefined;
  const checks: PullRequestCheck[] = [];

  if (headSha) {
    const [checkRunsRes, statusesRes] = await Promise.all([
      fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`,
        { headers },
      ),
      fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/status`,
        { headers },
      ),
    ]);

    if (checkRunsRes.ok) {
      const data = await checkRunsRes.json();
      const runs = Array.isArray(data?.check_runs) ? data.check_runs : [];
      for (const run of runs) {
        checks.push({
          name: typeof run?.name === 'string' ? run.name : 'Unnamed check',
          provider: typeof run?.app?.name === 'string' ? run.app.name : 'Checks',
          status: getCheckState(run?.status, run?.conclusion),
          detailsUrl: typeof run?.html_url === 'string' ? run.html_url : null,
          summary: typeof run?.output?.title === 'string'
            ? run.output.title
            : typeof run?.conclusion === 'string'
              ? run.conclusion
              : null,
        });
      }
    }

    if (statusesRes.ok) {
      const data = await statusesRes.json();
      const statuses = Array.isArray(data?.statuses) ? data.statuses : [];
      for (const status of statuses) {
        const { provider, name } = getLegacyStatusProvider(
          typeof status?.context === 'string' ? status.context : 'Status',
        );
        checks.push({
          name,
          provider,
          status: getCheckState(status?.state, null),
          detailsUrl: typeof status?.target_url === 'string' ? status.target_url : null,
          summary: typeof status?.description === 'string' ? status.description : null,
        });
      }
    }
  }

  return {
    pr: {
      number: pr.number,
      title: pr.title,
      body: pr.body || '',
      url: pr.html_url,
      state: pr.state,
      draft: !!pr.draft,
      merged: !!pr.merged,
      mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null,
      mergeableState: typeof pr.mergeable_state === 'string' ? pr.mergeable_state : null,
      headBranch: pr?.head?.ref || '',
      baseBranch: pr?.base?.ref || '',
    },
    checks: summarizeChecks(checks),
  };
}

async function fetchRepoContents(
  owner: string,
  repo: string,
  path: string,
  headers: Record<string, string>
): Promise<Array<{ path: string; type: 'dir'; children: [] } | { path: string; type: 'file'; size: number; sha: string }>> {
  const url = buildGitHubContentsUrl(owner, repo, path);
  const response = await fetch(url, { headers });

  if (!response.ok) {
    return [];
  }

  const data = await response.json() as unknown;

  if (!Array.isArray(data)) {
    const file = data as { path: string; size: number; sha: string };
    return [
      {
        path: file.path,
        type: 'file',
        size: file.size,
        sha: file.sha,
      },
    ];
  }

  const contents: Array<{ path: string; type: 'dir'; children: [] } | { path: string; type: 'file'; size: number; sha: string }> = [];
  for (const item of data as Array<{ type: string; path: string; size?: number; sha?: string }>) {
    if (item.type === 'dir') {
      contents.push({
        path: item.path,
        type: 'dir',
        children: [],
      });
    } else if (item.type === 'file') {
      contents.push({
        path: item.path,
        type: 'file',
        size: item.size || 0,
        sha: item.sha || '',
      });
    }
  }

  return contents;
}

app.post('/functions/v1/github-integration', async (req, res) => {
  try {
    const { action, pat, ...params } = req.body;

    if (!pat || !isValidGitHubPAT(pat)) {
      return sendJson(res, 400, { error: 'A valid GitHub PAT is required' });
    }

    const headers = {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CloudChat-App',
    };

    switch (action) {
      case 'list-repos': {
        const response = await fetch(
          'https://api.github.com/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator,organization_member',
          { headers }
        );
        if (!response.ok) {
          const error = await response.text();
          return sendJson(res, response.status, { error: `GitHub API error: ${error}` });
        }
        const repos = await response.json();
        const normalized = await Promise.all((repos || []).map((repo: Record<string, unknown>) => withLocalClone(repo as Parameters<typeof withLocalClone>[0])));
        return sendJson(res, 200, { repos: normalized });
      }

      case 'search-repos': {
        const { query, page = 1 } = params as { query?: string; page?: number };
        if (!query || !query.trim()) {
          return sendJson(res, 400, { error: 'query is required' });
        }

        const response = await fetch(
          `https://api.github.com/search/repositories?q=${encodeURIComponent(query.trim())}&per_page=25&page=${Number(page) || 1}`,
          { headers },
        );
        if (!response.ok) {
          const error = await response.text();
          return sendJson(res, response.status, { error: `GitHub API error: ${error}` });
        }

        const result = await response.json() as {
          total_count?: number;
          incomplete_results?: boolean;
          items?: Array<Record<string, unknown>>;
        };
        const repos = await Promise.all((result.items || []).map((repo) => withLocalClone(repo as Parameters<typeof withLocalClone>[0])));
        return sendJson(res, 200, {
          repos,
          totalCount: result.total_count || 0,
          incompleteResults: !!result.incomplete_results,
          page: Number(page) || 1,
          perPage: 25,
        });
      }

      case 'list-issues': {
        const {
          owner,
          repo,
          page = 1,
          sort = 'updated',
          direction = 'desc',
          state = 'open',
          query = '',
          labels = [],
        } = params as {
          owner?: string;
          repo?: string;
          page?: number;
          sort?: 'created' | 'updated' | 'comments';
          direction?: 'asc' | 'desc';
          state?: 'open' | 'closed' | 'all';
          query?: string;
          labels?: string[];
        };

        if (!owner || !repo) {
          return sendJson(res, 400, { error: 'owner and repo are required' });
        }

        const searchTerms = [
          `repo:${owner}/${repo}`,
          'is:issue',
          state !== 'all' ? `state:${state}` : '',
          ...(Array.isArray(labels) ? labels.map((l) => `label:"${String(l).replace(/"/g, '')}"`) : []),
          typeof query === 'string' ? query.trim() : '',
        ].filter(Boolean).join(' ');

        const response = await fetch(
          `https://api.github.com/search/issues?q=${encodeURIComponent(searchTerms)}&sort=${encodeURIComponent(sort)}&order=${encodeURIComponent(direction)}&per_page=25&page=${Number(page) || 1}`,
          { headers },
        );
        if (!response.ok) {
          const error = await response.text();
          return sendJson(res, response.status, { error: `GitHub API error: ${error}` });
        }

        const result = await response.json() as {
          total_count?: number;
          incomplete_results?: boolean;
          items?: Array<Record<string, unknown>>;
        };
        const totalCount = result.total_count || 0;
        const totalPages = Math.max(1, Math.min(Math.ceil(totalCount / 25), 40));
        const currentPage = Math.min(Math.max(Number(page) || 1, 1), totalPages);

        return sendJson(res, 200, {
          issues: (result.items || []).map((issue) => toGitHubIssue(issue as Parameters<typeof toGitHubIssue>[0])),
          totalCount,
          incompleteResults: !!result.incomplete_results,
          page: currentPage,
          perPage: 25,
          totalPages,
          hasPreviousPage: currentPage > 1,
          hasNextPage: currentPage < totalPages,
        });
      }

      case 'repo-activity': {
        const { owner, repo } = params as { owner?: string; repo?: string };
        if (!owner || !repo) {
          return sendJson(res, 400, { error: 'owner and repo are required' });
        }

        try {
          const activity = await fetchRecentRepoActivity(owner, repo, headers);
          return sendJson(res, 200, activity);
        } catch (error) {
          return sendJson(res, 502, { error: getUnknownErrorMessage(error) });
        }
      }

      case 'create-issue': {
        const { owner, repo, title, body } = params as {
          owner?: string;
          repo?: string;
          title?: string;
          body?: string;
        };

        if (!owner || !repo) {
          return sendJson(res, 400, { error: 'owner and repo are required' });
        }

        if (typeof title !== 'string' || title.trim().length === 0) {
          return sendJson(res, 400, { error: 'title is required' });
        }

        const issueResponse = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: title.trim(),
              ...(typeof body === 'string' && body.trim().length > 0 ? { body: body.trim() } : {}),
            }),
          },
        );
        if (!issueResponse.ok) {
          const error = await issueResponse.text();
          return sendJson(res, issueResponse.status, { error: `GitHub API error: ${error}` });
        }

        const issue = await issueResponse.json() as Parameters<typeof toGitHubIssue>[0];
        return sendJson(res, 200, {
          issue: toGitHubIssue(issue),
        });
      }

      case 'clone-repo': {
        const { owner, repo, branch } = params as { owner?: string; repo?: string; branch?: string };
        if (!owner || !repo) {
          return sendJson(res, 400, { error: 'owner and repo are required' });
        }

        const clone = await ensureRepoClone({ owner, repo, pat, branch });
        return sendJson(res, 200, {
          clone,
          repo: await withLocalClone({
            owner: { login: owner },
            name: repo,
            full_name: `${owner}/${repo}`,
            default_branch: branch || 'main',
          }),
        });
      }

      case 'fork-repo': {
        const { owner, repo, branch } = params as { owner?: string; repo?: string; branch?: string };
        if (!owner || !repo) {
          return sendJson(res, 400, { error: 'owner and repo are required' });
        }

        const fork = await forkRepository({ owner, repo, pat, branch });
        return sendJson(res, 200, {
          repo: await withLocalClone({
            owner: { login: fork.owner },
            name: fork.repo,
            full_name: fork.fullName,
            default_branch: fork.defaultBranch,
            html_url: fork.htmlUrl,
            fork: true,
          }),
          sourceRepo: {
            owner,
            repo,
            fullName: `${owner}/${repo}`,
          },
        });
      }

      case 'list-issue-comments': {
        const { owner, repo, issueNumber } = params as { owner?: string; repo?: string; issueNumber?: number };
        if (!owner || !repo || !issueNumber) {
          return sendJson(res, 400, { error: 'owner, repo, and issueNumber are required' });
        }

        const response = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${Number(issueNumber)}/comments?per_page=50`,
          { headers: { ...headers, Accept: 'application/vnd.github.squirrel-girl-preview+json' } },
        );
        if (!response.ok) {
          const error = await response.text();
          return sendJson(res, response.status, { error: `GitHub API error: ${error}` });
        }

        const rawComments = await response.json() as Array<{
          id?: number;
          user?: { login?: string; avatar_url?: string | null };
          body?: string;
          created_at?: string;
          updated_at?: string;
          reactions?: Record<string, number>;
        }>;

        return sendJson(res, 200, {
          comments: (rawComments || []).map((c) => ({
            id: c.id || 0,
            user: { login: c.user?.login || 'unknown', avatar_url: c.user?.avatar_url || null },
            body: c.body || '',
            created_at: c.created_at || new Date(0).toISOString(),
            updated_at: c.updated_at || new Date(0).toISOString(),
            reactions: {
              '+1': c.reactions?.['+1'] || 0,
              '-1': c.reactions?.['-1'] || 0,
              laugh: c.reactions?.laugh || 0,
              hooray: c.reactions?.hooray || 0,
              confused: c.reactions?.confused || 0,
              heart: c.reactions?.heart || 0,
              rocket: c.reactions?.rocket || 0,
              eyes: c.reactions?.eyes || 0,
            },
          })),
        });
      }

      case 'add-comment-reaction': {
        const { owner, repo, commentId, reaction } = params as {
          owner?: string; repo?: string; commentId?: number; reaction?: string;
        };
        if (!owner || !repo || !commentId || !reaction) {
          return sendJson(res, 400, { error: 'owner, repo, commentId, and reaction are required' });
        }

        const validReactions = ['+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes'];
        if (!validReactions.includes(reaction)) {
          return sendJson(res, 400, { error: `Invalid reaction. Must be one of: ${validReactions.join(', ')}` });
        }

        const reactionResponse = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${Number(commentId)}/reactions`,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/vnd.github.squirrel-girl-preview+json' },
            body: JSON.stringify({ content: reaction }),
          },
        );
        if (!reactionResponse.ok) {
          const error = await reactionResponse.text();
          return sendJson(res, reactionResponse.status, { error: `GitHub API error: ${error}` });
        }

        const reactionData = await reactionResponse.json() as { id?: number; content?: string };
        return sendJson(res, 200, { reaction: { id: reactionData.id || 0, content: reactionData.content || reaction } });
      }

      case 'create-issue-comment': {
        const { owner, repo, issueNumber, body: commentBody } = params as {
          owner?: string; repo?: string; issueNumber?: number; body?: string;
        };
        if (!owner || !repo || !issueNumber || !commentBody) {
          return sendJson(res, 400, { error: 'owner, repo, issueNumber, and body are required' });
        }

        const commentResponse = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${Number(issueNumber)}/comments`,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: commentBody }),
          },
        );
        if (!commentResponse.ok) {
          const error = await commentResponse.text();
          return sendJson(res, commentResponse.status, { error: `GitHub API error: ${error}` });
        }

        const rawComment = await commentResponse.json() as {
          id?: number;
          user?: { login?: string; avatar_url?: string | null };
          body?: string;
          created_at?: string;
          updated_at?: string;
        };

        return sendJson(res, 200, {
          comment: {
            id: rawComment.id || 0,
            user: { login: rawComment.user?.login || 'unknown', avatar_url: rawComment.user?.avatar_url || null },
            body: rawComment.body || '',
            created_at: rawComment.created_at || new Date(0).toISOString(),
            updated_at: rawComment.updated_at || new Date(0).toISOString(),
          },
        });
      }

      case 'create-branch': {
        const { owner, repo, baseBranch, newBranchName } = params as {
          owner?: string; repo?: string; baseBranch?: string; newBranchName?: string;
        };
        if (!owner || !repo || !baseBranch || !newBranchName) {
          return sendJson(res, 400, { error: 'owner, repo, baseBranch, and newBranchName are required' });
        }

        // Get the SHA of the base branch
        const refResponse = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
          { headers },
        );
        if (!refResponse.ok) {
          const error = await refResponse.text();
          return sendJson(res, refResponse.status, { error: `Failed to resolve base branch: ${error}` });
        }
        const refData = await refResponse.json() as { object?: { sha?: string } };
        const sha = refData.object?.sha;
        if (!sha) {
          return sendJson(res, 500, { error: 'Could not resolve base branch SHA' });
        }

        // Create the new branch
        const createResponse = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: `refs/heads/${newBranchName}`, sha }),
          },
        );

        if (!createResponse.ok) {
          if (createResponse.status === 422) {
            return sendJson(res, 200, { branch: newBranchName, sha, created: false });
          }
          const error = await createResponse.text();
          return sendJson(res, createResponse.status, { error: `Failed to create branch: ${error}` });
        }

        return sendJson(res, 200, { branch: newBranchName, sha, created: true });
      }

      case 'list-linked-prs': {
        const { owner, repo, issueNumber } = params as { owner?: string; repo?: string; issueNumber?: number };
        if (!owner || !repo || !issueNumber) {
          return sendJson(res, 400, { error: 'owner, repo, and issueNumber are required' });
        }

        const q = `repo:${owner}/${repo} is:pr is:open ${issueNumber} in:body`;
        const response = await fetch(
          `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=10`,
          { headers },
        );
        if (!response.ok) {
          const error = await response.text();
          return sendJson(res, response.status, { error: `GitHub API error: ${error}` });
        }

        const result = await response.json() as {
          items?: Array<{
            number?: number;
            title?: string;
            html_url?: string;
            state?: string;
            user?: { login?: string };
            created_at?: string;
          }>;
        };

        return sendJson(res, 200, {
          prs: (result.items || []).map((pr) => ({
            number: pr.number || 0,
            title: pr.title || '',
            html_url: pr.html_url || '',
            state: pr.state || 'open',
            user: { login: pr.user?.login || 'unknown' },
            created_at: pr.created_at || new Date(0).toISOString(),
          })),
        });
      }

      case 'read-repo': {
        const { owner, repo, path = '' } = params;
        if (!owner || !repo) {
          return sendJson(res, 400, { error: 'owner and repo are required' });
        }
        const contents = await fetchRepoContents(owner, repo, path, headers);
        return sendJson(res, 200, { contents });
      }

      case 'read-tree': {
        const { owner, repo, branch } = params;
        if (!owner || !repo || !branch) {
          return sendJson(res, 400, { error: 'owner, repo, and branch are required' });
        }
        const treeResult = await fetchGitHubRepoTree(owner, repo, branch, headers);
        if (!treeResult.ok) {
          return sendJson(res, treeResult.status, { error: treeResult.error });
        }
        return sendJson(res, 200, { items: treeResult.items, truncated: treeResult.truncated });
      }

      case 'read-file': {
        const { owner, repo, path, ref } = params;
        if (!owner || !repo || !path) {
          return sendJson(res, 400, { error: 'owner, repo, and path are required' });
        }

        const response = await fetch(
          buildGitHubContentsUrl(owner, repo, path, typeof ref === 'string' && ref ? ref : undefined),
          { headers }
        );

        if (!response.ok) {
          const error = await response.text().catch(() => '');
          return sendJson(res, response.status, {
            error: response.status === 404
              ? `File \`${path}\` was not found${typeof ref === 'string' && ref ? ` on branch \`${ref}\`` : ''}.`
              : `GitHub API error: ${error || 'File not found or inaccessible'}`,
          });
        }

        const data = await response.json();
        if (!data.content) {
          return sendJson(res, 400, {
            error: Array.isArray(data) ? 'Path is a directory, not a file' : 'File content unavailable',
          });
        }
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        return sendJson(res, 200, { content, sha: data.sha });
      }

      case 'create-pr': {
        const { owner, repo, title, body, branch, baseBranch, baseOwner, baseRepo, draft, files } = params as {
          owner: string;
          repo: string;
          title: string;
          body: string;
          branch: string;
          baseBranch: string;
          baseOwner?: string;
          baseRepo?: string;
          draft?: boolean;
          files: FileChange[];
        };

        if (!owner || !repo || !title || !branch || !baseBranch || !files?.length) {
          return sendJson(res, 400, {
            error: 'Missing required parameters for PR creation',
          });
        }

        const headOwner = owner;
        const headRepo = repo;
        const pullRequestBaseOwner = baseOwner || owner;
        const pullRequestBaseRepo = baseRepo || repo;

        // 1. Get the base branch's latest commit SHA
        const baseRefRes = await fetch(
          `https://api.github.com/repos/${headOwner}/${headRepo}/git/ref/heads/${baseBranch}`,
          { headers }
        );
        if (!baseRefRes.ok) {
          return sendJson(res, baseRefRes.status, {
            error: `Failed to get base branch: ${await baseRefRes.text()}`,
          });
        }
        const baseRef = await baseRefRes.json();
        const baseSha = baseRef.object.sha;

        // 2. Create a new branch from the base
        const createBranchRes = await fetch(
          `https://api.github.com/repos/${headOwner}/${headRepo}/git/refs`,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ref: `refs/heads/${branch}`,
              sha: baseSha,
            }),
          }
        );

        if (!createBranchRes.ok && createBranchRes.status !== 422) {
          return sendJson(res, createBranchRes.status, {
            error: `Failed to create branch: ${await createBranchRes.text()}`,
          });
        }

        // 3. Create/update/delete files on the new branch
        for (const file of files) {
          let fileSha: string | undefined;
          const existingFileRes = await fetch(
            buildGitHubContentsUrl(headOwner, headRepo, file.path, branch),
            { headers }
          );
          if (existingFileRes.ok) {
            const existingFile = await existingFileRes.json();
            fileSha = existingFile.sha;
          }

          if (file.action === 'delete') {
            // Only delete if the file actually exists in the repo
            if (!fileSha) continue;
            const deleteRes = await fetch(
              buildGitHubContentsUrl(headOwner, headRepo, file.path),
              {
                method: 'DELETE',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  message: `Delete ${file.path}`,
                  branch,
                  sha: fileSha,
                }),
              }
            );
            if (!deleteRes.ok) {
              return sendJson(res, deleteRes.status, {
                error: `Failed to delete ${file.path}: ${await deleteRes.text()}`,
              });
            }
          } else {
            const updateRes = await fetch(
              buildGitHubContentsUrl(headOwner, headRepo, file.path),
              {
                method: 'PUT',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  message: `${file.action === 'create' ? 'Create' : 'Update'} ${file.path}`,
                  content: Buffer.from(file.content, 'utf-8').toString('base64'),
                  branch,
                  ...(fileSha && { sha: fileSha }),
                }),
              }
            );

            if (!updateRes.ok) {
              return sendJson(res, updateRes.status, {
                error: `Failed to update ${file.path}: ${await updateRes.text()}`,
              });
            }
          }
        }

        // 4. Create the PR
        const prRes = await fetch(
          `https://api.github.com/repos/${pullRequestBaseOwner}/${pullRequestBaseRepo}/pulls`,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title,
              body,
              head: pullRequestBaseOwner === headOwner && pullRequestBaseRepo === headRepo
                ? branch
                : `${headOwner}:${branch}`,
              base: baseBranch,
              ...(draft ? { draft: true } : {}),
            }),
          }
        );

        if (!prRes.ok) {
          return sendJson(res, prRes.status, {
            error: `Failed to create PR: ${await prRes.text()}`,
          });
        }

        const pr = await prRes.json();
        return sendJson(res, 200, {
          pr: {
            number: pr.number,
            url: pr.html_url,
            title: pr.title,
            body: pr.body || '',
            state: pr.state,
            draft: !!pr.draft,
            headBranch: pr?.head?.ref || branch,
            baseBranch: pr?.base?.ref || baseBranch,
            headRepo: `${headOwner}/${headRepo}`,
            baseRepo: `${pullRequestBaseOwner}/${pullRequestBaseRepo}`,
          },
        });
      }

      case 'verify-changes': {
        const {
          owner,
          repo,
          baseBranch,
          files,
          provider,
          model,
          apiKey,
          allProviders,
        } = params as {
          owner: string;
          repo: string;
          baseBranch: string;
          files: VerificationFileChange[];
          provider?: string;
          model?: string;
          apiKey?: string;
          allProviders?: Record<string, { apiKey: string; model: string }>;
        };

        if (!owner || !repo || !baseBranch || !Array.isArray(files) || files.length === 0) {
          return sendJson(res, 400, {
            error: 'owner, repo, baseBranch, and files are required',
          });
        }

        const verification = await verifyRepoChanges({
          owner,
          repo,
          pat,
          baseBranch,
          files,
          provider,
          model,
          apiKey,
          origin: req.headers.origin as string | undefined,
          allProviders,
        });

        return sendJson(res, 200, verification);
      }

      case 'generate-pr-metadata': {
        const {
          files,
          provider,
          model,
          apiKey,
          allProviders,
          owner,
          repo,
        } = params as {
          files: VerificationFileChange[];
          provider?: string;
          model?: string;
          apiKey?: string;
          allProviders?: Record<string, { apiKey: string; model: string }>;
          owner?: string;
          repo?: string;
        };

        if (!Array.isArray(files) || files.length === 0) {
          return sendJson(res, 400, { error: 'files are required' });
        }

        try {
          const metadata = await generatePrMetadata({
            files,
            provider,
            model,
            apiKey,
            allProviders,
            origin: req.headers.origin as string | undefined,
            owner,
            repo,
          });
          return sendJson(res, 200, metadata);
        } catch (error) {
          return sendJson(res, 500, {
            error: error instanceof Error ? error.message : 'Failed to generate PR metadata',
          });
        }
      }

      case 'get-pr-status': {
        const { owner, repo, number, baseOwner, baseRepo } = params as {
          owner: string;
          repo: string;
          number: number;
          baseOwner?: string;
          baseRepo?: string;
        };

        if (!owner || !repo || !number) {
          return sendJson(res, 400, { error: 'owner, repo, and number are required' });
        }

        const status = await fetchPullRequestStatus(baseOwner || owner, baseRepo || repo, Number(number), headers);
        return sendJson(res, 200, status);
      }

      case 'merge-pr': {
        const {
          owner,
          repo,
          number,
          baseOwner,
          baseRepo,
          method,
          commitTitle,
          commitMessage,
        } = params as {
          owner: string;
          repo: string;
          number: number;
          baseOwner?: string;
          baseRepo?: string;
          method?: 'merge' | 'squash' | 'rebase';
          commitTitle?: string;
          commitMessage?: string;
        };

        if (!owner || !repo || !number) {
          return sendJson(res, 400, { error: 'owner, repo, and number are required' });
        }

        const mergeRes = await fetch(
          `https://api.github.com/repos/${baseOwner || owner}/${baseRepo || repo}/pulls/${number}/merge`,
          {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              merge_method: method || 'squash',
              ...(commitTitle ? { commit_title: commitTitle } : {}),
              ...(commitMessage ? { commit_message: commitMessage } : {}),
            }),
          }
        );

        if (!mergeRes.ok) {
          return sendJson(res, mergeRes.status, {
            error: `Failed to merge PR: ${await mergeRes.text()}`,
          });
        }

        const merged = await mergeRes.json();
        return sendJson(res, 200, {
          merged: {
            sha: merged.sha,
            merged: !!merged.merged,
            message: merged.message,
          },
        });
      }

      default:
        return sendJson(res, 400, { error: 'Unknown action' });
    }
  } catch (error: unknown) {
    console.error('GitHub integration error:', error);
    sendJson(res, 500, { error: getUnknownErrorMessage(error) });
  }
});

// ─── /functions/v1/github-analyzer ───────────────────────────────────────────

interface FileContent {
  path: string;
  content: string;
  language: string;
}

const getFileLanguage = (filePath: string): string => {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    java: 'java',
    go: 'go',
    rs: 'rust',
    cpp: 'cpp',
    c: 'c',
    cs: 'csharp',
    php: 'php',
    rb: 'ruby',
    swift: 'swift',
    kt: 'kotlin',
  };
  return langMap[ext || ''] || 'text';
};

const isCodeFile = (filePath: string): boolean => {
  const codeExtensions = [
    'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'go', 'rs', 'cpp', 'c', 'cs', 'php', 'rb',
    'swift', 'kt', 'vue', 'svelte',
  ];
  const ext = filePath.split('.').pop()?.toLowerCase();
  return codeExtensions.includes(ext || '');
};

async function fetchAnalyzerRepoFiles(
  owner: string,
  repo: string,
  pat: string
): Promise<FileContent[]> {
  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GitHub-Analyzer',
  };

  async function fetchContentsRecursive(path = ''): Promise<FileContent[]> {
    const url = buildGitHubContentsUrl(owner, repo, path);
    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`Failed to fetch contents: ${response.status}`);
    }

    const data = await response.json();
    const files: FileContent[] = [];

    if (Array.isArray(data)) {
      for (const item of data) {
        if (item.type === 'file' && isCodeFile(item.path) && item.size < 100000) {
          try {
            const fileResponse = await fetch(item.download_url, {
              headers: { 'User-Agent': 'GitHub-Analyzer' },
            });
            if (fileResponse.ok) {
              const content = await fileResponse.text();
              files.push({
                path: item.path,
                content,
                language: getFileLanguage(item.path),
              });
            }
          } catch (error) {
            console.warn(`Failed to fetch file ${item.path}:`, error);
          }
        } else if (
          item.type === 'dir' &&
          !item.path.includes('node_modules') &&
          !item.path.includes('.git') &&
          files.length < 50
        ) {
          const subFiles = await fetchContentsRecursive(item.path);
          files.push(...subFiles);
        }
      }
    }

    return files;
  }

  return await fetchContentsRecursive();
}

async function analyzeCode(files: FileContent[]): Promise<unknown[]> {
  const lovableApiKey = process.env.LOVABLE_API_KEY;

  if (!lovableApiKey) {
    throw new Error('Lovable API key not configured');
  }

  const codebaseContext = files.map((file) => ({
    path: file.path,
    language: file.language,
    lines: file.content.split('\n').length,
    preview: file.content.slice(0, 1000),
  }));

  const analysisPrompt = `
Analyze the following codebase for bugs, security issues, performance problems, and improvement opportunities.

Codebase Overview:
${JSON.stringify(codebaseContext, null, 2)}

Full file contents:
${files.map((file) => `=== ${file.path} (${file.language}) ===\n${file.content}\n`).join('\n')}

Please provide a detailed analysis in JSON format with the following structure:
{
  "analysis": [
    {
      "type": "bug|improvement|security|performance",
      "severity": "low|medium|high",
      "title": "Brief title describing the issue",
      "description": "Detailed description of the issue or improvement opportunity",
      "file": "path/to/file.ext",
      "line": 123,
      "suggestion": "Detailed suggestion on how to fix or improve this"
    }
  ]
}

Focus on:
1. Common programming bugs (null pointer exceptions, logic errors, etc.)
2. Security vulnerabilities (XSS, injection attacks, exposed secrets)
3. Performance issues (inefficient algorithms, memory leaks)
4. Code quality improvements (best practices, maintainability)
5. Missing error handling
6. Potential race conditions
7. Dependency vulnerabilities

Be specific about file names and line numbers when possible. Provide actionable suggestions.
`;

  try {
    const analysisMessages = normalizeChatMessages(
      [{ role: 'user', content: analysisPrompt }],
      'You are an expert code reviewer specializing in finding bugs, security issues, and improvement opportunities. Always respond with valid JSON.',
    ).messages;

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: analysisMessages,
        temperature: 0.3,
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      throw new Error(`AI analysis failed: ${response.status}`);
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices[0]?.message?.content;

    if (!content) {
      throw new Error('No analysis content received from AI');
    }

    try {
      const parsed = JSON.parse(content);
      return parsed.analysis || [];
    } catch {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.analysis || [];
      }
      throw new Error('Invalid JSON response from AI');
    }
  } catch (error: unknown) {
    console.error('AI analysis error:', error);
    throw new Error(`AI analysis failed: ${getUnknownErrorMessage(error)}`);
  }
}

app.post('/functions/v1/github-analyzer', async (req, res) => {
  try {
    const { owner, repo, pat } = req.body;

    if (!owner || !repo || !isValidGitHubPAT(pat)) {
      return sendJson(res, 400, { error: 'owner, repo, and a valid GitHub PAT are required' });
    }

    // Fetch repository files for analysis
    const files = await fetchAnalyzerRepoFiles(owner, repo, pat);

    if (files.length === 0) {
      return sendJson(res, 400, { error: 'No code files found in repository' });
    }

    // Analyze fetched files
    const analysis = await analyzeCode(files);

    return sendJson(res, 200, {
      analysis,
      filesAnalyzed: files.length,
      repository: `${owner}/${repo}`,
    });
  } catch (error: unknown) {
    console.error('GitHub analyzer error:', error);
    sendJson(res, 500, { error: getUnknownErrorMessage(error) });
  }
});

// ─── /functions/v1/validate-key ──────────────────────────────────────────────

app.post('/functions/v1/validate-key', async (req, res) => {
  if (!validateKeyRateLimiter.isAllowed(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Too many requests. Please try again later.' });
  }

  try {
    const { provider, api_key } = req.body;

    if (provider === 'openclaw') {
      const { defaultModel, models } = await getOpenClawModels();
      return sendJson(res, 200, { valid: true, defaultModel, models });
    }

    if (!api_key || !provider) {
      return sendJson(res, 400, { valid: false, error: 'Missing provider or api_key' });
    }

    const validationModel = VALIDATION_MODELS[provider];
    if (!validationModel) {
      return sendJson(res, 400, { valid: false, error: `Unknown provider: ${provider}` });
    }

    const origin = req.headers.origin as string | undefined;
    const discoveryBaseUrl = MODEL_DISCOVERY_URLS[provider];
    const listModelsUrl = discoveryBaseUrl ? `${discoveryBaseUrl}/models` : null;

    if (listModelsUrl) {
      let modelListResponse: Response;
      try {
        modelListResponse = await fetch(listModelsUrl, {
          headers: getModelDiscoveryHeaders(provider, api_key, origin),
        });
      } catch (error) {
        if (provider === 'hermes') {
          return sendJson(res, 503, {
            valid: false,
            error:
              `Hermes bridge is not reachable at ${OPENAI_COMPATIBLE.hermes}. ` +
              'Start hermes-bridge/main.py and try again.',
          });
        }
        throw error;
      }

      if (modelListResponse.ok) {
        if (provider === 'hermes') {
          return sendJson(res, 200, {
            valid: true,
            defaultModel: HERMES_TOOL_CAPABLE_MODELS[0],
            models: [...HERMES_TOOL_CAPABLE_MODELS],
          });
        }

        const data = await modelListResponse.json();
        const models = Array.isArray(data?.data)
          ? (data.data as Array<{ id?: string }>)
              .map((model) => model?.id)
              .filter((modelId: string | undefined): modelId is string => !!modelId)
          : undefined;

        return sendJson(res, 200, { valid: true, models });
      }
    }

    const model = createProviderModel(provider, validationModel, api_key, {
      origin,
    });

    await generateText({
      model,
      prompt: 'ping',
      maxOutputTokens: 1,
      temperature: 0,
    });

    return sendJson(res, 200, { valid: true });
  } catch (err: unknown) {
    const message = getUnknownErrorMessage(err) || 'Provider validation failed';
    const normalizedProviderError = normalizeLocalProviderError(req.body?.provider, message);
    const status = normalizedProviderError
      ? normalizedProviderError.status
      : /401|403|authentication|unauthorized|invalid api key/i.test(message) ? 401 : 500;
    sendJson(res, status, { valid: false, error: normalizedProviderError?.error || message });
  }
});

// ─── /functions/v1/chat-proxy ────────────────────────────────────────────────

interface ChatProxyRequest {
  provider: 'minimax' | 'minimax-payg' | 'kimi' | 'kimi-coding';
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  api_key: string;
  system_prompt?: string;
}

const KIMI_API_URL = 'https://api.moonshot.cn/v1/chat/completions';
const KIMI_CODING_API_URL = 'https://api.kimi.com/coding/v1/chat/completions';

async function proxyMiniMax(body: ChatProxyRequest): Promise<Response> {
  const messages = normalizeChatMessages(body.messages, body.system_prompt).messages;

  const payload = {
    model: body.model,
    messages,
    temperature: body.temperature ?? 0.7,
    top_p: body.top_p ?? 0.9,
    max_tokens: body.max_tokens ?? 4096,
    stream: true,
  };

  const response = await fetch(`${OPENAI_COMPATIBLE[body.provider]}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${body.api_key}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`MiniMax API error (${response.status}): ${errorText}`);
  }

  return response;
}

async function proxyKimi(body: ChatProxyRequest): Promise<Response> {
  const messages = normalizeChatMessages(body.messages, body.system_prompt).messages;

  const payload = {
    model: body.model,
    messages,
    temperature: body.temperature ?? 0.7,
    top_p: body.top_p ?? 0.9,
    max_tokens: body.max_tokens ?? 4096,
    stream: true,
  };

  const response = await fetch(KIMI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${body.api_key}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kimi API error (${response.status}): ${errorText}`);
  }

  return response;
}

async function proxyKimiCoding(body: ChatProxyRequest): Promise<Response> {
  const messages = normalizeChatMessages(body.messages, body.system_prompt).messages;

  const payload = {
    model: body.model,
    messages,
    temperature: body.temperature ?? 0.7,
    top_p: body.top_p ?? 0.9,
    max_tokens: body.max_tokens ?? 32768,
    stream: true,
  };

  const response = await fetch(KIMI_CODING_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${body.api_key}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kimi Coding API error (${response.status}): ${errorText}`);
  }

  return response;
}

app.post('/functions/v1/chat-proxy', async (req, res) => {
  try {
    const body: ChatProxyRequest = req.body;

    if (!body.api_key) {
      return sendJson(res, 400, { error: 'API key is required' });
    }

    if (!body.provider || !['minimax', 'minimax-payg', 'kimi', 'kimi-coding'].includes(body.provider)) {
      return sendJson(res, 400, {
        error: 'Invalid provider. Use "minimax", "minimax-payg", "kimi", or "kimi-coding".',
      });
    }

    let upstreamResponse: Response;
    if (body.provider === 'minimax' || body.provider === 'minimax-payg') {
      upstreamResponse = await proxyMiniMax(body);
    } else if (body.provider === 'kimi-coding') {
      upstreamResponse = await proxyKimiCoding(body);
    } else {
      upstreamResponse = await proxyKimi(body);
    }

    if (!upstreamResponse.body) {
      const text = await upstreamResponse.text();
      console.warn('[chat-proxy] No response body from provider:', text);
      return sendJson(res, 502, {
        error: 'No response body from provider',
        details: text,
      });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req.headers.origin));

    // Parse and re-emit SSE stream
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let receivedAnyContent = false;
    let rawAccumulator = '';

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (!receivedAnyContent && rawAccumulator.trim()) {
              console.warn('[chat-proxy] No SSE content received. Raw response:', rawAccumulator);
              try {
                const errorJson = JSON.parse(rawAccumulator);
                const errorMsg =
                  errorJson.base_resp?.status_msg ||
                  errorJson.error?.message ||
                  errorJson.message ||
                  'Unknown API error';
                res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
              } catch {
                res.write(
                  `data: ${JSON.stringify({ error: `API returned non-streaming response: ${rawAccumulator.slice(0, 200)}` })}\n\n`
                );
              }
            }
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          const chunk = decoder.decode(value, { stream: true });
          rawAccumulator += chunk;
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (!trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);

            if (data === '[DONE]') {
              res.write('data: [DONE]\n\n');
              continue;
            }

            try {
              const json = JSON.parse(data);

              if (json.base_resp?.status_code && json.base_resp.status_code !== 0) {
                const errorMsg = json.base_resp.status_msg || 'API error';
                console.warn('[chat-proxy] MiniMax inline error:', errorMsg);
                res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
                receivedAnyContent = true;
                continue;
              }

              let content = '';
              if (body.provider === 'minimax' || body.provider === 'minimax-payg') {
                content = json.choices?.[0]?.delta?.content || '';
              } else if (body.provider === 'kimi' || body.provider === 'kimi-coding') {
                content = json.choices?.[0]?.delta?.content || '';
              }

              if (content) {
                receivedAnyContent = true;
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      } catch (err) {
        console.error('SSE stream error:', err);
        res.end();
      }
    };

    bindClientDisconnect(req, res, () => {
      reader.cancel().catch(() => {});
    });

    await pump();
  } catch (err: unknown) {
    const message = getUnknownErrorMessage(err) || 'Internal server error';
    const status = message.includes('401') ? 401 : message.includes('429') ? 429 : 500;

    if (!res.headersSent) {
      sendJson(res, status, { error: message });
    }
  }
});

// ─── /functions/v1/orchestrate ────────────────────────────────────────────────

app.post(
  '/functions/v1/orchestrate',
  createOrchestrateHandler()
);

// ─── /functions/v1/translate ───────────────────────────────────────────────────

app.post('/functions/v1/translate', async (req, res) => {
  try {
    const {
      text,
      targetLanguage = 'English',
      provider,
      api_key,
      model,
    } = req.body as {
      text?: string;
      targetLanguage?: string;
      provider?: string;
      api_key?: string;
      model?: string;
    };

    if (!text) {
      return sendJson(res, 400, { error: 'text is required' });
    }
    if (!provider) {
      return sendJson(res, 400, { error: 'provider is required' });
    }
    if (!model) {
      return sendJson(res, 400, { error: 'model is required' });
    }

    const systemMessage = `Translate the following text to ${targetLanguage}. Output ONLY the direct translation. Do not explain, narrate, or add commentary. Do not include phrases like "Here is the translation" or "This translates to". Just output the translated text exactly as it would read in ${targetLanguage}.`;
    const translatedMessages = normalizeChatMessages(
      [{ role: 'user', content: text }],
      systemMessage,
    ).messages;

    // ── Anthropic uses its own messages format ────────────────────────────
    if (provider === 'anthropic') {
      const baseUrl = ANTHROPIC_COMPATIBLE.anthropic;
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': api_key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          temperature: 0.3,
          messages: translatedMessages,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        return sendJson(res, response.status, {
          error: `Anthropic API error: ${errorBody}`,
        });
      }

      const data = (await response.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const translated =
        data.content?.find((c) => c.type === 'text')?.text || '';
      return sendJson(res, 200, { translated });
    }

    // ── All other providers: OpenAI-compatible format ─────────────────────
    const baseUrl = OPENAI_COMPATIBLE[provider];
    if (!baseUrl) {
      return sendJson(res, 400, {
        error: `Unsupported provider: ${provider}`,
      });
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(api_key ? { Authorization: `Bearer ${api_key}` } : {}),
      ...getProviderHeaders(provider),
    };

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0.3,
        max_tokens: 4096,
        messages: translatedMessages,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return sendJson(res, response.status, {
        error: `Provider API error: ${errorBody}`,
      });
    }

    const contentType = response.headers.get('content-type') || '';
    const responseText = await response.text();

    // Some providers (e.g. Hermes bridge) ignore stream:false and return SSE
    const trimmedText = responseText.trimStart();
    if (contentType.includes('text/event-stream') || trimmedText.startsWith('data: ')) {
      let translated = '';
      for (const line of responseText.split('\n')) {
        if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') continue;
        try {
          const chunk = JSON.parse(line.slice(6)) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const token = chunk.choices?.[0]?.delta?.content;
          if (token) translated += token;
        } catch {
          // skip unparseable lines
        }
      }
      return sendJson(res, 200, { translated: translated.trim() });
    }

    // Standard JSON response
    let data: { choices?: Array<{ message?: { content?: string } }> };
    try {
      data = JSON.parse(responseText);
    } catch {
      return sendJson(res, 502, {
        error: 'Provider returned unparseable response',
      });
    }
    const translated = data.choices?.[0]?.message?.content?.trim() || '';
    return sendJson(res, 200, { translated });
  } catch (err: unknown) {
    const message = getUnknownErrorMessage(err) || 'Translation failed';
    return sendJson(res, 500, { error: message });
  }
});

// ─── Health check ──────────────────────────────────────────────────────────

app.get('/functions/v1/health', (_req, res) => {
  sendJson(res, 200, { ok: true, routes: ['/functions/v1/chat', '/functions/v1/github-integration', '/functions/v1/github-analyzer', '/functions/v1/validate-key', '/functions/v1/chat-proxy', '/functions/v1/orchestrate', '/functions/v1/translate'] });
});

// ─── 404 catch-all (debug unmatched routes) ─────────────────────────────────

app.use((req, res) => {
  console.warn(`[server] 404 Not Found: ${req.method} ${req.originalUrl}`);
  sendJson(res, 404, { error: `Route not found: ${req.method} ${req.originalUrl}` });
});

  return app;
}

// ─── Start server ────────────────────────────────────────────────────────────

export function startServer(port?: number) {
  const resolvedPort = port || process.env.PORT || 3001;
  const app = createApp();
  return new Promise<{ app: typeof app; port: number }>((resolve) => {
    app.listen(resolvedPort, () => {
      console.log(`Local API server running on http://localhost:${resolvedPort}`);
      console.log('Routes:');
      console.log('  POST /functions/v1/chat');
      console.log('  POST /functions/v1/orchestrate');
      console.log('  POST /functions/v1/github-integration');
      console.log('  POST /functions/v1/github-analyzer');
      console.log('  POST /functions/v1/validate-key');
      console.log('  POST /functions/v1/chat-proxy');
      resolve({ app, port: Number(resolvedPort) });
    });
  });
}

// Auto-start when run directly (npm run server), not when imported by Electron
const isElectron = typeof process !== 'undefined' && !!process.versions?.electron;
if (!isElectron) {
  const isEntry = process.argv[1] && import.meta.url.includes(process.argv[1].replace(/\\/g, '/'));
  if (isEntry) {
    startServer();
  }
}

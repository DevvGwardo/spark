import { logger } from './logger';
import type express from 'express';
import { createUiMessageStreamWriter, UI_MESSAGE_STREAM_HEADERS } from './ui-message-stream';
import {
  OPENAI_COMPATIBLE,
  sanitizeCompatibleSseLine,
  streamingFetch,
} from '../provider-config';
import {
  isAbortLikeError,
  proxySseToDataStream,
  type NormalizedProxyEvent,
  type ProxyFinishReason,
  type ProxyUsage,
} from '../direct-sse-proxy';
import { bindClientDisconnect } from '../http-disconnect';
import { buildCorsHeaders } from './helpers';
import { getChatStore } from '../chat-store';
import { getHermesBridgeRoot } from './hermes-bridge-url';
import { randomUUID } from 'crypto';

// ─── Background Session Continuation ─────────────────────────────────────────
// Agent-loop runs keyed by conversationId. A client disconnect (window/tab
// closed) no longer aborts the upstream bridge stream — the run keeps going
// server-side and its final assistant message is persisted to the chat store
// so it appears when the conversation is reopened. An explicit Stop from the
// UI calls cancelHermesRun() to actually abort.
const activeAgentRuns = new Map<string, {
  controller: AbortController;
  startedAt: number;
  text: string;
  useRuns?: boolean;
}>();

const HERMES_BRIDGE_ROOT = getHermesBridgeRoot();

/** Usable Hermes bridge auth + provider pin headers.
 * Never send empty/placeholder Authorization — it confuses OpenRouter key
 * detection and can block CLI custom base_url demotion. Never pin openrouter
 * without a usable client key (stale picker defaults). */
function hermesBridgeAuthHeaders(
  apiKey: string | undefined | null,
  hermesProvider?: string | null,
): Record<string, string> {
  const hermesAuthKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  const hermesAuthUsable =
    hermesAuthKey.length > 0
    && !['undefined', 'null', 'none'].includes(hermesAuthKey.toLowerCase());
  const hermesProviderPin =
    hermesProvider
    && hermesProvider !== 'auto'
    && !(hermesProvider === 'openrouter' && !hermesAuthUsable)
      ? hermesProvider
      : undefined;
  return {
    ...(hermesAuthUsable ? { Authorization: `Bearer ${hermesAuthKey}` } : {}),
    ...(hermesProviderPin ? { 'X-Hermes-Provider': hermesProviderPin } : {}),
  };
}

async function stopHermesGatewayRun(conversationId: string): Promise<void> {
  try {
    await fetch(`${HERMES_BRIDGE_ROOT}/v1/runs/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversationId }),
    });
  } catch (error) {
    logger.warn(
      `[chat] Failed to stop gateway run for conversation=${conversationId}: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
}

export function cancelHermesRun(conversationId: string): boolean {
  const run = activeAgentRuns.get(conversationId);
  if (!run) return false;
  if (run.useRuns) {
    void stopHermesGatewayRun(conversationId);
  }
  run.controller.abort();
  activeAgentRuns.delete(conversationId);
  return true;
}

/** Conversations with a hermes run still in flight server-side. The sidebar
 * polls this so a run that outlives its window keeps showing as active. */
export function getActiveHermesRuns(): Array<{ conversationId: string; startedAt: number }> {
  return Array.from(activeAgentRuns.entries()).map(([conversationId, run]) => ({
    conversationId,
    startedAt: run.startedAt,
  }));
}

/** Text accumulated so far by an active run, so a reopened panel can show
 * in-flight output without the original stream. Null when no run is active. */
export function getHermesRunPartialText(conversationId: string): string | null {
  const run = activeAgentRuns.get(conversationId);
  return run ? run.text : null;
}

/** Persist a background-completed assistant turn so it isn't lost when the
 * client that started the stream is gone. Best-effort. */
function persistBackgroundAssistantMessage(conversationId: string, content: string): void {
  if (!content.trim()) return;
  try {
    const store = getChatStore();
    store.addMessage({
      id: randomUUID(),
      conversationId,
      role: 'assistant',
      content,
      timestamp: new Date().toISOString(),
    });
    store.updateConversation(conversationId, { updatedAt: new Date().toISOString() });
    logger.info(`[chat] Background hermes run persisted assistant message. conversation=${conversationId} chars=${content.length}`);
  } catch (error) {
    logger.error(`[chat] Failed to persist background assistant message: ${error instanceof Error ? error.message : error}`);
  }
}

export const DIRECT_COMPAT_PROXY_PROVIDERS = new Set([
  'minimax',
  'minimax-payg',
  'kimi',
  'kimi-coding',
]);

/**
 * Server-executed tool names that mutate state. In plan mode these are never
 * forwarded to the bridge (custom_tools) nor sent upstream by the compatible
 * proxy; read-only tools (read_repo_file, read_file, propose_changes, web
 * search, artifact creators, …) are kept.
 */
export const MUTATING_TOOL_NAMES = new Set([
  'run_command',
  'execute_python',
  'write_file',
  'edit_repo_file',
  'create_repo_file',
  'delete_repo_file',
  'batch_edit_repo_files',
]);

function toolNameOf(customTool: unknown): string | null {
  if (!customTool || typeof customTool !== 'object') {
    return null;
  }
  const record = customTool as { name?: unknown; function?: { name?: unknown } };
  if (typeof record.name === 'string' && record.name.trim().length > 0) {
    return record.name.trim();
  }
  if (typeof record.function?.name === 'string' && record.function.name.trim().length > 0) {
    return record.function.name.trim();
  }
  return null;
}

/** Strip mutating tool definitions from a client-supplied custom tool list. */
export function filterReadOnlyCustomTools(customTools: unknown[]): unknown[] {
  if (!Array.isArray(customTools)) {
    return customTools;
  }
  return customTools.filter((customTool) => {
    const name = toolNameOf(customTool);
    return name === null || !MUTATING_TOOL_NAMES.has(name);
  });
}

function createUpstreamHttpError(message: string, status: number, responseBody?: string): Error & {
  status: number;
  responseBody?: string;
} {
  const error = new Error(message) as Error & {
    status: number;
    responseBody?: string;
  };
  error.status = status;
  if (responseBody) {
    error.responseBody = responseBody;
  }
  return error;
}

export function shouldDirectProxyCompatibleProvider(provider: string, hasServerRepoContext: boolean): boolean {
  return DIRECT_COMPAT_PROXY_PROVIDERS.has(provider) && !hasServerRepoContext;
}

export function getCompatibleProviderChatUrl(provider: string): string {
  if (provider === 'kimi') {
    return 'https://api.moonshot.cn/v1/chat/completions';
  }

  if (provider === 'kimi-coding') {
    return 'https://api.kimi.com/coding/v1/chat/completions';
  }

  return `${OPENAI_COMPATIBLE[provider]}/chat/completions`;
}

export function normalizeHermesTextPart(part: unknown): string {
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

export function extractHermesDeltaText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part) => normalizeHermesTextPart(part)).join('');
  }

  return normalizeHermesTextPart(content);
}

export function normalizeHermesFinishReason(reason: unknown): ProxyFinishReason {
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

export function normalizeHermesUsage(usage: unknown): ProxyUsage {
  const record = usage && typeof usage === 'object'
    ? usage as {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        cached_input_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown };
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      }
    : {};

  const promptTokens = typeof record.prompt_tokens === 'number' ? record.prompt_tokens : 0;
  const completionTokens = typeof record.completion_tokens === 'number' ? record.completion_tokens : 0;
  const totalTokens = typeof record.total_tokens === 'number'
    ? record.total_tokens
    : promptTokens + completionTokens;

  const cachedRaw =
    typeof record.cached_input_tokens === 'number'
      ? record.cached_input_tokens
      : typeof record.prompt_tokens_details?.cached_tokens === 'number'
        ? record.prompt_tokens_details.cached_tokens
        : 0;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedInputTokens: Math.max(0, cachedRaw),
  };
}

export function extractHermesChoiceText(choice: {
  delta?: { content?: unknown };
  message?: { content?: unknown };
}): string {
  const deltaText = extractHermesDeltaText(choice.delta?.content);
  if (deltaText) {
    return deltaText;
  }
  return extractHermesDeltaText(choice.message?.content);
}

/**
 * Bridge custom fields that are forwarded to the client UNCHANGED (same field
 * names, raw payload). B1 (hermes-bridge) emits these inside
 * `choices[0].delta` and/or at the top level of the SSE payload; the server
 * normalizes them into `data` parts the client pre-scanner collects.
 */
const PASSTHROUGH_CUSTOM_FIELDS = [
  'tool_call_begin',
  'tool_call_delta',
  'tool_call_end',
  'stream_retry',
  'plan_update',
] as const;

function collectPassthroughCustomFields(
  source: Record<string, unknown>,
  data: Record<string, unknown>[],
): void {
  for (const field of PASSTHROUGH_CUSTOM_FIELDS) {
    const value = source[field];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      data.push({ type: field, ...(value as Record<string, unknown>) });
    }
  }
}

export function normalizeHermesAgentLoopPayload(payload: string): NormalizedProxyEvent | null {
  let parsed: {
    usage?: unknown;
    transport_status?: unknown;
    tool_activity?: unknown;
    server_tool_event?: unknown;
    agent_status?: unknown;
    fallback_switch?: unknown;
    approval_request?: unknown;
    tool_call_begin?: unknown;
    tool_call_delta?: unknown;
    tool_call_end?: unknown;
    stream_retry?: unknown;
    plan_update?: unknown;
    choices?: Array<{
      finish_reason?: unknown;
      delta?: {
        content?: unknown;
        reasoning?: unknown;
        tool_activity?: unknown;
        server_tool_event?: unknown;
        agent_status?: unknown;
        fallback_switch?: unknown;
        transport_status?: unknown;
        approval_request?: unknown;
        tool_call_begin?: unknown;
        tool_call_delta?: unknown;
        tool_call_end?: unknown;
        stream_retry?: unknown;
        plan_update?: unknown;
      };
      message?: {
        content?: unknown;
      };
    }>;
  };
  try {
    parsed = JSON.parse(payload);
  } catch {
    logger.error('[hermes] Failed to parse agent-loop SSE payload as JSON');
    return null;
  }

  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  const data: Record<string, unknown>[] = [];

  if (choice?.delta?.transport_status && typeof choice.delta.transport_status === 'object') {
    data.push({ type: 'transport_status', ...(choice.delta.transport_status as Record<string, unknown>) });
  }
  if (choice?.delta?.tool_activity && typeof choice.delta.tool_activity === 'object') {
    data.push({ type: 'hermes_tool_activity', activity: choice.delta.tool_activity as Record<string, unknown> });
  }
  if (choice?.delta?.server_tool_event && typeof choice.delta.server_tool_event === 'object') {
    data.push(choice.delta.server_tool_event as Record<string, unknown>);
  }
  if (choice?.delta?.agent_status && typeof choice.delta.agent_status === 'object') {
    data.push({ type: 'agent_status', status: choice.delta.agent_status as Record<string, unknown> });
  }
  if (choice?.delta?.fallback_switch && typeof choice.delta.fallback_switch === 'object') {
    const switchPayload = choice.delta.fallback_switch as Record<string, unknown>;
    data.push({
      type: 'fallback_switch',
      provider: switchPayload.provider,
      model: switchPayload.model,
    });
  }
  if (choice?.delta?.approval_request && typeof choice.delta.approval_request === 'object') {
    data.push({ type: 'approval_request', ...(choice.delta.approval_request as Record<string, unknown>) });
  }
  if (choice?.delta) {
    collectPassthroughCustomFields(choice.delta as Record<string, unknown>, data);
  }
  if (parsed.transport_status && typeof parsed.transport_status === 'object') {
    data.push({ type: 'transport_status', ...(parsed.transport_status as Record<string, unknown>) });
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
  if (parsed.fallback_switch && typeof parsed.fallback_switch === 'object') {
    const switchPayload = parsed.fallback_switch as Record<string, unknown>;
    data.push({
      type: 'fallback_switch',
      provider: switchPayload.provider,
      model: switchPayload.model,
    });
  }
  if (parsed.approval_request && typeof parsed.approval_request === 'object') {
    data.push({ type: 'approval_request', ...(parsed.approval_request as Record<string, unknown>) });
  }
  collectPassthroughCustomFields(parsed as Record<string, unknown>, data);

  const reasoning = typeof choice?.delta?.reasoning === 'string' ? choice.delta.reasoning : undefined;

  return {
    usage: normalizeHermesUsage(parsed.usage),
    finishReason: choice?.finish_reason !== undefined && choice?.finish_reason !== null
      ? normalizeHermesFinishReason(choice.finish_reason)
      : undefined,
    text: choice ? extractHermesChoiceText(choice) : '',
    reasoning,
    data,
  };
}

export function normalizeCompatibleProviderPayload(provider: string, payload: string): NormalizedProxyEvent | null {
  const sanitizedPayload = sanitizeCompatibleSseLine(provider, `data: ${payload}`).slice(6).trim();
  let parsed: {
    error?: { message?: string };
    base_resp?: { status_code?: number; status_msg?: string };
    usage?: unknown;
    choices?: Array<{
      finish_reason?: unknown;
      delta?: {
        content?: unknown;
        tool_calls?: Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      message?: { content?: unknown };
    }>;
  };
  try {
    parsed = JSON.parse(sanitizedPayload);
  } catch {
    logger.error(`[hermes] Failed to parse ${provider} SSE payload as JSON`);
    return null;
  }

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

  // OpenAI-compatible tool-call streaming fragments (plan-mode direct proxy):
  // forwarded to the client as AI SDK tool_call parts by the SSE proxy.
  const toolCalls: NormalizedProxyEvent['toolCalls'] = [];
  const rawToolCalls = choice.delta?.tool_calls;
  if (Array.isArray(rawToolCalls)) {
    for (const rawCall of rawToolCalls) {
      if (!rawCall || typeof rawCall !== 'object') {
        continue;
      }
      const index = typeof rawCall.index === 'number' ? rawCall.index : toolCalls.length;
      toolCalls.push({
        index,
        ...(typeof rawCall.id === 'string' ? { id: rawCall.id } : {}),
        ...(typeof rawCall.function?.name === 'string' ? { name: rawCall.function.name } : {}),
        ...(typeof rawCall.function?.arguments === 'string' ? { argumentsDelta: rawCall.function.arguments } : {}),
      });
    }
  }

  return {
    usage: normalizeHermesUsage(parsed.usage),
    finishReason: choice.finish_reason !== undefined && choice.finish_reason !== null
      ? normalizeHermesFinishReason(choice.finish_reason)
      : undefined,
    text: extractHermesChoiceText(choice),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

// Health URL: strip trailing /v1 from the hermes base URL to reach /health.
// The bridge exposes GET /health at the root, not under /v1.
const HERMES_HEALTH_URL = `${OPENAI_COMPATIBLE.hermes.replace(/\/v1\/?$/, '')}/health`;

// Bridge-readiness backstop. The Electron main process already polls /health
// for up to 30s at startup (see electron/bridge.ts waitForOwnedBridge), but
// chat requests can fire before that completes. Instead of pre-checking on
// every request (adds latency), we only poll when a fetch actually fails
// with a connection error — almost always a startup-race false negative.
const HERMES_READY_POLL_INTERVAL_MS = 300;
const HERMES_READY_POLL_TIMEOUT_MS = 15_000;
const HERMES_HEALTH_PROBE_TIMEOUT_MS = 1_000;

function isLikelyBridgeConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { name?: string; code?: string; message?: string; cause?: { code?: string; name?: string } };
  const CONN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET']);
  if (err.code && CONN_CODES.has(err.code)) return true;
  if (err.cause?.code && CONN_CODES.has(err.cause.code)) return true;
  // undici wraps low-level socket errors in a TypeError('fetch failed').
  // In practice undici always populates `cause` with the underlying error;
  // requiring it prevents test mocks (bare TypeError) from triggering the
  // 15-second readiness poll.
  if (err.name === 'TypeError' && (err.cause || err.message?.includes('fetch failed'))) return true;
  return false;
}

async function isHermesBridgeReachable(): Promise<boolean> {
  try {
    const res = await fetch(HERMES_HEALTH_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(HERMES_HEALTH_PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHermesBridgeReady(abortSignal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + HERMES_READY_POLL_TIMEOUT_MS;
  while (!abortSignal.aborted && Date.now() < deadline) {
    if (await isHermesBridgeReachable()) return true;
    if (abortSignal.aborted) return false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, HERMES_READY_POLL_INTERVAL_MS);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
  return false;
}

/**
 * Fetches the Hermes bridge with a one-shot readiness retry on connection
 * errors. Guards against the cold-start race where a chat request fires
 * before hermes-bridge/main.py has finished booting. Happy path adds no
 * overhead — only kicks in when the initial fetch rejects with a connection
 * error. If the bridge never becomes reachable within the poll budget, the
 * original error propagates so the caller's "not reachable" message surfaces.
 */
async function fetchHermesWithReadinessRetry(
  url: string,
  init: RequestInit,
  abortSignal: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (abortSignal.aborted) throw error;
    if (!isLikelyBridgeConnectionError(error)) throw error;

    logger.info('[chat] Hermes bridge fetch failed (connection error); polling /health up to %dms for readiness…', HERMES_READY_POLL_TIMEOUT_MS);
    const ready = await waitForHermesBridgeReady(abortSignal);
    if (!ready) throw error;
    logger.info('[chat] Hermes bridge became reachable; retrying fetch.');
    return await fetch(url, init);
  }
}

export async function proxyHermesAgentLoopToDataStream(input: {
  req: express.Request;
  res: express.Response;
  apiKey: string;
  model: string;
  messages: unknown[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  hermesToolsets?: string | null;
  hermesProvider?: string;
  repoEditIntent?: boolean;
  activeRepo?: { owner?: string; name?: string } | null;
  githubPAT?: string;
  hermesMiniMaxKey?: string;
  repoFileTree?: string[];
  customTools?: unknown[];
  activeProfile?: string;
  conversationId?: string;
  /** Hermes agent reasoning effort ('none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'|'ultra'). */
  reasoningEffort?: string;
  /** Phase 7: opt-in gateway /v1/runs transport via bridge translate layer. */
  hermesUseRuns?: boolean;
  /** Bridge execution mode: agent-loop (legacy in-process loop) or acp (real hermes-agent). */
  executionMode?: 'agent-loop' | 'acp';
  /** Run the agent in an isolated git worktree of the local checkout. */
  hermesWorktree?: boolean;
  /** Local checkout path the bridge uses as the worktree repo root / ACP cwd. */
  repoRoot?: string | null;
  /** Plan mode: the bridge restricts itself to read-only exploration. */
  planMode?: boolean;
}) {
  const bridgeUrl = `${OPENAI_COMPATIBLE.hermes}/chat/completions`;
  const abortController = new AbortController();
  // No hard wall-clock timeout — the bridge sends SSE heartbeats to keep the
  // connection alive, and the real Hermes agent has its own iteration budget.
  // Only abort on client disconnect (handled by bindClientDisconnect above).
  const combinedSignal = abortController.signal;
  const startedAt = Date.now();
  const repoLabel = input.activeRepo?.owner && input.activeRepo?.name
    ? `${input.activeRepo.owner}/${input.activeRepo.name}`
    : '-';
  let firstEventLogged = false;

  // With a conversationId we can persist the result, so a client disconnect
  // (window closed) lets the run continue in the background instead of
  // aborting. Explicit Stop goes through cancelHermesRun().
  const canRunInBackground = !!input.conversationId;
  if (input.conversationId) {
    // A newer run for the same conversation supersedes the old one.
    const prior = activeAgentRuns.get(input.conversationId);
    if (prior) {
      if (prior.useRuns) {
        void stopHermesGatewayRun(input.conversationId);
      }
      prior.controller.abort();
    }
    activeAgentRuns.set(input.conversationId, {
      controller: abortController,
      startedAt: Date.now(),
      text: '',
      useRuns: !!input.hermesUseRuns,
    });
  }
  const disconnect = bindClientDisconnect(input.req, input.res, () => {
    if (!canRunInBackground) {
      abortController.abort();
    } else {
      logger.info(`[chat] Client disconnected — hermes run continues in background. conversation=${input.conversationId}`);
    }
  });
  const unregisterRun = () => {
    if (input.conversationId && activeAgentRuns.get(input.conversationId)?.controller === abortController) {
      activeAgentRuns.delete(input.conversationId);
    }
  };

  let bridgeResponse: Response;
  try {
    logger.info(
      `[chat] Hermes agent-loop bridge fetch start. model=${input.model} repo=${repoLabel} toolsets=${input.hermesToolsets || '-'} runs=${input.hermesUseRuns ? '1' : '0'} t=${startedAt}`,
    );
    bridgeResponse = await fetchHermesWithReadinessRetry(bridgeUrl, {
      method: 'POST',
      headers: {
        ...hermesBridgeAuthHeaders(input.apiKey, input.hermesProvider),
        'Content-Type': 'application/json',
        ...(input.hermesToolsets ? { 'X-Hermes-Toolsets': input.hermesToolsets } : {}),
        'X-Hermes-Execution-Mode': input.executionMode ?? 'agent-loop',
        ...(input.hermesUseRuns ? { 'X-Hermes-Use-Runs': '1' } : {}),
        ...(input.activeProfile ? { 'X-Hermes-Profile': input.activeProfile } : {}),
        ...(input.activeRepo?.owner && input.activeRepo?.name
          ? {
              'X-Hermes-Repo-Owner': input.activeRepo.owner,
              'X-Hermes-Repo-Name': input.activeRepo.name,
              'X-Hermes-Repo-Edit-Intent': input.repoEditIntent ? '1' : '0',
            }
          : {}),
        ...(input.githubPAT ? { 'X-Hermes-Github-PAT': input.githubPAT } : {}),
        ...(input.hermesWorktree ? { 'X-Hermes-Worktree': '1' } : {}),
        ...(input.repoRoot ? { 'X-Hermes-Repo-Root': input.repoRoot } : {}),
        ...(input.hermesMiniMaxKey ? { 'X-Hermes-Minimax-Key': input.hermesMiniMaxKey } : {}),
        ...(input.conversationId ? { 'X-Hermes-Conversation-Id': input.conversationId } : {}),
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        temperature: input.temperature ?? 0.7,
        top_p: input.topP ?? 0.9,
        max_tokens: input.maxTokens ?? 32768,
        stream: true,
        // Plan mode: bridge restricts itself to read-only exploration and the
        // server strips mutating tools from any definitions it forwards.
        ...(input.planMode ? { plan_mode: true } : {}),
        ...(input.repoFileTree && input.repoFileTree.length > 0
          ? { repo_file_tree: input.repoFileTree }
          : {}),
        ...(input.customTools && input.customTools.length > 0
          ? {
              custom_tools: input.planMode
                ? filterReadOnlyCustomTools(input.customTools)
                : input.customTools,
            }
          : {}),
        ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
        ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
        ...(input.hermesUseRuns ? { hermes_use_runs: true } : {}),
      }),
      signal: combinedSignal,
    }, combinedSignal);
    logger.info(
      `[chat] Hermes agent-loop bridge headers received in ${Date.now() - startedAt}ms. status=${bridgeResponse.status} model=${input.model} repo=${repoLabel}`,
    );
  } catch (error) {
    unregisterRun();
    if (disconnect.isDisconnected() && isAbortLikeError(error)) {
      return;
    }
    throw new Error(
      `Hermes bridge is not reachable at ${OPENAI_COMPATIBLE.hermes}. ` +
      'Start hermes-bridge/main.py and try again.',
    );
  }

  if (!bridgeResponse.ok) {
    unregisterRun();
    const errorText = await bridgeResponse.text().catch(() => '');
    throw createUpstreamHttpError(
      errorText || `Hermes bridge error (${bridgeResponse.status})`,
      bridgeResponse.status,
      errorText,
    );
  }

  let accumulatedText = '';
  try {
    await proxySseToDataStream({
      req: input.req,
      res: input.res,
      upstreamResponse: bridgeResponse,
      corsHeaders: buildCorsHeaders(input.req.headers.origin),
      normalizePayload: normalizeHermesAgentLoopPayload,
      continueOnClientDisconnect: canRunInBackground,
      modelName: input.model,
      onText: (text) => {
        accumulatedText += text;
        // Mirror into the run registry so a reopened panel can poll the
        // in-flight output while the original client is gone.
        if (input.conversationId) {
          const run = activeAgentRuns.get(input.conversationId);
          if (run && run.controller === abortController) {
            run.text = accumulatedText;
          }
        }
      },
      onFirstEvent: (kind) => {
        if (firstEventLogged) {
          return;
        }
        firstEventLogged = true;
        logger.info(
          `[chat] Hermes agent-loop first ${kind} event emitted in ${Date.now() - startedAt}ms. model=${input.model} repo=${repoLabel}`,
        );
      },
      emptyTextFallback:
        'Hermes returned an empty response for this turn. Retry the request. If this keeps happening, inspect the Hermes bridge logs.',
    });

    // The client never saw the end of this stream — persist the completed
    // assistant turn so it shows up when the conversation is reopened.
    if (canRunInBackground && disconnect.isDisconnected() && !abortController.signal.aborted) {
      persistBackgroundAssistantMessage(input.conversationId!, accumulatedText);
    }
  } finally {
    unregisterRun();
  }
}

// ─── Loop Mode ───────────────────────────────────────────────────────────────
// Reruns the Hermes agent on the same goal until a judge verdict says the
// goal is met, bounded by a hard iteration cap and an optional wall-clock
// time budget. Each iteration streams into the same AI SDK data stream; loop
// progress is emitted as `hermes_loop_status` data parts the client renders.

export interface HermesLoopConfig {
  maxIterations: number;
  timeBudgetMinutes: number | null;
}

const LOOP_MAX_ITERATIONS_CAP = 25;

const LOOP_JUDGE_SYSTEM_PROMPT =
  'You are a strict completion judge. Given a user goal and the agent\'s latest attempt, ' +
  'decide whether the goal is fully met. Respond with ONLY a JSON object: ' +
  '{"met": boolean, "feedback": "if not met, concrete actionable feedback on what is missing or wrong"}. ' +
  'Be skeptical: partial work, unverified claims, or remaining errors mean met=false.';

function formatLoopStatusPart(status: {
  phase: 'agent' | 'judge' | 'done' | 'stopped' | 'error';
  iteration: number;
  maxIterations: number;
  stopReason?: string;
  feedback?: string;
}): Record<string, unknown> {
  return { type: 'hermes_loop_status', status };
}

/** Renders a compact iteration header injected between loop passes so the
 * chat transcript itself shows loop progress even without the toggle label. */
function formatLoopIterationHeader(iteration: number, maxIterations: number): string {
  return `\n\n---\n\n**Loop iteration ${iteration}/${maxIterations}**\n\n`;
}

const LOOP_JUDGE_MAX_ATTEMPTS = 3;
const LOOP_JUDGE_RETRY_DELAY_MS = 2000;

/** Asks the bridge (non-streaming) whether the goal is met. Retries transient
 * upstream failures (5xx, unparsable verdicts) before giving up; a persistent
 * judge error stops the loop rather than spinning forever. */
async function judgeLoopIteration(input: {
  apiKey: string;
  model: string;
  goal: string;
  attempt: string;
  activeProfile?: string;
  systemPrompt?: string;
  signal: AbortSignal;
}): Promise<{ met: boolean; feedback: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LOOP_JUDGE_MAX_ATTEMPTS; attempt++) {
    try {
      return await judgeLoopIterationOnce(input);
    } catch (error) {
      if (input.signal.aborted || isAbortLikeError(error)) {
        throw error;
      }
      // Only retry transient failures: upstream 5xx or unparsable verdicts.
      const status = (error as { status?: number })?.status;
      const transient = status === undefined || status >= 500;
      if (!transient || attempt === LOOP_JUDGE_MAX_ATTEMPTS) {
        throw error;
      }
      lastError = error;
      logger.warn(
        `[chat] Loop judge attempt ${attempt}/${LOOP_JUDGE_MAX_ATTEMPTS} failed (${error instanceof Error ? error.message : error}). Retrying in ${LOOP_JUDGE_RETRY_DELAY_MS * attempt}ms.`,
      );
      await new Promise((resolve) => setTimeout(resolve, LOOP_JUDGE_RETRY_DELAY_MS * attempt));
    }
  }
  throw lastError;
}

async function judgeLoopIterationOnce(input: {
  apiKey: string;
  model: string;
  goal: string;
  attempt: string;
  activeProfile?: string;
  systemPrompt?: string;
  signal: AbortSignal;
}): Promise<{ met: boolean; feedback: string }> {
  const response = await fetchHermesWithReadinessRetry(`${OPENAI_COMPATIBLE.hermes}/chat/completions`, {
    method: 'POST',
    headers: {
      // Omit empty Bearer — placeholders break custom CLI demotion / key detection.
      ...hermesBridgeAuthHeaders(input.apiKey),
      'Content-Type': 'application/json',
      // Judge is a single plain completion — bypass the bridge's agent loop so
      // `stream: false` is honored and we get a JSON body back, not SSE.
      'X-Hermes-Execution-Mode': 'passthrough',
      ...(input.activeProfile ? { 'X-Hermes-Profile': input.activeProfile } : {}),
    },
    body: JSON.stringify({
      model: input.model,
      stream: false,
      temperature: 0,
      max_tokens: 1024,
      // The judge must see the same constraints the agent ran with, or it
      // judges against a goal that was never actually given to the agent.
      ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
      messages: [
        { role: 'system', content: LOOP_JUDGE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `## Goal\n${input.goal}\n\n## Agent's latest attempt\n${input.attempt || '(empty response)'}\n\nIs the goal fully met?`,
        },
      ],
    }),
    signal: input.signal,
  }, input.signal);

  if (!response.ok) {
    throw createUpstreamHttpError(`Loop judge call failed (${response.status})`, response.status);
  }

  const payload = await response.json().catch(() => null) as
    | { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> }
    | null;
  const message = payload?.choices?.[0]?.message;
  // Reasoning models (e.g. deepseek) may leave `content` empty and put the
  // answer in `reasoning_content`, and/or wrap it in <think> tags or fences.
  const verdict =
    parseLoopJudgeVerdict(message?.content ?? '') ??
    parseLoopJudgeVerdict(message?.reasoning_content ?? '');
  if (!verdict) {
    throw new Error('Loop judge returned no parsable verdict.');
  }
  return verdict;
}

/** Extracts a {met, feedback} verdict from judge output that may include
 * <think> blocks, markdown code fences, or surrounding prose. Returns null
 * when no JSON object with a boolean `met` can be found. */
export function parseLoopJudgeVerdict(raw: string): { met: boolean; feedback: string } | null {
  const text = raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim() || raw.trim();
  if (!text) {
    return null;
  }
  const candidates: string[] = [];
  for (const fence of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    candidates.push(fence[1]);
  }
  // Balanced-brace scan: collect every top-level {...} span in the text.
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) {
        candidates.push(text.slice(start, i + 1));
        start = i;
        break;
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as { met?: unknown; feedback?: unknown };
      if (typeof parsed?.met === 'boolean') {
        return {
          met: parsed.met === true,
          feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '',
        };
      }
    } catch {
      // Not valid JSON — try the next candidate.
    }
  }
  return null;
}

export async function proxyHermesLoopToDataStream(input: {
  req: express.Request;
  res: express.Response;
  apiKey: string;
  model: string;
  messages: unknown[];
  loop: HermesLoopConfig;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  hermesToolsets?: string | null;
  hermesProvider?: string;
  repoEditIntent?: boolean;
  activeRepo?: { owner?: string; name?: string } | null;
  githubPAT?: string;
  hermesMiniMaxKey?: string;
  repoFileTree?: string[];
  customTools?: unknown[];
  activeProfile?: string;
  conversationId?: string;
  /** System prompt forwarded as a real system role on every loop iteration
   * (normalizeChatMessages folds it into a leading fake user message, which
   * only leads iteration 1 — follow-up turns and the judge would lose it). */
  systemPrompt?: string;
  /** Run the agent in an isolated git worktree of the local checkout. */
  hermesWorktree?: boolean;
  /** Local checkout path the bridge uses as the worktree repo root / ACP cwd. */
  repoRoot?: string | null;
}) {
  const maxIterations = Math.max(1, Math.min(LOOP_MAX_ITERATIONS_CAP, Math.floor(input.loop.maxIterations) || 1));
  const deadline = input.loop.timeBudgetMinutes && input.loop.timeBudgetMinutes > 0
    ? Date.now() + input.loop.timeBudgetMinutes * 60_000
    : null;

  const abortController = new AbortController();
  const disconnect = bindClientDisconnect(input.req, input.res, () => {
    abortController.abort();
  });

  const lastUserMessage = [...(input.messages as Array<{ role?: string; content?: unknown }>)]
    .reverse()
    .find((m) => m?.role === 'user');
  const goal = typeof lastUserMessage?.content === 'string'
    ? lastUserMessage.content
    : JSON.stringify(lastUserMessage?.content ?? '');

  input.res.writeHead(200, {
    ...buildCorsHeaders(input.req.headers.origin),
    ...UI_MESSAGE_STREAM_HEADERS,
  });

  const writePart = (chunk: string) => new Promise<void>((resolve) => {
    if (input.res.writableEnded) return resolve();
    const ok = input.res.write(chunk);
    if (ok) return resolve();
    input.res.once('drain', () => resolve());
  });
  // One writer for the whole loop response: every iteration's upstream stream
  // shares the text/reasoning block state so deltas never land in a closed or
  // duplicated part.
  const stream = createUiMessageStreamWriter(writePart);
  await stream.start();
  const emitLoopStatus = (status: Parameters<typeof formatLoopStatusPart>[0]) =>
    stream.data(formatLoopStatusPart(status));
  const emitText = (text: string) => stream.text(text);

  const conversation = [...input.messages] as Array<Record<string, unknown>>;
  let stopReason = 'max-iterations';
  let finalPhase: 'done' | 'stopped' | 'error' = 'stopped';

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (abortController.signal.aborted) return;
      if (deadline && Date.now() >= deadline) {
        stopReason = 'time-budget';
        break;
      }

      await emitLoopStatus({ phase: 'agent', iteration, maxIterations });
      if (iteration > 1) {
        await emitText(formatLoopIterationHeader(iteration, maxIterations));
      }

      const startedAt = Date.now();
      logger.info(`[chat] Hermes loop iteration ${iteration}/${maxIterations} start. model=${input.model}`);
      const bridgeResponse = await fetchHermesWithReadinessRetry(`${OPENAI_COMPATIBLE.hermes}/chat/completions`, {
        method: 'POST',
        headers: {
          ...hermesBridgeAuthHeaders(input.apiKey, input.hermesProvider),
          'Content-Type': 'application/json',
          ...(input.hermesToolsets ? { 'X-Hermes-Toolsets': input.hermesToolsets } : {}),
          'X-Hermes-Execution-Mode': 'agent-loop',
          ...(input.activeProfile ? { 'X-Hermes-Profile': input.activeProfile } : {}),
          ...(input.activeRepo?.owner && input.activeRepo?.name
            ? {
                'X-Hermes-Repo-Owner': input.activeRepo.owner,
                'X-Hermes-Repo-Name': input.activeRepo.name,
                'X-Hermes-Repo-Edit-Intent': input.repoEditIntent ? '1' : '0',
              }
            : {}),
          ...(input.githubPAT ? { 'X-Hermes-Github-PAT': input.githubPAT } : {}),
          ...(input.hermesWorktree ? { 'X-Hermes-Worktree': '1' } : {}),
          ...(input.repoRoot ? { 'X-Hermes-Repo-Root': input.repoRoot } : {}),
          ...(input.hermesMiniMaxKey ? { 'X-Hermes-Minimax-Key': input.hermesMiniMaxKey } : {}),
          ...(input.conversationId ? { 'X-Hermes-Conversation-Id': input.conversationId } : {}),
        },
        body: JSON.stringify({
          model: input.model,
          ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
          messages: conversation,
          temperature: input.temperature ?? 0.7,
          top_p: input.topP ?? 0.9,
          max_tokens: input.maxTokens ?? 32768,
          stream: true,
          ...(input.repoFileTree && input.repoFileTree.length > 0 ? { repo_file_tree: input.repoFileTree } : {}),
          ...(input.customTools && input.customTools.length > 0 ? { custom_tools: input.customTools } : {}),
          ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
        }),
        signal: abortController.signal,
      }, abortController.signal);

      if (!bridgeResponse.ok) {
        const errorText = await bridgeResponse.text().catch(() => '');
        throw createUpstreamHttpError(
          errorText || `Hermes bridge error (${bridgeResponse.status})`,
          bridgeResponse.status,
          errorText,
        );
      }

      let iterationText = '';
      await proxySseToDataStream({
        req: input.req,
        res: input.res,
        upstreamResponse: bridgeResponse,
        corsHeaders: {},
        normalizePayload: normalizeHermesAgentLoopPayload,
        manageResponse: false,
        stream,
        modelName: input.model,
        onText: (text) => {
          iterationText += text;
        },
      });
      logger.info(
        `[chat] Hermes loop iteration ${iteration} agent pass finished in ${Date.now() - startedAt}ms. chars=${iterationText.length}`,
      );
      if (abortController.signal.aborted || input.res.writableEnded) return;

      await emitLoopStatus({ phase: 'judge', iteration, maxIterations });
      const verdict = await judgeLoopIteration({
        apiKey: input.apiKey,
        model: input.model,
        goal,
        attempt: iterationText,
        activeProfile: input.activeProfile,
        systemPrompt: input.systemPrompt,
        signal: abortController.signal,
      });
      logger.info(`[chat] Hermes loop iteration ${iteration} verdict met=${verdict.met}`);

      if (verdict.met) {
        stopReason = 'verdict-met';
        finalPhase = 'done';
        // Surface the passing verdict inline so the transcript explains WHY
        // the loop stopped, not just that it did.
        if (verdict.feedback) {
          await emitText(`\n\n> ✅ **Loop verdict (met):** ${verdict.feedback}\n`);
        }
        await emitLoopStatus({ phase: 'done', iteration, maxIterations, stopReason, feedback: verdict.feedback });
        break;
      }

      // Not met — show the judge's critique inline before the next pass so
      // the user sees what the loop is fixing.
      if (verdict.feedback) {
        await emitText(`\n\n> 🔁 **Judge feedback (iteration ${iteration}):** ${verdict.feedback}\n`);
      }
      await emitLoopStatus({ phase: 'judge', iteration, maxIterations, feedback: verdict.feedback });

      if (iteration === maxIterations) {
        stopReason = 'max-iterations';
        break;
      }

      // Feed the judge's critique back as the next turn.
      conversation.push({ role: 'assistant', content: iterationText });
      conversation.push({
        role: 'user',
        content:
          'The goal is not fully met yet. A completion review found:\n\n' +
          `${verdict.feedback || 'The previous attempt was incomplete.'}\n\n` +
          'Address this feedback and continue working toward the original goal.',
      });
    }
  } catch (error) {
    if (disconnect.isDisconnected() && isAbortLikeError(error)) {
      return;
    }
    finalPhase = 'error';
    stopReason = error instanceof Error ? error.message : 'loop-error';
    logger.error(`[chat] Hermes loop failed: ${stopReason}`);
    if (!input.res.writableEnded) {
      await stream.error(`Loop mode stopped: ${stopReason}`);
    }
  }

  if (input.res.writableEnded || disconnect.isDisconnected()) {
    return;
  }

  if (finalPhase !== 'done') {
    await emitLoopStatus({ phase: finalPhase, iteration: 0, maxIterations, stopReason });
    if (finalPhase === 'stopped') {
      await emitText(
        `\n\n---\n\n_Loop stopped: ${stopReason === 'time-budget' ? 'time budget exhausted' : 'max iterations reached'} without meeting the goal._`,
      );
    }
  }

  await stream.finish('stop');
  await stream.done();
  input.res.end();
}

export async function proxyHermesSwarmToDataStream(input: {
  req: express.Request;
  res: express.Response;
  apiKey: string;
  model: string;
  messages: unknown[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  hermesToolsets?: string | null;
  activeRepo?: { owner?: string; name?: string } | null;
  githubPAT?: string;
  repoFileTree?: string[];
  customTools?: unknown[];
  activeProfile?: string;
  conversationId?: string;
}) {
  const bridgeUrl = `${OPENAI_COMPATIBLE.hermes}/swarm`;
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
    logger.info(
      `[chat] Hermes swarm bridge fetch start. model=${input.model} repo=${repoLabel} toolsets=${input.hermesToolsets || '-'} t=${startedAt}`,
    );
    bridgeResponse = await fetchHermesWithReadinessRetry(bridgeUrl, {
      method: 'POST',
      headers: {
        // Same empty-key hygiene as agent-loop (no placeholder Bearer).
        ...hermesBridgeAuthHeaders(input.apiKey),
        'Content-Type': 'application/json',
        ...(input.hermesToolsets ? { 'X-Hermes-Toolsets': input.hermesToolsets } : {}),
        'X-Hermes-Execution-Mode': 'swarm',
        ...(input.activeProfile ? { 'X-Hermes-Profile': input.activeProfile } : {}),
        ...(input.activeRepo?.owner && input.activeRepo?.name
          ? {
              'X-Hermes-Repo-Owner': input.activeRepo.owner,
              'X-Hermes-Repo-Name': input.activeRepo.name,
            }
          : {}),
        ...(input.githubPAT ? { 'X-Hermes-Github-PAT': input.githubPAT } : {}),
        ...(input.conversationId ? { 'X-Hermes-Conversation-Id': input.conversationId } : {}),
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        temperature: input.temperature ?? 0.7,
        top_p: input.topP ?? 0.9,
        max_tokens: input.maxTokens ?? 32768,
        stream: true,
        ...(input.repoFileTree && input.repoFileTree.length > 0
          ? { repo_file_tree: input.repoFileTree }
          : {}),
        ...(input.customTools && input.customTools.length > 0
          ? { custom_tools: input.customTools }
          : {}),
        ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
      }),
      signal: abortController.signal,
    }, abortController.signal);
    logger.info(
      `[chat] Hermes swarm bridge headers received in ${Date.now() - startedAt}ms. status=${bridgeResponse.status}`,
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
    throw createUpstreamHttpError(
      errorText || `Hermes bridge swarm error (${bridgeResponse.status})`,
      bridgeResponse.status,
      errorText,
    );
  }

  await proxySseToDataStream({
    req: input.req,
    res: input.res,
    upstreamResponse: bridgeResponse,
    corsHeaders: buildCorsHeaders(input.req.headers.origin),
    normalizePayload: normalizeHermesAgentLoopPayload,
    modelName: input.model,
    onFirstEvent: (kind) => {
      if (firstEventLogged) {
        return;
      }
      firstEventLogged = true;
      logger.info(
        `[chat] Hermes swarm first ${kind} event emitted in ${Date.now() - startedAt}ms. model=${input.model}`,
      );
    },
    emptyTextFallback:
      'Hermes swarm returned an empty response. Check hermes-bridge logs.',
  });
}

// ─── SSE Resume (Feature 8) ──────────────────────────────────────────────────
// Per-stream ring buffer of the last N SSE events, keyed by a server-generated
// streamId. Clients open `POST /api/hermes/chat/start` to mint a streamId,
// then `GET /api/hermes/chat/stream?id=<streamId>&since=<lastEventId>` to
// tail the live stream with replay of any buffered events past `since`.
//
// Buffer retention: entries live for 60s past the stream emitting `done` so a
// brief network blip can resume, then they're GC'd.

export interface HermesStreamBufferEvent {
  id: number;
  event?: string;
  data: string;
}

const HERMES_STREAM_BUFFER_CAPACITY = 200;
const HERMES_STREAM_BUFFER_TTL_MS = 60_000;
// Idle TTL for streams that are never finished: a client can POST
// /api/hermes/chat/start repeatedly without ever completing a chat, which
// would otherwise grow hermesStreams without bound.
const HERMES_STREAM_BUFFER_IDLE_TTL_MS = 5 * 60_000;

interface HermesStreamEntry {
  id: string;
  nextEventId: number;
  buffer: HermesStreamBufferEvent[];
  subscribers: Set<(evt: HermesStreamBufferEvent | { done: true }) => void>;
  done: boolean;
  expiresAt: number | null;
  evictionTimer: ReturnType<typeof setTimeout> | null;
}

const hermesStreams = new Map<string, HermesStreamEntry>();

function generateStreamId(): string {
  // Node 18+ / jsdom both expose crypto.randomUUID.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function __resetHermesStreamBuffersForTests(): void {
  for (const entry of hermesStreams.values()) {
    if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
  }
  hermesStreams.clear();
}

export function createHermesStreamBuffer(): HermesStreamEntry {
  const id = generateStreamId();
  const entry: HermesStreamEntry = {
    id,
    nextEventId: 1,
    buffer: [],
    subscribers: new Set(),
    done: false,
    expiresAt: null,
    evictionTimer: null,
  };
  hermesStreams.set(id, entry);
  // Evict never-finished streams so an attacker (or buggy client) minting
  // streamIds can't leak memory. finishHermesStream replaces this timer with
  // the post-done GC timer.
  entry.evictionTimer = setTimeout(() => {
    const current = hermesStreams.get(id);
    if (current && !current.done) {
      hermesStreams.delete(id);
    }
  }, HERMES_STREAM_BUFFER_IDLE_TTL_MS);
  // Don't keep the event loop alive solely for buffer GC.
  if (typeof entry.evictionTimer === 'object' && entry.evictionTimer && 'unref' in entry.evictionTimer) {
    (entry.evictionTimer as { unref: () => void }).unref();
  }
  return entry;
}

export function appendHermesStreamEvent(
  streamId: string,
  partial: { event?: string; data: string },
): HermesStreamBufferEvent | null {
  const entry = hermesStreams.get(streamId);
  if (!entry || entry.done) return null;
  const evt: HermesStreamBufferEvent = {
    id: entry.nextEventId++,
    event: partial.event,
    data: partial.data,
  };
  entry.buffer.push(evt);
  if (entry.buffer.length > HERMES_STREAM_BUFFER_CAPACITY) {
    entry.buffer.splice(0, entry.buffer.length - HERMES_STREAM_BUFFER_CAPACITY);
  }
  for (const subscriber of entry.subscribers) {
    subscriber(evt);
  }
  return evt;
}

export function finishHermesStream(streamId: string): void {
  const entry = hermesStreams.get(streamId);
  if (!entry || entry.done) return;
  entry.done = true;
  for (const subscriber of entry.subscribers) {
    subscriber({ done: true });
  }
  entry.subscribers.clear();
  entry.expiresAt = Date.now() + HERMES_STREAM_BUFFER_TTL_MS;
  // Cancel the idle-eviction timer from createHermesStreamBuffer; the post-done
  // TTL below takes over as the single eviction authority.
  if (entry.evictionTimer) {
    clearTimeout(entry.evictionTimer);
  }
  entry.evictionTimer = setTimeout(() => {
    hermesStreams.delete(streamId);
  }, HERMES_STREAM_BUFFER_TTL_MS);
  // Don't keep the event loop alive solely for buffer GC.
  if (typeof entry.evictionTimer === 'object' && entry.evictionTimer && 'unref' in entry.evictionTimer) {
    (entry.evictionTimer as { unref: () => void }).unref();
  }
}

function formatSseEvent(evt: HermesStreamBufferEvent): string {
  const parts = [`id: ${evt.id}`];
  if (evt.event) parts.push(`event: ${evt.event}`);
  // Split data on newlines per SSE spec.
  for (const line of evt.data.split('\n')) {
    parts.push(`data: ${line}`);
  }
  parts.push('', '');
  return parts.join('\n');
}

export function registerHermesStreamResumeRoute(app: express.Application): void {
  // Mint a streamId. Kept deliberately small — the full chat payload still
  // flows through /functions/v1/chat; this endpoint only allocates the buffer
  // that the streaming side will write into.
  app.post('/api/hermes/chat/start', (_req, res) => {
    const entry = createHermesStreamBuffer();
    res.status(200).json({ streamId: entry.id, resumeToken: entry.id });
  });

  app.get('/api/hermes/chat/stream', (req, res) => {
    const streamId = typeof req.query.id === 'string' ? req.query.id : '';
    const sinceRaw = typeof req.query.since === 'string' ? req.query.since : '';
    if (!streamId) {
      res.status(400).json({ error: 'missing id' });
      return;
    }

    const entry = hermesStreams.get(streamId);
    if (!entry) {
      // 410 Gone — the buffer has been GC'd (or never existed).
      res.status(410).json({ error: 'stream unknown or expired' });
      return;
    }

    const sinceId = sinceRaw ? Number.parseInt(sinceRaw, 10) : 0;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Replay buffered events with id > since immediately.
    for (const evt of entry.buffer) {
      if (evt.id > sinceId) {
        res.write(formatSseEvent(evt));
      }
    }

    if (entry.done) {
      res.end();
      return;
    }

    const subscriber = (msg: HermesStreamBufferEvent | { done: true }) => {
      if ('done' in msg) {
        res.end();
        entry.subscribers.delete(subscriber);
        return;
      }
      res.write(formatSseEvent(msg));
    };
    entry.subscribers.add(subscriber);

    req.on('close', () => {
      entry.subscribers.delete(subscriber);
    });
  });
}

export async function proxyCompatibleProviderToDataStream(input: {
  req: express.Request;
  res: express.Response;
  provider: string;
  apiKey: string;
  model: string;
  messages: unknown[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /**
   * Plan mode: forwards only read-only tool definitions upstream (the caller
   * passes the already-filtered set) and streams any upstream tool calls back
   * to the client as AI SDK tool_call parts.
   */
  planMode?: boolean;
  /** Read-only OpenAI function definitions forwarded upstream in plan mode. */
  planModeTools?: unknown[];
}) {
  const abortController = new AbortController();
  const disconnect = bindClientDisconnect(input.req, input.res, () => {
    abortController.abort();
  });

  let upstreamResponse: Response;
  try {
    // streamingFetch (not global fetch) so long MiniMax/Kimi generations are not
    // killed by undici's 300s body timeout.
    upstreamResponse = await streamingFetch(getCompatibleProviderChatUrl(input.provider), {
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
        // Plan mode: only read-only tools are defined, and only when the
        // caller actually built a read-only set (e.g. artifact creators).
        ...(input.planMode && input.planModeTools && Object.keys(input.planModeTools).length > 0
          ? {
              tools: Object.values(input.planModeTools),
              tool_choice: 'auto' as const,
            }
          : {}),
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
    modelName: input.model,
  });
}

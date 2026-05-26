import { logger } from './logger';
import type express from 'express';
import {
  OPENAI_COMPATIBLE,
  sanitizeCompatibleSseLine,
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

export const DIRECT_COMPAT_PROXY_PROVIDERS = new Set([
  'minimax',
  'minimax-payg',
  'kimi',
  'kimi-coding',
]);

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

export function normalizeHermesAgentLoopPayload(payload: string): NormalizedProxyEvent | null {
  let parsed: {
    usage?: unknown;
    tool_activity?: unknown;
    server_tool_event?: unknown;
    agent_status?: unknown;
    choices?: Array<{
      finish_reason?: unknown;
      delta?: {
        content?: unknown;
        reasoning?: unknown;
        tool_activity?: unknown;
        server_tool_event?: unknown;
        agent_status?: unknown;
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
      delta?: { content?: unknown };
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

  return {
    usage: normalizeHermesUsage(parsed.usage),
    finishReason: choice.finish_reason !== undefined && choice.finish_reason !== null
      ? normalizeHermesFinishReason(choice.finish_reason)
      : undefined,
    text: extractHermesChoiceText(choice),
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
  repoEditIntent?: boolean;
  activeRepo?: { owner?: string; name?: string } | null;
  githubPAT?: string;
  hermesMiniMaxKey?: string;
  repoFileTree?: string[];
  customTools?: unknown[];
  activeProfile?: string;
  conversationId?: string;
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

  const disconnect = bindClientDisconnect(input.req, input.res, () => {
    abortController.abort();
  });

  let bridgeResponse: Response;
  try {
    logger.info(
      `[chat] Hermes agent-loop bridge fetch start. model=${input.model} repo=${repoLabel} toolsets=${input.hermesToolsets || '-'} t=${startedAt}`,
    );
    bridgeResponse = await fetchHermesWithReadinessRetry(bridgeUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
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
        ...(input.repoFileTree && input.repoFileTree.length > 0
          ? { repo_file_tree: input.repoFileTree }
          : {}),
        ...(input.customTools && input.customTools.length > 0
          ? { custom_tools: input.customTools }
          : {}),
        ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
      }),
      signal: combinedSignal,
    }, combinedSignal);
    logger.info(
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
    throw createUpstreamHttpError(
      errorText || `Hermes bridge error (${bridgeResponse.status})`,
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
        Authorization: `Bearer ${input.apiKey}`,
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

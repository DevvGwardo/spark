/**
 * The single Node -> hermes-bridge HTTP client.
 *
 * Before this there were three independent fetch layers, each with its own
 * retry budget, auth header, timeout behaviour and error shape:
 *
 *   - server/routes/hermes-admin.ts   proxyTo + fetchWithBridgeReadinessRetry
 *   - server/lib/hermes.ts            chat/loop/swarm/cancel + health probes
 *   - assorted routes                 ad-hoc fetches with no timeout at all
 *
 * They disagreed in ways that were invisible until something broke: the admin
 * proxy retried for 30s on a connection error, the chat path had its own copy of
 * the same logic, and a token header was written out at four separate call sites
 * (one of which — the chat approvals forward — did not write it at all and
 * relied on the bridge's loopback exemption).
 *
 * Everything that was per-layer now lives here: the token, the profile header,
 * one readiness-retry budget, a default timeout, disconnect-aware abort, the
 * 10s read cache, and translation of every failure into the Phase 1.4 error
 * envelope.
 *
 * Rule: nothing outside this file may fetch the bridge. `rg "fetch\(" server/`
 * should only ever hit bridge-client.ts and genuine non-bridge calls (GitHub,
 * provider endpoints, the local API in the renderer).
 */

import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { logger } from './logger'
import { sendJson } from './helpers'
import { getProfileFromRequest } from './hermes-profiles'
import { getHermesBridgeRoot } from './hermes-bridge-url'
import { getActiveBridgeSupervisor } from '../../shared/bridge-supervisor'
import type { BridgeReadiness } from '../../shared/bridge-readiness'
// Aliased: an unqualified `Response` must stay the global fetch Response, which
// the Express import would otherwise shadow.
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express'
import {
  HERMES_RETRYABLE_CODES,
  isHermesErrorEnvelope,
  type HermesErrorCode,
  type HermesErrorEnvelopeShape,
} from './hermes-errors.gen'

export type { HermesErrorCode, HermesErrorEnvelopeShape }

export interface BridgeRequestOptions {
  /** Active Hermes profile. Falls back to the request's profile when omitted. */
  profile?: string
  /**
   * Per-request timeout. `null` disables it — chat streams pass null and rely on
   * the idle timeout instead, since a full agent turn legitimately outlives any
   * fixed budget.
   */
  timeoutMs?: number | null
  /** Streams only: abort if no bytes arrive for this long. */
  idleTimeoutMs?: number
  /** Wired to the client's `close` so a disconnect aborts the upstream request. */
  signal?: AbortSignal
  /** Retry across the bridge's startup window. Defaults true for GET/HEAD. */
  retryUntilReady?: boolean
  /** Bypass the read cache for this call (used after a mutation). */
  noCache?: boolean
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_IDLE_TIMEOUT_MS = 30_000
const BRIDGE_CACHE_TTL_MS = 10_000

// Matches electron/bridge.ts waitForOwnedBridge (30s). A cold uvicorn + FastAPI
// lifespan boot exceeds anything shorter, and first-paint /providers and
// /workspace/commands 502'd while the bridge was still starting.
const READY_POLL_INTERVAL_MS = 300
const READY_POLL_TIMEOUT_MS = 30_000

/**
 * Bridge paths whose GET responses are cached briefly.
 *
 * Unchanged from the admin proxy: these are the reads the UI hits on every panel
 * mount, and a 10s window removes a burst of identical roundtrips without making
 * the data feel stale. Disabled under vitest so tests observe real fetches.
 */
const CACHEABLE_BRIDGE_PATHS = new Set([
  '/health',
  '/v1/providers',
  '/workspace/commands',
  '/workspace/overview',
  '/workspace/skills',
  '/workspace/skills/hub',
  '/workspace/mcp-servers',
  '/workspace/mcp-catalog',
  '/messaging/platforms',
  '/plugins',
  '/hooks',
  '/portal/tools',
])

type CacheEntry = {
  status: number
  contentType: string
  body: string
  expiresAt: number
}

const readCache = new Map<string, CacheEntry>()
let cacheEnabled = process.env.VITEST !== 'true'

/**
 * Force the read cache on or off. Defaults to off under vitest so no test can
 * observe a stale read; the cache's own tests turn it on explicitly rather
 * than leaving that logic uncovered.
 */
export function setBridgeCacheEnabled(enabled: boolean): void {
  cacheEnabled = enabled
  if (!enabled) readCache.clear()
}

function cacheKey(path: string, profile: string): string {
  return `${path}\0${profile}`
}

function isCacheable(path: string): boolean {
  return CACHEABLE_BRIDGE_PATHS.has(path.split('?')[0] ?? path)
}

/**
 * Drop cached reads. Called on every mutation so an admin write is immediately
 * visible rather than up to 10s stale.
 */
export function invalidateBridgeReadCache(): void {
  readCache.clear()
}

// --- Error mapping ----------------------------------------------------------------

/** Connection-level failures, i.e. the bridge is not answering at all. */
export function isLikelyBridgeConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as {
    name?: string
    code?: string
    message?: string
    cause?: { code?: string; name?: string }
  }
  const CONN_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
  ])
  if (err.code && CONN_CODES.has(err.code)) return true
  if (err.cause?.code && CONN_CODES.has(err.cause.code)) return true
  if (err.name === 'TypeError' && (err.cause || err.message?.includes('fetch failed'))) return true
  return false
}

function abortReason(error: unknown): 'timeout' | 'cancelled' | null {
  if (!error || typeof error !== 'object') return null
  const name = (error as { name?: string }).name
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  if ((error as { code?: string }).code === 'ABORT_ERR') return 'cancelled'
  return null
}

/**
 * Build a contract-shaped envelope. Every exit from this module goes through
 * here, so the UI never receives a shape it cannot switch on.
 */
export function bridgeErrorEnvelope(
  code: HermesErrorCode,
  message: string,
  details?: Record<string, unknown>,
): HermesErrorEnvelopeShape {
  return {
    error: {
      code,
      message,
      retryable: HERMES_RETRYABLE_CODES.has(code),
      ...(details ? { details } : {}),
    },
  }
}

function errorForThrown(
  error: unknown,
  path: string,
  bridgeUrl: string,
  callerSignal?: AbortSignal,
): { envelope: HermesErrorEnvelopeShape; status: number } {
  if (isLikelyBridgeConnectionError(error)) {
    return {
      envelope: bridgeErrorEnvelope(
        'BRIDGE_UNREACHABLE',
        `Could not reach the Hermes bridge at ${bridgeUrl}.`,
        { bridge_url: bridgeUrl },
      ),
      status: 502,
    }
  }
  // The caller's own abort outranks a timeout: they asked to stop, so telling
  // them to retry would be wrong.
  const aborted = callerSignal?.aborted ? 'cancelled' : abortReason(error)
  if (aborted === 'timeout') {
    return {
      envelope: bridgeErrorEnvelope(
        'UPSTREAM_TIMEOUT',
        `The Hermes bridge did not respond to ${path} in time.`,
      ),
      status: 504,
    }
  }
  if (aborted === 'cancelled') {
    return {
      envelope: bridgeErrorEnvelope('INTERNAL', 'The Hermes request was cancelled.'),
      status: 499,
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return {
    envelope: bridgeErrorEnvelope('INTERNAL', message || 'The Hermes bridge request failed.'),
    status: 502,
  }
}

/**
 * Normalize a non-OK bridge response into the envelope.
 *
 * A bridge that already speaks the contract (Phase 1.4) is passed through
 * untouched. Anything else — a legacy shape, a bare {"detail": ...}, a plain-text
 * upstream error — is wrapped, classified by status, and never re-emitted raw.
 */
function envelopeFromResponse(
  status: number,
  rawText: string,
): HermesErrorEnvelopeShape {
  let parsed: unknown
  try {
    parsed = rawText ? JSON.parse(rawText) : undefined
  } catch {
    parsed = undefined
  }
  if (isHermesErrorEnvelope(parsed)) return parsed

  // Legacy shapes the bridge used to emit, kept only long enough to translate.
  let legacyMessage = rawText.trim()
  if (parsed && typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>
    const inner = record.error
    if (typeof inner === 'string') legacyMessage = inner
    else if (inner && typeof inner === 'object') {
      const msg = (inner as Record<string, unknown>).message
      if (typeof msg === 'string') legacyMessage = msg
    } else if (typeof record.detail === 'string') legacyMessage = record.detail
    else if (typeof record.message === 'string') legacyMessage = record.message
  }
  if (!legacyMessage) legacyMessage = `The Hermes bridge returned ${status}.`

  const code: HermesErrorCode =
    status === 401 || status === 403
      ? 'BRIDGE_AUTH'
      : status === 404
        ? 'VALIDATION'
        : status === 503
          ? 'BRIDGE_STARTING'
          : status === 504
            ? 'UPSTREAM_TIMEOUT'
            : status === 408
              ? 'UPSTREAM_TIMEOUT'
              : status >= 500
                ? 'PROVIDER_ERROR'
                : 'VALIDATION'

  return bridgeErrorEnvelope(code, legacyMessage, { provider_status: status })
}

// --- Readiness -------------------------------------------------------------------

/**
 * One cached health verdict, shared by every caller.
 *
 * Previously each layer polled `/health` on its own schedule, so a cold start
 * produced concurrent poll storms. Probes are single-flighted and the result is
 * held briefly, so N callers arriving together cost one request.
 */
type Readiness = { ready: boolean; checkedAt: number }
let readiness: Readiness | null = null
let readinessInFlight: Promise<boolean> | null = null
const READINESS_TTL_MS = 1_000

async function probeHealth(bridgeUrl: string, signal?: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(1_000)
  const composite = signal ? AbortSignal.any([timeout, signal]) : timeout
  try {
    const response = await fetch(`${bridgeUrl}/health`, {
      signal: composite,
      headers: bridgeHeaders(),
    })
    return response.ok
  } catch {
    return false
  }
}

// Unmanaged bridges (started by hand / a script) have no supervisor, so their
// readiness is derived from the cached probe. `since` tracks the last flip.
let unmanagedSince = Date.now()
let unmanagedLastReady: boolean | null = null

function readinessFromProbe(): BridgeReadiness {
  const ready = readiness?.ready ?? null
  if (ready !== unmanagedLastReady) {
    unmanagedLastReady = ready
    unmanagedSince = readiness?.checkedAt ?? Date.now()
  }
  return {
    state: ready === null ? 'starting' : ready ? 'ready' : 'stopped',
    since: unmanagedSince,
    attempt: 0,
    lastError: ready === false ? 'The Hermes bridge is not reachable.' : null,
    stderrTail: [],
  }
}

/**
 * The single readiness state (Phase 3.3).
 *
 * When this process supervises the bridge (Electron, or MANAGE_BRIDGE=true) the
 * supervisor's state machine is authoritative and nothing here probes. Otherwise
 * it falls back to the cached /health verdict.
 */
export function bridgeReadiness(): BridgeReadiness {
  return getActiveBridgeSupervisor()?.readiness() ?? readinessFromProbe()
}

/**
 * Readiness for the `/api/bridge/readiness` route: like `bridgeReadiness()`, but
 * refreshes a stale probe first when no supervisor owns the bridge.
 */
export async function currentBridgeReadiness(): Promise<BridgeReadiness> {
  const supervisor = getActiveBridgeSupervisor()
  if (supervisor) return supervisor.readiness()
  if (!readiness || Date.now() - readiness.checkedAt >= READINESS_TTL_MS) {
    const bridgeUrl = getHermesBridgeRoot().replace(/\/+$/, '')
    const ok = await probeHealth(bridgeUrl)
    readiness = { ready: ok, checkedAt: Date.now() }
  }
  return readinessFromProbe()
}

async function waitForBridge(bridgeUrl: string, signal?: AbortSignal): Promise<boolean> {
  // Supervised: follow the state machine instead of running a second poll loop.
  // crashed/stopped fail fast — retrying for 30s against a dead bridge only
  // delays the error the UI needs to show.
  const supervisor = getActiveBridgeSupervisor()
  if (supervisor) {
    const { state } = supervisor.readiness()
    if (state === 'crashed' || state === 'stopped') return false
    // "ready" can lag a just-died process by one exit event; confirm once.
    if (state === 'ready' && (await probeHealth(bridgeUrl, signal))) return true
    return supervisor.waitForReady(READY_POLL_TIMEOUT_MS, signal)
  }

  const now = Date.now()
  if (readiness && now - readiness.checkedAt < READINESS_TTL_MS) {
    return readiness.ready
  }
  if (readinessInFlight) return readinessInFlight

  readinessInFlight = (async () => {
    const deadline = Date.now() + READY_POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (signal?.aborted) break
      const ok = await probeHealth(bridgeUrl, signal)
      readiness = { ready: ok, checkedAt: Date.now() }
      if (ok) return true
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS))
    }
    return false
  })().finally(() => {
    readinessInFlight = null
  })

  return readinessInFlight
}

/** Reset the cached health verdict. Used by tests and by bridge restarts. */
export function resetBridgeReadiness(): void {
  readiness = null
  readinessInFlight = null
  unmanagedLastReady = null
  unmanagedSince = Date.now()
}

// --- Headers ---------------------------------------------------------------------

function bridgeToken(): string {
  return (process.env.HERMES_BRIDGE_TOKEN || '').trim()
}

/**
 * The token is attached unconditionally here, which is the fix for the chat
 * approval path having relied on the bridge's loopback exemption (G2).
 */
function bridgeHeaders(profile?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = bridgeToken()
  if (token) headers['X-Hermes-Bridge-Token'] = token
  if (profile) headers['X-Hermes-Profile'] = profile
  return headers
}

function resolveProfile(
  options?: BridgeRequestOptions,
  req?: ExpressRequest,
): string | undefined {
  if (options?.profile) return options.profile
  if (req) {
    try {
      return getProfileFromRequest(req)
    } catch {
      return undefined
    }
  }
  return undefined
}

function shouldRetryUntilReady(method: string, options?: BridgeRequestOptions): boolean {
  if (options?.retryUntilReady !== undefined) return options.retryUntilReady
  // Only idempotent verbs get the startup grace period. A POST that may have
  // reached the bridge must not be replayed.
  return method === 'GET' || method === 'HEAD'
}

/**
 * Resolve a target to an absolute URL. An absolute input is used as-is: callers
 * that already built a URL from the OpenAI-compat base (which carries its own
 * `/v1`) would otherwise get the prefix joined twice.
 */
function bridgeUrlFor(bridgeUrl: string, target: string): string {
  if (/^https?:\/\//i.test(target)) return target
  return `${bridgeUrl}${target.startsWith('/') ? target : `/${target}`}`
}

// --- Core request ----------------------------------------------------------------

function buildSignals(
  opts: BridgeRequestOptions,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  const parts: AbortSignal[] = []
  if (opts.signal) parts.push(opts.signal)
  if (opts.timeoutMs !== null && opts.timeoutMs !== undefined) {
    parts.push(AbortSignal.timeout(opts.timeoutMs))
  } else if (opts.timeoutMs === undefined) {
    parts.push(AbortSignal.timeout(DEFAULT_TIMEOUT_MS))
  }
  if (parts.length === 0) return { signal: undefined, cleanup: () => {} }
  if (parts.length === 1) return { signal: parts[0]!, cleanup: () => {} }
  return { signal: AbortSignal.any(parts), cleanup: () => {} }
}

async function request(
  path: string,
  init: RequestInit = {},
  opts: BridgeRequestOptions = {},
): Promise<Response> {
  const bridgeUrl = getHermesBridgeRoot().replace(/\/+$/, '')
  const url = bridgeUrlFor(bridgeUrl, path)
  const method = (init.method ?? 'GET').toUpperCase()
  const { signal } = buildSignals(opts)

  const doFetch = () =>
    fetch(url, {
      ...init,
      signal,
      headers: {
        ...bridgeHeaders(resolveProfile(opts)),
        ...(init.headers as Record<string, string> | undefined),
      },
    })

  try {
    return await doFetch()
  } catch (error) {
    // Only a *connection* failure is retried. A timeout or an abort is final:
    // replaying a request the bridge may have already received is how you get
    // duplicate tool calls.
    if (
      !isLikelyBridgeConnectionError(error) ||
      !shouldRetryUntilReady(method, opts) ||
      opts.signal?.aborted
    ) {
      throw error
    }
    const ready = await waitForBridge(bridgeUrl, opts.signal)
    if (!ready) throw error
    logger.info('[bridge] Hermes bridge became reachable; retrying %s %s', method, path)
    return await doFetch()
  }
}

/** GET/HEAD returning parsed JSON. Throws a contract-shaped error on failure. */
export async function bridgeJson<T>(
  path: string,
  init: RequestInit = {},
  opts: BridgeRequestOptions = {},
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') invalidateBridgeReadCache()

  let response: Response
  try {
    response = await request(path, init, opts)
  } catch (error) {
    if ((error as { hermesError?: unknown }).hermesError) throw error
    const { envelope, status } = errorForThrown(
      error,
      path,
      getHermesBridgeRoot().replace(/\/+$/, ''),
      opts.signal,
    )
    throw Object.assign(new Error(envelope.error.message), {
      hermesError: envelope,
      status,
    })
  }

  const rawText = await response.text()

  if (!response.ok) {
    const envelope = envelopeFromResponse(response.status, rawText)
    throw Object.assign(new Error(envelope.error.message), {
      hermesError: envelope,
      status: response.status,
    })
  }

  if (!rawText) return undefined as T
  try {
    return JSON.parse(rawText) as T
  } catch {
    const envelope = bridgeErrorEnvelope(
      'INTERNAL',
      'The Hermes bridge returned a non-JSON response.',
    )
    throw Object.assign(new Error(envelope.error.message), {
      hermesError: envelope,
      status: 502,
    })
  }
}

/**
 * Open a streaming response (SSE). The caller owns the body.
 *
 * A non-OK response is returned rather than thrown, so callers can preserve the
 * upstream status; see the note at the guard below.
 *
 * The idle timeout aborts only when no bytes arrive for `idleTimeoutMs`, which is
 * what a chat stream needs: a long turn is fine, a wedged upstream is not.
 */
export async function bridgeStream(
  path: string,
  init: RequestInit = {},
  opts: BridgeRequestOptions = {},
): Promise<Response> {
  const controller = new AbortController()
  const abortAll = () => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', abortAll, { once: true })
  }

  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(), idleMs)
  }
  armIdle()

  const release = () => {
    if (idleTimer) clearTimeout(idleTimer)
    opts.signal?.removeEventListener('abort', abortAll)
  }

  const response = await request(path, { ...init, signal: controller.signal }, {
    ...opts,
    timeoutMs: null,
  })

  if (!response.ok) {
    // Returned, not thrown. Callers on the chat path already branch on `.ok` and
    // deliberately preserve the upstream status and body — a 401 for a missing
    // provider key has to reach the client as a 401, not as a collapsed 503.
    // Only transport failures (unreachable, timeout, abort) throw, and those
    // carry the contract envelope.
    release()
    return response
  }

  // Wrap the body so the idle timer resets on every chunk. A long turn is fine;
  // a wedged upstream is not.
  if (response.body) {
    const source = response.body;
    const wrapped = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = source.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            armIdle();
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          reader.releaseLock();
        }
      },
      cancel(reason) {
        release()
        void source.cancel(reason).catch(() => {})
      },
    });
    return new Response(wrapped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  release()
  return response
}

/**
 * Stream a bridge response straight through to an Express response.
 *
 * Used by the admin proxy for large bodies (workspace file reads) where buffering
 * would be wasteful, and for SSE.
 */
async function pipeTo(res: ExpressResponse, response: Response): Promise<void> {
  const contentType = response.headers.get('content-type') ?? 'application/json'
  res.status(response.status).type(contentType)
  if (response.body) {
    await pipeline(
      Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream),
      res,
    )
  } else {
    res.end()
  }
}

/**
 * Proxy a request to the bridge and mirror the result onto `res`.
 *
 * Replaces the 100-odd `proxyTo(req, res, path)` call sites unchanged, and is
 * the only place that knows about the read cache, error envelopes and abort.
 */
export async function bridgeProxy(
  req: ExpressRequest,
  res: ExpressResponse,
  path: string,
  options: RequestInit = {},
  opts: BridgeRequestOptions = {},
): Promise<void> {
  const method = (options.method ?? 'GET').toUpperCase();
  const profile = resolveProfile(opts, req) ?? '';
  const isGet = method === 'GET';
  const cacheable = isGet && isCacheable(path) && !opts.noCache;

  if (!isGet) invalidateBridgeReadCache();

  if (cacheEnabled && cacheable) {
    const cached = readCache.get(cacheKey(path, profile));
    if (cached && cached.expiresAt > Date.now()) {
      const maxAge = Math.max(0, Math.floor((cached.expiresAt - Date.now()) / 1000));
      res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
      res.status(cached.status).type(cached.contentType).send(cached.body);
      return;
    }
  }

  // Mirror an inbound client disconnect onto the upstream request, so closing the
  // tab actually stops the bridge work instead of orphaning it (G3).
  const abortController = new AbortController();
  const onClose = () => abortController.abort();
  req.on?.('close', onClose);
  req.on?.('aborted', onClose);

  try {
    const response = await request(path, options, {
      ...opts,
      profile,
      signal: abortController.signal,
    });

    if (!response.ok) {
      const rawText = await response.text();
      const { error } = envelopeFromResponse(response.status, rawText);
      return sendJson(res, response.status, { error });
    }

    if (isGet && !isCacheable(path)) {
      await pipeTo(res, response);
      return;
    }

    const contentType = response.headers.get('content-type') ?? 'application/json';
    const rawText = await response.text();

    if (cacheEnabled && cacheable) {
      readCache.set(cacheKey(path, profile), {
        status: response.status,
        contentType,
        body: rawText,
        expiresAt: Date.now() + BRIDGE_CACHE_TTL_MS,
      });
      res.setHeader('Cache-Control', `public, max-age=${Math.floor(BRIDGE_CACHE_TTL_MS / 1000)}`);
    } else {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    }

    res.status(response.status).type(contentType).send(rawText);
  } catch (err) {
    const bridgeUrl = getHermesBridgeRoot();
    const { envelope, status } = errorForThrown(err, path, bridgeUrl);
    logger.error('[bridge] Proxy error for %s: %s', path, envelope.error.message);
    // A cancelled request has no client left to answer.
    if (status === 499) {
      if (!res.headersSent) res.status(499)
      return;
    }
    return sendJson(res, status, { error: envelope.error });
  } finally {
    req.off?.('close', onClose);
    req.off?.('aborted', onClose);
  }
}

/**
 * The raw request primitive, for callers that need the `Response` itself.
 *
 * Health probes in particular branch on `.ok` and on the status code rather than
 * on a parsed body, so `bridge.json` would throw away information they need.
 * Non-OK responses are returned, not thrown — only transport failures throw, and
 * those carry the contract envelope.
 */
export const bridgeRequest = request

export const bridge = {
  json: bridgeJson,
  request: bridgeRequest,
  stream: bridgeStream,
  proxy: bridgeProxy,
  readiness: bridgeReadiness,
  invalidateCache: invalidateBridgeReadCache,
  resetReadiness: resetBridgeReadiness,
  errorEnvelope: bridgeErrorEnvelope,
}

export default bridge

/**
 * maiavm (hermes-deploy) endpoints Spark uses for the nub sign-in and agent.
 *
 * Sign-in is the desktop app's device-code link (approved in Telegram), then
 * `/api/nub/cli/key` trades the session for an OpenAI-compatible model key.
 * Agent calls go through the same bearer routes the Nub desktop app uses.
 */

import { getNubOrigin } from '../../provider-config';
import type { NubInstance } from './store';

const REQUEST_TIMEOUT_MS = 30_000;
/** A nub agent turn can take a while; maiavm caps it at its own lifetime. */
const ASK_TIMEOUT_MS = 300_000;
/** Spark's messages to the agent go to their own conversation. */
export const AGENT_SESSION_ID = 'spark-desktop';

export type LinkStart = {
  code: string;
  telegramUrl: string;
  pairingUrl?: string;
  expiresAt?: string;
  pollInterval?: number;
};

export type LinkPoll =
  | { status: 'pending' }
  | { status: 'needs_subscription'; telegramUrl: string }
  | { status: 'provisioning'; instanceStatus?: string }
  | { status: 'ready'; desktopToken: string; instance: NubInstance }
  | { status: 'expired' | 'denied' | 'not_found' | 'provision_failed' | 'error' };

export type MintedKey = {
  rawKey: string;
  keyPrefix: string;
  expiresAt: number;
  baseUrl: string;
  models: Array<{ id: string; contextLength?: number; supportsTools?: boolean }>;
};

export class NubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'NubApiError';
  }
}

export function sparkUserAgent(): string {
  const version = process.env.npm_package_version || '1.0';
  return `Spark/${version} (${process.platform}; ${process.arch})`;
}

export class NubClient {
  constructor(
    readonly origin: string = getNubOrigin(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  startLink(nonceHash: string): Promise<LinkStart> {
    return this.json('POST', '/api/nub/desktop/auth/start', { body: { browserNonceHash: nonceHash } });
  }

  /** Status bodies come back on 403/404/429 too; only an unreadable body is an error. */
  async pollLink(code: string, nonce: string): Promise<LinkPoll> {
    const res = await this.request('GET', `/api/nub/desktop/auth/poll?code=${encodeURIComponent(code)}`, {
      headers: { 'x-nub-link-nonce': nonce },
    });
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    if (!body?.status) throw new NubApiError(`unexpected sign-in status (HTTP ${res.status})`, res.status);
    return body as LinkPoll;
  }

  mintKey(desktopToken: string): Promise<MintedKey> {
    return this.json('POST', '/api/nub/cli/key', { token: desktopToken, body: { client: 'spark' } });
  }

  me(desktopToken: string): Promise<{ instance: NubInstance | null }> {
    return this.json('GET', '/api/nub/desktop/me', { token: desktopToken });
  }

  /** Disconnects the session on maiavm; its model key is revoked with it. */
  async revokeSession(desktopToken: string): Promise<void> {
    await this.json('POST', '/api/nub/desktop/me', {
      token: desktopToken,
      body: { action: 'revoke' },
      timeoutMs: ASK_TIMEOUT_MS,
    });
  }

  async ask(desktopToken: string, instanceId: string, message: string): Promise<string> {
    const body = await this.json<{ choices?: Array<{ message?: { content?: unknown } }> }>('POST', '/api/chat', {
      token: desktopToken,
      body: { instanceId, message, sessionId: AGENT_SESSION_ID, stream: false },
      timeoutMs: ASK_TIMEOUT_MS,
    });
    const content = body.choices?.[0]?.message?.content;
    if (content === undefined || content === null) throw new NubApiError('the nub agent sent an empty reply', 502);
    return typeof content === 'string' ? content : JSON.stringify(content);
  }

  private async json<T>(
    method: string,
    path: string,
    options: { token?: string; body?: unknown; timeoutMs?: number },
  ): Promise<T> {
    const res = await this.request(method, path, options);
    const text = await res.text();
    if (!res.ok) throw new NubApiError(describeNubError(res.status, text), res.status);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new NubApiError(`unexpected response from maiavm (HTTP ${res.status})`, res.status);
    }
  }

  private request(
    method: string,
    path: string,
    options: { token?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<Response> {
    const headers: Record<string, string> = { 'user-agent': sparkUserAgent(), ...options.headers };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    return this.fetchImpl(`${this.origin}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  }
}

/** One readable line from a maiavm error body. */
export function describeNubError(status: number, body: string): string {
  let message: string | undefined;
  let detail: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; detail?: unknown };
    if (typeof parsed.error === 'string') message = parsed.error;
    else if (parsed.error && typeof (parsed.error as { message?: unknown }).message === 'string') {
      message = (parsed.error as { message: string }).message;
    }
    if (typeof parsed.detail === 'string') detail = parsed.detail;
  } catch {
    // not JSON
  }
  const hint =
    status === 401 ? ' (sign-in expired or revoked — sign in to Nub again)'
    : status === 402 ? ' (deploy a nub agent at maiavm.com first)'
    : status === 429 ? ' (rate limited — try again in a minute)'
    : '';
  if (message && detail) return `${message}: ${detail}${hint}`;
  if (message) return `${message}${hint}`;
  return `HTTP ${status}${hint}`;
}

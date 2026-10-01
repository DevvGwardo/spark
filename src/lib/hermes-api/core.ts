import { getApiBaseUrl } from '../api';
import { getActiveProfile } from '@/stores/profiles-store';

const BRIDGE_BASE = '/api/hermes';

/** jsdom / older runtimes may lack AbortSignal.timeout — polyfill with AbortController. */
export function abortAfter(ms: number): AbortSignal {
  const timeoutFn = (AbortSignal as typeof AbortSignal & {
    timeout?: (delay: number) => AbortSignal;
  }).timeout;
  if (typeof timeoutFn === 'function') {
    return timeoutFn(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // Avoid keeping the process awake in Node if the request finishes early.
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref?.();
  }
  return controller.signal;
}

export class HermesApiError extends Error {
  status: number;
  data: Record<string, unknown>;

  constructor(message: string, status: number, data: Record<string, unknown> = {}) {
    super(message);
    this.name = 'HermesApiError';
    this.status = status;
    this.data = data;
  }
}

/** Default client timeout for bridge ops. Long CLI jobs pass a longer signal. */
export const HERMES_FETCH_TIMEOUT_MS = 15_000;

export async function hermesFetch<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}${BRIDGE_BASE}${path}`, {
    ...options,
    signal: options?.signal ?? abortAfter(HERMES_FETCH_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'X-Hermes-Profile': getActiveProfile(),
      ...options?.headers,
    },
  });

  let data: Record<string, unknown> = {};
  try {
    data = await response.json();
  } catch {
    // Non-JSON response body
  }

  if (!response.ok) {
    // Legacy routes send `{ error: string }`; enveloped ones send
    // `{ error: { code, message, retryable } }`. `data` keeps the full body, so
    // `toHermesError` (hermes-errors.ts) can still read the code.
    const envelopeMessage =
      data.error && typeof data.error === 'object'
        ? (data.error as { message?: unknown }).message
        : undefined;
    const error =
      typeof data.error === 'string' && data.error
        ? data.error
        : typeof envelopeMessage === 'string' && envelopeMessage
          ? envelopeMessage
          : `Server returned ${response.status}`;
    throw new HermesApiError(error, response.status, data);
  }

  return data as T;
}

const inflightHermesFetch = new Map<string, Promise<unknown>>();

export function coalesceHermesFetch<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inflightHermesFetch.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const request = factory().finally(() => {
    inflightHermesFetch.delete(key);
  });
  inflightHermesFetch.set(key, request);
  return request;
}

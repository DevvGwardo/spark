// ReconnectingSSE — a small wrapper around `EventSource` that transparently
// retries on network errors with jittered exponential backoff and reconnects
// using the `?since=<lastEventId>` query-param convention so the server can
// replay any buffered events that were missed while the connection was down.
//
// Contract (see docs/superpowers/specs/2026-04-23-hermes-webui-features-design.md §Feature 8):
// - Track the last successful `event.lastEventId`.
// - On `error`: reconnect with jittered backoff [250, 500, 1000, 2000] capped at 5000 ms (±25%).
// - After 3 consecutive failures → call `onReconnecting`.
// - After `maxRetries` (default 10) total failures → call `onGiveUp` and stop.
// - If a single retry succeeds within 1s, suppress `onReconnecting` (no flicker).

export interface ReconnectingSSEMessage {
  id: string;
  event?: string;
  data: string;
}

export interface ReconnectingSSEOptions {
  onMessage?: (event: ReconnectingSSEMessage) => void;
  onOpen?: () => void;
  onReconnecting?: (attempt: number) => void;
  onGiveUp?: (error: Error) => void;
  maxRetries?: number;
  // Seams for tests — default to globals in the browser.
  EventSourceImpl?: typeof EventSource;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  randomImpl?: () => number;
}

const BACKOFF_SCHEDULE_MS = [250, 500, 1000, 2000];
const BACKOFF_CAP_MS = 5000;
const RECONNECTING_THRESHOLD = 3;
const FLICKER_SUPPRESS_MS = 1000;
const DEFAULT_MAX_RETRIES = 10;

export class ReconnectingSSE {
  private readonly baseUrl: string;
  private readonly opts: ReconnectingSSEOptions;
  private readonly EventSourceImpl: typeof EventSource;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private readonly randomImpl: () => number;

  private source: EventSource | null = null;
  private lastEventId = '';
  private failureCount = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectingSurfaced = false;
  private lastOpenAt = 0;

  constructor(url: string, opts: ReconnectingSSEOptions = {}) {
    this.baseUrl = url;
    this.opts = opts;
    // Fall back to globals lazily so the class can be imported in non-browser
    // test environments without EventSource present at module load.
    this.EventSourceImpl = opts.EventSourceImpl
      ?? (globalThis as { EventSource?: typeof EventSource }).EventSource as typeof EventSource;
    this.setTimeoutImpl = opts.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? clearTimeout;
    this.randomImpl = opts.randomImpl ?? Math.random;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      this.clearTimeoutImpl(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }

  private buildUrl(): string {
    if (!this.lastEventId) {
      return this.baseUrl;
    }
    // Preserve any pre-existing query params on the base URL. Use a dummy
    // origin because `URL` requires an absolute base for relative inputs.
    const dummyOrigin = 'http://_placeholder_';
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(this.baseUrl)
      || this.baseUrl.startsWith('//');
    const parsed = new URL(this.baseUrl, absolute ? undefined : dummyOrigin);
    parsed.searchParams.set('since', this.lastEventId);
    const out = parsed.toString();
    return absolute ? out : out.replace(dummyOrigin, '');
  }

  private connect(): void {
    if (this.closed) return;
    if (!this.EventSourceImpl) {
      const err = new Error('EventSource is not available in this environment');
      this.opts.onGiveUp?.(err);
      return;
    }

    const url = this.buildUrl();
    const source = new this.EventSourceImpl(url);
    this.source = source;

    source.onopen = () => {
      this.lastOpenAt = Date.now();
      // Reset failure accounting on a successful open. If we surfaced a
      // "Reconnecting…" state, leave that for the caller to dismiss via its
      // own UX — we just stop escalating.
      this.failureCount = 0;
      this.reconnectingSurfaced = false;
      this.opts.onOpen?.();
    };

    source.onmessage = (event: MessageEvent) => {
      if (event.lastEventId) {
        this.lastEventId = event.lastEventId;
      }
      this.opts.onMessage?.({
        id: event.lastEventId,
        data: typeof event.data === 'string' ? event.data : '',
      });
    };

    source.onerror = () => {
      if (this.closed) return;
      const openedBriefly = this.lastOpenAt > 0
        && Date.now() - this.lastOpenAt < FLICKER_SUPPRESS_MS;

      source.close();
      this.source = null;
      this.failureCount += 1;

      const maxRetries = this.opts.maxRetries ?? DEFAULT_MAX_RETRIES;
      if (this.failureCount >= maxRetries) {
        this.opts.onGiveUp?.(new Error(`SSE reconnect gave up after ${this.failureCount} attempts`));
        this.closed = true;
        return;
      }

      if (
        !openedBriefly
        && !this.reconnectingSurfaced
        && this.failureCount >= RECONNECTING_THRESHOLD
      ) {
        this.reconnectingSurfaced = true;
        this.opts.onReconnecting?.(this.failureCount);
      }

      const delay = this.nextBackoffMs();
      this.reconnectTimer = this.setTimeoutImpl(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    };
  }

  private nextBackoffMs(): number {
    // failureCount is 1-based at this point (we just incremented it).
    const index = Math.min(this.failureCount - 1, BACKOFF_SCHEDULE_MS.length - 1);
    const base = index < 0 ? BACKOFF_SCHEDULE_MS[0] : BACKOFF_SCHEDULE_MS[index];
    const capped = Math.min(base, BACKOFF_CAP_MS);
    // ±25% jitter.
    const jitter = (this.randomImpl() * 0.5 - 0.25) * capped;
    return Math.max(0, Math.round(capped + jitter));
  }
}

export const __private = {
  BACKOFF_SCHEDULE_MS,
  BACKOFF_CAP_MS,
  RECONNECTING_THRESHOLD,
  FLICKER_SUPPRESS_MS,
  DEFAULT_MAX_RETRIES,
};

// Convenience wrapper that wires reconnect callbacks to the shared toast
// system. Used by the chat resume path and any other long-lived SSE consumer.
export async function createChatReconnectingSSE(
  url: string,
  opts: Omit<ReconnectingSSEOptions, 'onReconnecting' | 'onGiveUp'> = {},
): Promise<ReconnectingSSE> {
  // Dynamic import so this helper stays usable in non-browser test envs that
  // don't need the toast stack.
  const { toast } = await import('./toast');
  return new ReconnectingSSE(url, {
    ...opts,
    onReconnecting: (attempt: number) => {
      toast.warning(`Reconnecting… (attempt ${attempt})`, 4000);
    },
    onGiveUp: (error: Error) => {
      toast.error(`Lost connection to the server. ${error.message}`, 10_000);
    },
  });
}

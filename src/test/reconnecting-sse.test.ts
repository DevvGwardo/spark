import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconnectingSSE, __private } from '@/lib/reconnecting-sse';

// Minimal EventSource fake. Every instantiation is captured in `instances`.
// Tests drive the lifecycle via `fireOpen`, `fireMessage`, `fireError`.
type Handler<E> = ((event: E) => void) | null;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: Handler<Event> = null;
  onmessage: Handler<MessageEvent> = null;
  onerror: Handler<Event> = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  fireOpen(): void {
    this.onopen?.(new Event('open'));
  }

  fireMessage(id: string, data: string): void {
    const event = new MessageEvent('message', { data, lastEventId: id });
    this.onmessage?.(event);
  }

  fireError(): void {
    this.onerror?.(new Event('error'));
  }
}

describe('ReconnectingSSE', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeClient(overrides: Record<string, unknown> = {}) {
    const onMessage = vi.fn();
    const onOpen = vi.fn();
    const onReconnecting = vi.fn();
    const onGiveUp = vi.fn();
    const sse = new ReconnectingSSE('http://example.test/stream', {
      onMessage,
      onOpen,
      onReconnecting,
      onGiveUp,
      // Make backoff math deterministic: no jitter.
      randomImpl: () => 0.5,
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      ...overrides,
    });
    return { sse, onMessage, onOpen, onReconnecting, onGiveUp };
  }

  it('appends ?since=<lastEventId> on reconnect, preserving existing params', () => {
    const sse = new ReconnectingSSE('http://example.test/stream?foo=1', {
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      randomImpl: () => 0.5,
    });
    const first = FakeEventSource.instances[0];
    first.fireOpen();
    first.fireMessage('42', 'hello');
    first.fireError();

    // Advance through the first backoff (250ms base, no jitter with 0.5).
    vi.advanceTimersByTime(500);

    expect(FakeEventSource.instances).toHaveLength(2);
    const second = FakeEventSource.instances[1];
    expect(second.url).toContain('foo=1');
    expect(second.url).toContain('since=42');
    sse.close();
  });

  it('uses the [250, 500, 1000, 2000] backoff schedule capped at 5000', () => {
    const { sse, onReconnecting } = makeClient({ maxRetries: 20 });
    expect(FakeEventSource.instances).toHaveLength(1);

    const expectedDelays = [250, 500, 1000, 2000, 2000, 2000];
    for (let i = 0; i < expectedDelays.length; i += 1) {
      const current = FakeEventSource.instances[FakeEventSource.instances.length - 1];
      current.fireError();
      // randomImpl=0.5 => jitter factor = 0 => delay == base capped at 5000.
      vi.advanceTimersByTime(expectedDelays[i] - 1);
      expect(FakeEventSource.instances.length).toBe(i + 1);
      vi.advanceTimersByTime(1);
      expect(FakeEventSource.instances.length).toBe(i + 2);
    }

    // Only jumps are 250/500/1000/2000/2000/2000 — all ≤ 5000.
    expect(__private.BACKOFF_CAP_MS).toBe(5000);
    expect(onReconnecting).toHaveBeenCalled();
    sse.close();
  });

  it('does not call onReconnecting when a single retry succeeds within 1s', () => {
    const { sse, onReconnecting, onOpen } = makeClient();

    const first = FakeEventSource.instances[0];
    first.fireOpen();
    first.fireError();

    // Backoff [0]=250ms → next connect.
    vi.advanceTimersByTime(260);
    expect(FakeEventSource.instances).toHaveLength(2);
    const second = FakeEventSource.instances[1];
    second.fireOpen(); // immediate recovery

    expect(onReconnecting).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(2);
    sse.close();
  });

  it('surfaces onReconnecting after 3 consecutive failures', () => {
    const { sse, onReconnecting } = makeClient();

    // Fail 3 times in a row without any successful open in between.
    FakeEventSource.instances[0].fireError();
    vi.advanceTimersByTime(260);
    FakeEventSource.instances[1].fireError();
    vi.advanceTimersByTime(510);
    FakeEventSource.instances[2].fireError();

    expect(onReconnecting).toHaveBeenCalledTimes(1);
    expect(onReconnecting).toHaveBeenCalledWith(3);
    sse.close();
  });

  it('calls onGiveUp after maxRetries failures', () => {
    const { onGiveUp } = makeClient({ maxRetries: 10 });

    // 10 failures total.
    for (let i = 0; i < 10; i += 1) {
      const current = FakeEventSource.instances[FakeEventSource.instances.length - 1];
      current.fireError();
      vi.advanceTimersByTime(10_000);
    }

    expect(onGiveUp).toHaveBeenCalledTimes(1);
    const err = onGiveUp.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
  });

  it('tracks lastEventId across reconnects', () => {
    const { sse } = makeClient();

    const first = FakeEventSource.instances[0];
    first.fireOpen();
    first.fireMessage('7', 'x');
    first.fireMessage('11', 'y');
    first.fireError();
    vi.advanceTimersByTime(260);

    const second = FakeEventSource.instances[1];
    expect(second.url).toContain('since=11');
    sse.close();
  });

  it('close() stops reconnection attempts', () => {
    const { sse } = makeClient();
    FakeEventSource.instances[0].fireError();
    sse.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

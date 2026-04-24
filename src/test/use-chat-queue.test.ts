import { describe, expect, it, vi } from 'vitest';
import {
  createQueuedMessage,
  removeQueuedMessage,
  type QueuedMessage,
} from '@/lib/chat-queue';

/**
 * These tests exercise the turn-queue state machine that lives in
 * `src/hooks/useChat.ts` (see handleSend / queueMessage / the drain effect
 * around lines 2581-2646). Rather than mount the 2700-line hook, we replay
 * the same reducer logic against `queuedMessages`, `isStreaming`, and a
 * mocked `sendMessage` — matching the spec verification in
 * docs/superpowers/specs/2026-04-23-hermes-webui-features-design.md §Feature 5.
 */

interface QueueHarness {
  isStreaming: boolean;
  queue: QueuedMessage[];
  sent: string[];
  sendMessage: (content: string) => Promise<boolean>;
  handleSend: (draft: string) => void;
  finishStream: () => void;
}

function createHarness(): QueueHarness {
  const harness: QueueHarness = {
    isStreaming: false,
    queue: [],
    sent: [],
    sendMessage: vi.fn(async (content: string) => {
      harness.sent.push(content);
      harness.isStreaming = true;
      return true;
    }),
    handleSend(draft: string) {
      const content = draft.trim();
      if (!content) return;
      if (this.isStreaming) {
        this.queue = [...this.queue, createQueuedMessage(content)];
        return;
      }
      void this.sendMessage(content);
    },
    finishStream() {
      this.isStreaming = false;
      // Drain effect: if the queue is non-empty and we're not busy, send the next one.
      if (this.queue.length > 0) {
        const next = this.queue[0];
        this.queue = removeQueuedMessage(this.queue, next.id);
        void this.sendMessage(next.content);
      }
    },
  };
  return harness;
}

describe('useChat turn queue', () => {
  it('queues messages submitted while isStreaming=true', () => {
    const h = createHarness();

    // First message starts a stream.
    h.handleSend('first');
    expect(h.isStreaming).toBe(true);
    expect(h.sent).toEqual(['first']);
    expect(h.queue).toHaveLength(0);

    // Three more submissions during streaming get queued, not sent.
    h.handleSend('second');
    h.handleSend('third');
    h.handleSend('fourth');

    expect(h.queue).toHaveLength(3);
    expect(h.queue.map((m) => m.content)).toEqual(['second', 'third', 'fourth']);
    expect(h.sent).toEqual(['first']);
  });

  it('drains the queue in FIFO order as each stream ends', () => {
    const h = createHarness();

    h.handleSend('first');
    h.handleSend('second');
    h.handleSend('third');
    h.handleSend('fourth');

    expect(h.queue).toHaveLength(3);

    // First stream ends → second drains and begins streaming.
    h.finishStream();
    expect(h.sent).toEqual(['first', 'second']);
    expect(h.queue).toHaveLength(2);
    expect(h.isStreaming).toBe(true);

    // Second stream ends → third drains.
    h.finishStream();
    expect(h.sent).toEqual(['first', 'second', 'third']);
    expect(h.queue).toHaveLength(1);

    // Third stream ends → fourth drains.
    h.finishStream();
    expect(h.sent).toEqual(['first', 'second', 'third', 'fourth']);
    expect(h.queue).toHaveLength(0);

    // Final stream ends → queue is empty, no more sends.
    h.finishStream();
    expect(h.sent).toHaveLength(4);
    expect(h.isStreaming).toBe(false);
  });

  it('ignores empty or whitespace submissions', () => {
    const h = createHarness();

    h.handleSend('   ');
    expect(h.sent).toHaveLength(0);
    expect(h.queue).toHaveLength(0);

    h.handleSend('real');
    h.handleSend('');
    h.handleSend('  \n  ');
    expect(h.sent).toEqual(['real']);
    expect(h.queue).toHaveLength(0);
  });

  it('allows removing an item from the middle of the queue before drain', () => {
    const h = createHarness();

    h.handleSend('first');
    h.handleSend('second');
    h.handleSend('third');
    h.handleSend('fourth');

    // User removes the second queued item (which is overall the 3rd message).
    const middleId = h.queue[1].id;
    h.queue = removeQueuedMessage(h.queue, middleId);
    expect(h.queue.map((m) => m.content)).toEqual(['second', 'fourth']);

    h.finishStream();
    h.finishStream();
    h.finishStream();
    expect(h.sent).toEqual(['first', 'second', 'fourth']);
    expect(h.queue).toHaveLength(0);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createQueuedMessage,
  moveQueuedMessageToFront,
  removeQueuedMessage,
  type QueuedMessage,
} from '@/lib/chat-queue';

function buildQueue(): QueuedMessage[] {
  return [
    { id: 'queued-1', content: 'First', createdAt: '2026-03-10T12:00:00.000Z' },
    { id: 'queued-2', content: 'Second', createdAt: '2026-03-10T12:01:00.000Z' },
    { id: 'queued-3', content: 'Third', createdAt: '2026-03-10T12:02:00.000Z' },
  ];
}

describe('chat queue helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('createQueuedMessage', () => {
    it('creates a queued message with a generated id and current timestamp', () => {
      const now = new Date('2026-03-10T15:30:45.000Z');

      vi.useFakeTimers();
      vi.setSystemTime(now);
      vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('queued-1' as `${string}-${string}-${string}-${string}-${string}`);

      expect(createQueuedMessage('Draft reply')).toEqual({
        id: 'queued-1',
        content: 'Draft reply',
        createdAt: now.toISOString(),
      });
    });
  });

  describe('moveQueuedMessageToFront', () => {
    it('moves the matching queued message to the front without mutating the queue', () => {
      const queue = buildQueue();

      const reorderedQueue = moveQueuedMessageToFront(queue, 'queued-2');

      expect(reorderedQueue).not.toBe(queue);
      expect(reorderedQueue.map((message) => message.id)).toEqual([
        'queued-2',
        'queued-1',
        'queued-3',
      ]);
      expect(reorderedQueue[0]).toBe(queue[1]);
      expect(queue.map((message) => message.id)).toEqual([
        'queued-1',
        'queued-2',
        'queued-3',
      ]);
    });

    it('returns the original queue when the message is not found', () => {
      const queue = buildQueue();

      const reorderedQueue = moveQueuedMessageToFront(queue, 'missing-message');

      expect(reorderedQueue).toBe(queue);
    });
  });

  describe('removeQueuedMessage', () => {
    it('removes the matching queued message and preserves the remaining order', () => {
      const queue = buildQueue();

      const filteredQueue = removeQueuedMessage(queue, 'queued-2');

      expect(filteredQueue).not.toBe(queue);
      expect(filteredQueue.map((message) => message.id)).toEqual([
        'queued-1',
        'queued-3',
      ]);
      expect(queue.map((message) => message.id)).toEqual([
        'queued-1',
        'queued-2',
        'queued-3',
      ]);
    });
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { useChatQueueStore } from '@/stores/chat-queue-store';

describe('chat queue store', () => {
  beforeEach(() => {
    useChatQueueStore.setState({ panelQueues: {} });
  });

  it('stores queue snapshots per panel with runtime metadata', () => {
    useChatQueueStore.getState().setPanelQueue({
      panelId: 'panel-1',
      conversationId: 'conv-1',
      profile: 'session-1',
      isStreaming: true,
      waitingForOtherPanel: false,
      messages: [
        { id: 'queued-1', content: 'follow up', createdAt: '2026-05-14T12:00:00.000Z' },
      ],
    });

    const snapshot = useChatQueueStore.getState().panelQueues['panel-1'];
    expect(snapshot).toMatchObject({
      panelId: 'panel-1',
      conversationId: 'conv-1',
      profile: 'session-1',
      isStreaming: true,
      waitingForOtherPanel: false,
    });
    expect(snapshot?.messages).toHaveLength(1);
    expect(typeof snapshot?.updatedAt).toBe('string');
  });

  it('clears a panel queue without touching others', () => {
    useChatQueueStore.getState().setPanelQueue({
      panelId: 'panel-1',
      conversationId: 'conv-1',
      profile: 'session-1',
      isStreaming: false,
      waitingForOtherPanel: false,
      messages: [],
    });
    useChatQueueStore.getState().setPanelQueue({
      panelId: 'panel-2',
      conversationId: 'conv-2',
      profile: 'session-2',
      isStreaming: false,
      waitingForOtherPanel: true,
      messages: [
        { id: 'queued-2', content: 'later', createdAt: '2026-05-14T12:01:00.000Z' },
      ],
    });

    useChatQueueStore.getState().clearPanelQueue('panel-1');

    expect(useChatQueueStore.getState().panelQueues['panel-1']).toBeUndefined();
    expect(useChatQueueStore.getState().panelQueues['panel-2']?.messages[0]?.content).toBe('later');
  });
});

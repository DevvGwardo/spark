import { create } from 'zustand';
import type { QueuedMessage } from '@/lib/chat-queue';

export interface PanelQueueSnapshot {
  panelId: string;
  conversationId: string | null;
  profile: string;
  isStreaming: boolean;
  waitingForOtherPanel: boolean;
  messages: QueuedMessage[];
  updatedAt: string;
}

interface ChatQueueState {
  panelQueues: Record<string, PanelQueueSnapshot>;
  setPanelQueue: (snapshot: Omit<PanelQueueSnapshot, 'updatedAt'>) => void;
  clearPanelQueue: (panelId: string) => void;
}

export const useChatQueueStore = create<ChatQueueState>()((set) => ({
  panelQueues: {},

  setPanelQueue: (snapshot) =>
    set((state) => ({
      panelQueues: {
        ...state.panelQueues,
        [snapshot.panelId]: {
          ...snapshot,
          updatedAt: new Date().toISOString(),
        },
      },
    })),

  clearPanelQueue: (panelId) =>
    set((state) => {
      if (!state.panelQueues[panelId]) {
        return state;
      }
      const { [panelId]: _removed, ...rest } = state.panelQueues;
      return { panelQueues: rest };
    }),
}));

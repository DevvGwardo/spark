import { create } from 'zustand';

interface ConversationActivity {
  streaming: boolean;
  linesAdded: number;
  linesRemoved: number;
}

interface ActivityState {
  activities: Record<string, ConversationActivity>;

  setStreaming: (conversationId: string, streaming: boolean) => void;
  addLineStats: (conversationId: string, added: number, removed: number) => void;
  getActivity: (conversationId: string) => ConversationActivity | undefined;
  clearActivity: (conversationId: string) => void;
}

export const useActivityStore = create<ActivityState>()((set, get) => ({
  activities: {},

  setStreaming: (conversationId, streaming) =>
    set((state) => ({
      activities: {
        ...state.activities,
        [conversationId]: {
          ...(state.activities[conversationId] || { linesAdded: 0, linesRemoved: 0 }),
          streaming,
        },
      },
    })),

  addLineStats: (conversationId, added, removed) =>
    set((state) => {
      const existing = state.activities[conversationId] || { streaming: false, linesAdded: 0, linesRemoved: 0 };
      return {
        activities: {
          ...state.activities,
          [conversationId]: {
            ...existing,
            linesAdded: existing.linesAdded + added,
            linesRemoved: existing.linesRemoved + removed,
          },
        },
      };
    }),

  getActivity: (conversationId) => get().activities[conversationId],

  clearActivity: (conversationId) =>
    set((state) => {
      const { [conversationId]: _, ...rest } = state.activities;
      return { activities: rest };
    }),
}));

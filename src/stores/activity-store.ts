import { create } from 'zustand';
import { db } from '@/lib/db';

interface ConversationActivity {
  streaming: boolean;
  linesAdded: number;
  linesRemoved: number;
}

export interface VerificationProgress {
  active: boolean;
  progress: number;
  stepLabel: string;
  stepDetail: string;
}

interface ActivityState {
  activities: Record<string, ConversationActivity>;
  verification: VerificationProgress;

  setStreaming: (conversationId: string, streaming: boolean) => void;
  addLineStats: (conversationId: string, added: number, removed: number) => void;
  getPendingLineStats: (conversationId: string) => { added: number; removed: number };
  getActivity: (conversationId: string) => ConversationActivity | undefined;
  clearActivity: (conversationId: string) => void;
  setVerification: (v: VerificationProgress) => void;
}

// Debounced persistence — flush session deltas to the DB
const FLUSH_DEBOUNCE_MS = 1500;
const flushTimers: Record<string, ReturnType<typeof setTimeout>> = {};
// Track what has already been flushed so we only persist the delta
const flushedStats: Record<string, { added: number; removed: number }> = {};

function scheduleFlush(conversationId: string) {
  if (flushTimers[conversationId]) {
    clearTimeout(flushTimers[conversationId]);
  }
  flushTimers[conversationId] = setTimeout(() => {
    delete flushTimers[conversationId];
    void flushLineStats(conversationId);
  }, FLUSH_DEBOUNCE_MS);
}

async function flushLineStats(conversationId: string) {
  const activity = useActivityStore.getState().activities[conversationId];
  if (!activity) return;

  const prevFlushed = flushedStats[conversationId] ?? { added: 0, removed: 0 };
  const deltaAdded = activity.linesAdded - prevFlushed.added;
  const deltaRemoved = activity.linesRemoved - prevFlushed.removed;

  if (deltaAdded === 0 && deltaRemoved === 0) return;

  try {
    // Read current persisted value and add the unflushed delta
    const conversations = await db.conversations.getAll();
    const conv = conversations.find((c) => c.id === conversationId);
    if (!conv) return;

    const newAdded = (conv.linesAdded ?? 0) + deltaAdded;
    const newRemoved = (conv.linesRemoved ?? 0) + deltaRemoved;

    await db.conversations.update(conversationId, {
      linesAdded: newAdded,
      linesRemoved: newRemoved,
    });

    // Mark what we've flushed
    flushedStats[conversationId] = {
      added: activity.linesAdded,
      removed: activity.linesRemoved,
    };

    // Refresh the conversations list so sidebar picks up persisted values
    const { useChatStore } = await import('@/stores/chat-store');
    await useChatStore.getState().loadConversations();
  } catch (err) {
    console.warn('[activity-store] Failed to flush line stats to DB — will retry on next delta', err);
  }
}

const EMPTY_VERIFICATION: VerificationProgress = { active: false, progress: 0, stepLabel: '', stepDetail: '' };

export const useActivityStore = create<ActivityState>()((set, get) => ({
  activities: {},
  verification: EMPTY_VERIFICATION,

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
      const updated = {
        ...existing,
        linesAdded: existing.linesAdded + added,
        linesRemoved: existing.linesRemoved + removed,
      };

      // Schedule debounced persistence to DB
      scheduleFlush(conversationId);

      return {
        activities: {
          ...state.activities,
          [conversationId]: updated,
        },
      };
    }),

  getPendingLineStats: (conversationId) => {
    const activity = get().activities[conversationId];
    if (!activity) {
      return { added: 0, removed: 0 };
    }

    const prevFlushed = flushedStats[conversationId] ?? { added: 0, removed: 0 };
    return {
      added: Math.max(0, activity.linesAdded - prevFlushed.added),
      removed: Math.max(0, activity.linesRemoved - prevFlushed.removed),
    };
  },

  getActivity: (conversationId) => get().activities[conversationId],

  clearActivity: (conversationId) =>
    set((state) => {
      const { [conversationId]: _, ...rest } = state.activities;
      // Clear flush tracking too
      delete flushedStats[conversationId];
      if (flushTimers[conversationId]) {
        clearTimeout(flushTimers[conversationId]);
        delete flushTimers[conversationId];
      }
      return { activities: rest };
    }),

  setVerification: (v) => set({ verification: v }),
}));

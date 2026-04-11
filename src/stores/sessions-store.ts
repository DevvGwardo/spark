import { create } from 'zustand';
import {
  fetchSessions as apiFetchSessions,
  deleteSession as apiDeleteSession,
  type HermesSession,
} from '@/lib/hermes-api';

export type { HermesSession };

interface SessionsState {
  sessions: HermesSession[];
  loading: boolean;
  error: string | null;
  fetchSessions: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
}

export const useSessionsStore = create<SessionsState>()((set) => ({
  sessions: [],
  loading: false,
  error: null,

  fetchSessions: async () => {
    set({ loading: true, error: null });
    try {
      const sessions = await apiFetchSessions();
      set({ sessions, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to fetch sessions', loading: false });
    }
  },

  deleteSession: async (id) => {
    set({ error: null });
    try {
      await apiDeleteSession(id);
      set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== id) }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete session' });
    }
  },
}));

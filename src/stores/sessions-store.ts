import { create } from 'zustand';
import {
  fetchSessions as apiFetchSessions,
  deleteSession as apiDeleteSession,
  getSession,
  type HermesSession,
  type HermesSessionDetail,
} from '@/lib/hermes-api';

export type { HermesSession };

interface SessionsState {
  sessions: HermesSession[];
  activeDetails: Record<string, HermesSessionDetail>;
  loading: boolean;
  error: string | null;
  fetchSessions: () => Promise<void>;
  fetchActiveDetails: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
}

export const useSessionsStore = create<SessionsState>()((set) => ({
  sessions: [],
  activeDetails: {},
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

  fetchActiveDetails: async () => {
    set({ error: null });
    try {
      const activeSessions = useSessionsStore.getState().sessions.filter((session) => session.status === 'active');
      if (activeSessions.length === 0) {
        set({ activeDetails: {} });
        return;
      }

      const details = await Promise.all(activeSessions.map((session) => getSession(session.id)));
      const activeDetails = Object.fromEntries(details.map((detail) => [detail.id, detail]));
      set({ activeDetails });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch active sessions';
      set({ error: message });
      throw err instanceof Error ? err : new Error(message);
    }
  },

  deleteSession: async (id) => {
    set({ error: null });
    try {
      await apiDeleteSession(id);
      set((s) => {
        const activeDetails = { ...s.activeDetails };
        delete activeDetails[id];
        return {
          sessions: s.sessions.filter((sess) => sess.id !== id),
          activeDetails,
        };
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete session' });
    }
  },
}));

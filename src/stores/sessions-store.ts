import { create } from 'zustand';
import {
  fetchSessions as apiFetchSessions,
  deleteSession as apiDeleteSession,
  getSession,
  type HermesSession,
  type HermesSessionDetail,
  type SessionStatusCounts,
} from '@/lib/hermes-api';

export type { HermesSession };

export const SESSIONS_PAGE_SIZE = 50;

const EMPTY_COUNTS: SessionStatusCounts = { active: 0, completed: 0, error: 0, total: 0 };

interface SessionsState {
  /** The currently-loaded page window (newest first). */
  sessions: HermesSession[];
  /** Total sessions matching the active query (server-side). */
  total: number;
  /** Aggregate status counts over the full matching set (server-side). */
  counts: SessionStatusCounts;
  /** Active search query (server-side filter). */
  query: string;
  /** Whether more pages remain to load for the current query. */
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  activeDetails: Record<string, HermesSessionDetail>;
  /** Fresh first-page load. Pass `{ query }` to (re)search. */
  loadSessions: (opts?: { query?: string }) => Promise<void>;
  /** Append the next page for the current query. */
  loadMoreSessions: () => Promise<void>;
  /** Silent reload of the loaded window (used by polling); preserves scroll. */
  refreshSessions: () => Promise<void>;
  fetchActiveDetails: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
}

export const useSessionsStore = create<SessionsState>()((set, get) => ({
  sessions: [],
  total: 0,
  counts: EMPTY_COUNTS,
  query: '',
  hasMore: false,
  loading: false,
  loadingMore: false,
  error: null,
  activeDetails: {},

  loadSessions: async (opts) => {
    const query = opts?.query ?? get().query;
    set({ loading: true, error: null, query });
    try {
      const page = await apiFetchSessions({ limit: SESSIONS_PAGE_SIZE, offset: 0, q: query });
      // Ignore a stale response if the query changed while this was in flight.
      if (get().query !== query) return;
      set({
        sessions: page.sessions,
        total: page.total,
        counts: page.counts,
        hasMore: page.sessions.length < page.total,
        loading: false,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to fetch sessions', loading: false });
    }
  },

  loadMoreSessions: async () => {
    const { sessions, query, hasMore, loadingMore, loading } = get();
    if (!hasMore || loadingMore || loading) return;
    set({ loadingMore: true });
    try {
      const page = await apiFetchSessions({ limit: SESSIONS_PAGE_SIZE, offset: sessions.length, q: query });
      if (get().query !== query) return;
      const existing = get().sessions;
      const seen = new Set(existing.map((s) => s.id));
      const merged = [...existing, ...page.sessions.filter((s) => !seen.has(s.id))];
      set({
        sessions: merged,
        total: page.total,
        counts: page.counts,
        hasMore: merged.length < page.total,
        loadingMore: false,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load more sessions', loadingMore: false });
    }
  },

  refreshSessions: async () => {
    const { sessions, query } = get();
    const limit = Math.max(SESSIONS_PAGE_SIZE, sessions.length);
    try {
      const page = await apiFetchSessions({ limit, offset: 0, q: query });
      if (get().query !== query) return;
      set({
        sessions: page.sessions,
        total: page.total,
        counts: page.counts,
        hasMore: page.sessions.length < page.total,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to refresh sessions' });
    }
  },

  fetchActiveDetails: async () => {
    set({ error: null });
    try {
      const activeSessions = get().sessions.filter((session) => session.status === 'active');
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
          total: Math.max(0, s.total - 1),
        };
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete session' });
    }
  },
}));

import { create } from 'zustand';
import { getApiBaseUrl } from '@/lib/api';

export interface ActiveTask {
  cardId: string;
  conversationId: string;
  startedAt: number;
}

export interface OrchestratorStatus {
  enabled: boolean;
  activeTasks: ActiveTask[];
  maxConcurrent: number;
  stats: { completed: number; failed: number; startedAt: number | null };
}

interface TaskOrchestratorState {
  enabled: boolean;
  activeTasks: ActiveTask[];
  stats: { completed: number; failed: number; startedAt: number | null };
  loading: boolean;
  error: string | null;
  fetchStatus: () => Promise<void>;
  startOrchestrator: () => Promise<void>;
  stopOrchestrator: () => Promise<void>;
  dispatchNow: () => Promise<void>;
  cancelTask: (cardId: string) => Promise<void>;
}

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const useTaskOrchestratorStore = create<TaskOrchestratorState>()((set, get) => ({
  enabled: false,
  activeTasks: [],
  stats: { completed: 0, failed: 0, startedAt: null },
  loading: false,
  error: null,

  fetchStatus: async () => {
    set({ loading: true, error: null });
    try {
      const data = await apiFetch('/api/hermes/orchestrator/status') as OrchestratorStatus;
      set({
        enabled: data.enabled,
        activeTasks: data.activeTasks,
        stats: data.stats,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch orchestrator status';
      set({ error: msg });
    } finally {
      set({ loading: false });
    }
  },

  startOrchestrator: async () => {
    set({ error: null });
    try {
      await apiFetch('/api/hermes/orchestrator/start', { method: 'POST' });
      set({ enabled: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to start orchestrator';
      set({ error: msg });
    }
  },

  stopOrchestrator: async () => {
    set({ error: null });
    try {
      await apiFetch('/api/hermes/orchestrator/stop', { method: 'POST' });
      set({ enabled: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to stop orchestrator';
      set({ error: msg });
    }
  },

  dispatchNow: async () => {
    set({ error: null });
    try {
      await apiFetch('/api/hermes/orchestrator/dispatch-now', { method: 'POST' });
      await get().fetchStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to dispatch';
      set({ error: msg });
    }
  },

  cancelTask: async (cardId) => {
    set({ error: null });
    try {
      await apiFetch(`/api/hermes/orchestrator/cancel/${cardId}`, { method: 'POST' });
      await get().fetchStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to cancel task';
      set({ error: msg });
    }
  },
}));

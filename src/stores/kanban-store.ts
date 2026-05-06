import { create } from 'zustand';
import { getApiBaseUrl } from '@/lib/api';

export type KanbanLane = 'backlog' | 'ready' | 'running' | 'review' | 'blocked' | 'done';

export interface KanbanCard {
  id: string;
  title: string;
  spec: string;
  acceptanceCriteria: string[];
  assignedWorker: string;
  reviewer: string;
  status: KanbanLane;
  missionId: string;
  reportPath: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

interface KanbanState {
  cards: KanbanCard[];
  loading: boolean;
  error: string | null;
  fetchCards: () => Promise<void>;
  createCard: (card: Omit<KanbanCard, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateCard: (id: string, updates: Partial<KanbanCard>) => Promise<void>;
  deleteCard: (id: string) => Promise<void>;
  moveCard: (id: string, status: KanbanLane) => Promise<void>;
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

export const useKanbanStore = create<KanbanState>()((set, get) => ({
  cards: [],
  loading: false,
  error: null,

  fetchCards: async () => {
    set({ loading: true, error: null });
    try {
      const data = await apiFetch('/api/hermes/kanban');
      set({ cards: data.cards ?? [] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch cards';
      set({ error: msg });
      console.error('Failed to fetch kanban cards:', e);
    } finally {
      set({ loading: false });
    }
  },

  createCard: async (card) => {
    set({ error: null });
    try {
      await apiFetch('/api/hermes/kanban', {
        method: 'POST',
        body: JSON.stringify(card),
      });
      await get().fetchCards();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to create card';
      set({ error: msg });
      throw e;
    }
  },

  updateCard: async (id, updates) => {
    set({ error: null });
    try {
      await apiFetch(`/api/hermes/kanban/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
      await get().fetchCards();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to update card';
      set({ error: msg });
      throw e;
    }
  },

  deleteCard: async (id) => {
    set({ error: null });
    try {
      await apiFetch(`/api/hermes/kanban/${id}`, {
        method: 'DELETE',
      });
      await get().fetchCards();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to delete card';
      set({ error: msg });
      throw e;
    }
  },

  moveCard: async (id, status) => {
    set({ error: null });
    try {
      await apiFetch(`/api/hermes/kanban/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      // Optimistic update
      set((state) => ({
        cards: state.cards.map((c) =>
          c.id === id ? { ...c, status, updatedAt: Date.now() } : c
        ),
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to move card';
      set({ error: msg });
      // Revert by re-fetching
      await get().fetchCards();
      throw e;
    }
  },
}));

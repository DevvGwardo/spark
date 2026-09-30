import { create } from 'zustand';
import { getApiBaseUrl } from '@/lib/api';

// ─── Ralph loop store ──────────────────────────────────────────────────────
// Client state for the Ralph fresh-agent loop panel. Polls the driver's
// REST surface; the loop itself lives server-side (server/ralph-loop.ts).

export interface RalphRoundView {
  round: number;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  summary: string;
  error?: string;
}

export interface RalphRunView {
  id: string;
  objective: string;
  workspaceDir: string;
  maxRounds: number;
  status: string;
  statusLabel: string;
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  finalReport: {
    status: string;
    summary: string;
    evidence: string[];
    nextSteps: string[];
    blocker: string;
  } | null;
  lastHandoff: RalphRunView['finalReport'];
  rounds: RalphRoundView[];
  error?: string;
}

interface RalphState {
  runs: RalphRunView[];
  loading: boolean;
  error: string | null;
  fetchRuns: () => Promise<void>;
  startRun: (objective: string, maxRounds?: number, workspaceDir?: string) => Promise<RalphRunView>;
  cancelRun: (id: string) => Promise<void>;
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

export const useRalphStore = create<RalphState>((set) => ({
  runs: [],
  loading: false,
  error: null,

  fetchRuns: async () => {
    set({ loading: true, error: null });
    try {
      const data = await apiFetch('/api/hermes/ralph');
      set({ runs: data.runs ?? [], loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  startRun: async (objective, maxRounds, workspaceDir) => {
    const data = await apiFetch('/api/hermes/ralph', {
      method: 'POST',
      body: JSON.stringify({ objective, maxRounds, workspaceDir }),
    });
    set((s) => ({ runs: [data.run, ...s.runs] }));
    return data.run as RalphRunView;
  },

  cancelRun: async (id) => {
    await apiFetch(`/api/hermes/ralph/${id}/cancel`, { method: 'POST' });
    set((s) => ({
      runs: s.runs.map((r) =>
        r.id === id && r.finishedAt === null ? { ...r, statusLabel: 'cancelled' } : r,
      ),
    }));
  },
}));

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Provider } from '@/stores/settings-store';

export type OrchestrationPhase =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'synthesizing'
  | 'done'
  | 'error';

export interface SubTask {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'done';
  result?: string;
}

export interface ActiveOrchestration {
  phase: OrchestrationPhase;
  plan?: string;
  tasks: SubTask[];
  error?: string;
}

interface OrchestratorState {
  enabled: boolean;
  planningProvider: Provider;
  planningModel: string;
  codingProvider: Provider;
  codingModel: string;
  maxSubAgents: number;

  // Live orchestration state (not persisted)
  activeOrchestration: ActiveOrchestration;

  setEnabled(v: boolean): void;
  setPlanningProvider(p: Provider): void;
  setPlanningModel(m: string): void;
  setCodingProvider(p: Provider): void;
  setCodingModel(m: string): void;
  setMaxSubAgents(n: number): void;

  updateOrchestration(patch: Partial<ActiveOrchestration>): void;
  updateTask(taskId: string, patch: Partial<SubTask>): void;
  resetOrchestration(): void;
}

const IDLE_ORCHESTRATION: ActiveOrchestration = {
  phase: 'idle',
  tasks: [],
};

export const useOrchestratorStore = create<OrchestratorState>()(
  persist(
    (set) => ({
      enabled: false,
      planningProvider: 'kimi-coding',
      planningModel: 'kimi-for-coding',
      codingProvider: 'kimi-coding',
      codingModel: 'kimi-for-coding',
      maxSubAgents: 3,

      activeOrchestration: { ...IDLE_ORCHESTRATION },

      setEnabled: (v) => set({ enabled: v }),
      setPlanningProvider: (p) => set({ planningProvider: p }),
      setPlanningModel: (m) => set({ planningModel: m }),
      setCodingProvider: (p) => set({ codingProvider: p }),
      setCodingModel: (m) => set({ codingModel: m }),
      setMaxSubAgents: (n) => set({ maxSubAgents: Math.max(1, Math.min(6, n)) }),

      updateOrchestration: (patch) =>
        set((s) => ({
          activeOrchestration: { ...s.activeOrchestration, ...patch },
        })),

      updateTask: (taskId, patch) =>
        set((s) => ({
          activeOrchestration: {
            ...s.activeOrchestration,
            tasks: s.activeOrchestration.tasks.map((t) =>
              t.id === taskId ? { ...t, ...patch } : t
            ),
          },
        })),

      resetOrchestration: () =>
        set({ activeOrchestration: { ...IDLE_ORCHESTRATION } }),
    }),
    {
      name: 'cloudchat-orchestrator',
      version: 4,
      migrate: (persisted: any, version: number) => {
        const state = persisted as any;
        if (version < 4) {
          // Migrate from any older shape to dual-provider
          state.planningProvider = state.provider || state.planningProvider || 'kimi-coding';
          state.planningModel = state.model || state.planningModel || 'kimi-for-coding';
          state.codingProvider = state.provider || state.codingProvider || 'kimi-coding';
          state.codingModel = state.model || state.codingModel || 'kimi-for-coding';
          state.maxSubAgents = state.maxSubAgents || 3;
          // Clean up old single-provider fields
          delete state.provider;
          delete state.model;
        }
        return state;
      },
      // Don't persist live orchestration state
      partialize: (state) => ({
        enabled: state.enabled,
        planningProvider: state.planningProvider,
        planningModel: state.planningModel,
        codingProvider: state.codingProvider,
        codingModel: state.codingModel,
        maxSubAgents: state.maxSubAgents,
      }),
    }
  )
);

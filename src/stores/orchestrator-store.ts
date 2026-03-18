import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  status: 'pending' | 'running' | 'done' | 'failed' | 'retrying' | 'cancelled';
  result?: string;
  error?: string;
  retryCount: number;
  maxRetries: number;
  model?: string;
  toolProfile?: 'research' | 'coding' | 'general';
  startedAt?: number;
  completedAt?: number;
  elapsedMs?: number;
}

export interface ActiveOrchestration {
  phase: OrchestrationPhase;
  plan?: string;
  tasks: SubTask[];
  error?: string;
}

interface OrchestratorState {
  enabled: boolean;
  maxSubAgents: number;
  maxRetries: number;
  fallbackModel: string;

  // Live orchestration state (not persisted)
  activeOrchestration: ActiveOrchestration;

  setEnabled(v: boolean): void;
  setMaxSubAgents(n: number): void;
  setMaxRetries(n: number): void;
  setFallbackModel(model: string): void;

  updateOrchestration(patch: Partial<ActiveOrchestration>): void;
  updateTask(taskId: string, patch: Partial<SubTask>): void;
  cancelTask(taskId: string): void;
  resetOrchestration(): void;
}

const IDLE_ORCHESTRATION: ActiveOrchestration = {
  phase: 'idle',
  tasks: [],
};

const DEFAULT_MAX_SUB_AGENTS = 6;
const DEFAULT_MAX_RETRIES = 2;

export const useOrchestratorStore = create<OrchestratorState>()(
  persist(
    (set) => ({
      enabled: true,
      maxSubAgents: DEFAULT_MAX_SUB_AGENTS,
      maxRetries: DEFAULT_MAX_RETRIES,
      fallbackModel: '',

      activeOrchestration: { ...IDLE_ORCHESTRATION },

      setEnabled: (v) => set({ enabled: v }),
      setMaxSubAgents: (n) => set({ maxSubAgents: Math.max(1, Math.min(6, n)) }),
      setMaxRetries: (n) => set({ maxRetries: Math.max(0, Math.min(10, n)) }),
      setFallbackModel: (model) => set({ fallbackModel: model }),

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

      cancelTask: (taskId) =>
        set((s) => ({
          activeOrchestration: {
            ...s.activeOrchestration,
            tasks: s.activeOrchestration.tasks.map((t) =>
              t.id === taskId ? { ...t, status: 'cancelled' as const } : t
            ),
          },
        })),

      resetOrchestration: () =>
        set({ activeOrchestration: { ...IDLE_ORCHESTRATION } }),
    }),
    {
      name: 'cloudchat-orchestrator',
      version: 8,
      migrate: (persisted: unknown, version: number) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        if (version < 7) {
          // Migration: drop all dual-provider fields, keep only enabled + maxSubAgents
          return {
            enabled: state.enabled ?? true,
            maxSubAgents: state.maxSubAgents ?? DEFAULT_MAX_SUB_AGENTS,
            maxRetries: DEFAULT_MAX_RETRIES,
            fallbackModel: '',
          };
        }
        if (version < 8) {
          // Migration: add retry/fallback config fields
          return {
            ...state,
            maxRetries: state.maxRetries ?? DEFAULT_MAX_RETRIES,
            fallbackModel: state.fallbackModel ?? '',
          };
        }
        return state;
      },
      // Don't persist live orchestration state
      partialize: (state) => ({
        enabled: state.enabled,
        maxSubAgents: state.maxSubAgents,
        maxRetries: state.maxRetries,
        fallbackModel: state.fallbackModel,
      }),
    }
  )
);

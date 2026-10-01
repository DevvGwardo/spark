import { create } from 'zustand';

export interface ContextUsageSnapshot {
  provider: string;
  model: string;
  used: number;
  total: number;
  percentage: number;
}

/**
 * Live usage reported by the streaming backend (`usage` SSE/AI-SDK data-stream
 * event). `cachedInputTokens` is optional and only present when the provider
 * reports cache hits. `contextWindow` is the model's total context budget.
 */
export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  contextWindow: number;
  model: string;
  /** Turn cost in USD when the backend priced it (Hermes bridge). */
  costUsd?: number;
}

interface ContextUsageState {
  panelUsage: Record<string, ContextUsageSnapshot>;
  setPanelUsage: (panelId: string, usage: ContextUsageSnapshot) => void;
  clearPanelUsage: (panelId: string) => void;
  /** Latest backend-reported usage for the active stream, or null when idle. */
  usage: UsageInfo | null;
  setUsage: (usage: UsageInfo | null) => void;
}

export const useContextUsageStore = create<ContextUsageState>()((set) => ({
  panelUsage: {},
  usage: null,

  setUsage: (usage) => set({ usage }),

  setPanelUsage: (panelId, usage) =>
    set((state) => {
      const prev = state.panelUsage[panelId];
      if (
        prev &&
        prev.provider === usage.provider &&
        prev.model === usage.model &&
        prev.used === usage.used &&
        prev.total === usage.total &&
        prev.percentage === usage.percentage
      ) {
        return state;
      }
      return {
        panelUsage: {
          ...state.panelUsage,
          [panelId]: usage,
        },
      };
    }),

  clearPanelUsage: (panelId) =>
    set((state) => {
      const next = { ...state.panelUsage };
      delete next[panelId];
      return { panelUsage: next };
    }),
}));

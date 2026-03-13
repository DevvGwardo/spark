import { create } from 'zustand';

export interface ContextUsageSnapshot {
  provider: string;
  model: string;
  used: number;
  total: number;
  percentage: number;
}

interface ContextUsageState {
  panelUsage: Record<string, ContextUsageSnapshot>;
  setPanelUsage: (panelId: string, usage: ContextUsageSnapshot) => void;
  clearPanelUsage: (panelId: string) => void;
}

export const useContextUsageStore = create<ContextUsageState>()((set) => ({
  panelUsage: {},

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

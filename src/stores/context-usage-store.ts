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
    set((state) => ({
      panelUsage: {
        ...state.panelUsage,
        [panelId]: usage,
      },
    })),

  clearPanelUsage: (panelId) =>
    set((state) => {
      const next = { ...state.panelUsage };
      delete next[panelId];
      return { panelUsage: next };
    }),
}));

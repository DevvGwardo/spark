import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface HermesToolsets {
  web: boolean;
  browser: boolean;
  vision: boolean;
  terminal: boolean;
  files: boolean;
  code_execution: boolean;
}

interface HermesState {
  toolsets: HermesToolsets;
  bridgeUrl: string;
  setToolset: (key: keyof HermesToolsets, enabled: boolean) => void;
  setBridgeUrl: (url: string) => void;
  getEnabledToolsets: () => string[];
}

const defaultToolsets: HermesToolsets = {
  web: true,
  browser: true,
  vision: true,
  terminal: false,
  files: false,
  code_execution: false,
};

export const useHermesStore = create<HermesState>()(
  persist(
    (set, get) => ({
      toolsets: { ...defaultToolsets },
      bridgeUrl: 'http://localhost:3002/v1',

      setToolset: (key, enabled) =>
        set((state) => ({
          toolsets: { ...state.toolsets, [key]: enabled },
        })),

      setBridgeUrl: (url) => set({ bridgeUrl: url }),

      getEnabledToolsets: () => {
        const ts = get().toolsets;
        return Object.entries(ts)
          .filter(([, v]) => v)
          .map(([k]) => k);
      },
    }),
    { name: 'cloudchat-hermes' }
  )
);

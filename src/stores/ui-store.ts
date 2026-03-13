import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AppTab = 'chat' | 'github' | 'analyzer' | 'knowledge';

export interface PendingPanelPrompt {
  content: string;
  autoSend: boolean;
}

interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  settingsOpen: boolean;
  setupWizardOpen: boolean;
  repoBrowserOpen: boolean;
  activeTab: AppTab;
  pendingPanelPrompts: Record<string, PendingPanelPrompt | undefined>;
  setSidebarOpen: (v: boolean) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  setSettingsOpen: (v: boolean) => void;
  setSetupWizardOpen: (v: boolean) => void;
  setRepoBrowserOpen: (v: boolean) => void;
  queuePanelPrompt: (panelId: string, prompt: PendingPanelPrompt) => void;
  clearPanelPrompt: (panelId: string) => void;
  setActiveTab: (tab: AppTab) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: false,
      sidebarWidth: 256,
      settingsOpen: false,
      setupWizardOpen: false,
      repoBrowserOpen: false,
      activeTab: 'chat',
      pendingPanelPrompts: {},
      setSidebarOpen: (v) => set({ sidebarOpen: v }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarWidth: (w) => set({ sidebarWidth: Math.max(200, Math.min(480, w)) }),
      setSettingsOpen: (v) => set({ settingsOpen: v }),
      setSetupWizardOpen: (v) => set({ setupWizardOpen: v }),
      setRepoBrowserOpen: (v) => set({ repoBrowserOpen: v }),
      queuePanelPrompt: (panelId, prompt) =>
        set((state) => ({
          pendingPanelPrompts: {
            ...state.pendingPanelPrompts,
            [panelId]: prompt,
          },
        })),
      clearPanelPrompt: (panelId) =>
        set((state) => {
          const nextPrompts = { ...state.pendingPanelPrompts };
          delete nextPrompts[panelId];
          return {
            pendingPanelPrompts: nextPrompts,
          };
        }),
      setActiveTab: (tab) => set({ activeTab: tab }),
    }),
    {
      name: 'ui-store',
      partialize: (state) => ({ sidebarOpen: state.sidebarOpen, sidebarWidth: state.sidebarWidth }),
    }
  )
);

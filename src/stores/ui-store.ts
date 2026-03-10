import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AppTab = 'chat' | 'github' | 'analyzer' | 'knowledge';

interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  settingsOpen: boolean;
  setupWizardOpen: boolean;
  activeTab: AppTab;
  setSidebarOpen: (v: boolean) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  setSettingsOpen: (v: boolean) => void;
  setSetupWizardOpen: (v: boolean) => void;
  setActiveTab: (tab: AppTab) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: false,
      sidebarWidth: 256,
      settingsOpen: false,
      setupWizardOpen: false,
      activeTab: 'chat',
      setSidebarOpen: (v) => set({ sidebarOpen: v }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarWidth: (w) => set({ sidebarWidth: Math.max(200, Math.min(480, w)) }),
      setSettingsOpen: (v) => set({ settingsOpen: v }),
      setSetupWizardOpen: (v) => set({ setupWizardOpen: v }),
      setActiveTab: (tab) => set({ activeTab: tab }),
    }),
    {
      name: 'ui-store',
      partialize: (state) => ({ sidebarOpen: state.sidebarOpen, sidebarWidth: state.sidebarWidth }),
    }
  )
);

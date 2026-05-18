import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AppTab = 'chat' | 'github' | 'analyzer' | 'knowledge';
export type SubTab = 'overview' | 'threads' | 'queue' | 'chats' | 'cron' | 'memories' | 'skills' | 'usage' | 'profiles' | 'images' | 'kanban' | 'tasks' | 'rooms';

export interface PendingPanelPrompt {
  content: string;
  autoSend: boolean;
  repoEditIntentOverride?: boolean;
}

interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  settingsOpen: boolean;
  setupWizardOpen: boolean;
  repoBrowserOpen: boolean;
  terminalOpen: boolean;
  terminalHeight: number;
  hermesTerminalOpen: boolean;
  hermesTerminalHeight: number;
  activeTab: AppTab;
  activeSubTab: SubTab;
  miniBrowserOpen: boolean;
  miniBrowserUrl: string;
  miniBrowserDocked: boolean;
  miniBrowserDockedWidth: number;
  rightSidebarHidden: boolean;
  pendingPanelPrompts: Record<string, PendingPanelPrompt | undefined>;
  preservePanelRepoHandoffs: Record<string, boolean | undefined>;
  setSidebarOpen: (v: boolean) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  setSettingsOpen: (v: boolean) => void;
  setSetupWizardOpen: (v: boolean) => void;
  setRepoBrowserOpen: (v: boolean) => void;
  setTerminalOpen: (v: boolean) => void;
  toggleTerminal: () => void;
  setTerminalHeight: (h: number) => void;
  setHermesTerminalOpen: (v: boolean) => void;
  toggleHermesTerminal: () => void;
  setHermesTerminalHeight: (h: number) => void;
  setMiniBrowserOpen: (v: boolean) => void;
  setMiniBrowserUrl: (url: string) => void;
  setMiniBrowserDocked: (v: boolean) => void;
  setMiniBrowserDockedWidth: (w: number) => void;
  setRightSidebarHidden: (v: boolean) => void;
  toggleRightSidebarHidden: () => void;
  queuePanelPrompt: (panelId: string, prompt: PendingPanelPrompt) => void;
  clearPanelPrompt: (panelId: string) => void;
  markPanelRepoHandoff: (panelId: string) => void;
  clearPanelRepoHandoff: (panelId: string) => void;
  setActiveTab: (tab: AppTab) => void;
  setActiveSubTab: (tab: SubTab) => void;
  selectedCronJobId: string | null;
  setSelectedCronJobId: (id: string | null) => void;
  selectedSessionId: string | null;
  setSelectedSessionId: (id: string | null) => void;
  hermesSessionViewMode: 'focused' | 'all-active';
  setHermesSessionViewMode: (mode: 'focused' | 'all-active') => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: false,
      sidebarWidth: 350,
      settingsOpen: false,
      setupWizardOpen: false,
      repoBrowserOpen: false,
      terminalOpen: false,
      terminalHeight: 300,
      hermesTerminalOpen: false,
      hermesTerminalHeight: 300,
      activeTab: 'chat',
      activeSubTab: 'threads',
      miniBrowserOpen: false,
      miniBrowserUrl: 'about:blank',
      miniBrowserDocked: false,
      miniBrowserDockedWidth: 400,
      rightSidebarHidden: false,
      pendingPanelPrompts: {},
      preservePanelRepoHandoffs: {},
      setSidebarOpen: (v) => set({ sidebarOpen: v }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarWidth: (w) => set({ sidebarWidth: Math.max(200, Math.min(480, w)) }),
      setSettingsOpen: (v) => set({ settingsOpen: v }),
      setSetupWizardOpen: (v) => set({ setupWizardOpen: v }),
      setRepoBrowserOpen: (v) => set({ repoBrowserOpen: v }),
      setTerminalOpen: (v) => set({ terminalOpen: v }),
      toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
      setTerminalHeight: (h) => set({ terminalHeight: Math.max(150, Math.min(600, h)) }),
      setHermesTerminalOpen: (v) => set({ hermesTerminalOpen: v }),
      toggleHermesTerminal: () => set((s) => ({ hermesTerminalOpen: !s.hermesTerminalOpen })),
      setHermesTerminalHeight: (h) => set({ hermesTerminalHeight: Math.max(150, Math.min(600, h)) }),

      setMiniBrowserOpen: (v) => set({ miniBrowserOpen: v }),
      setMiniBrowserUrl: (url) => set({ miniBrowserUrl: url }),
      setMiniBrowserDocked: (v) => set({ miniBrowserDocked: v }),
      setMiniBrowserDockedWidth: (w) => set({ miniBrowserDockedWidth: Math.max(300, Math.min(600, w)) }),
      setRightSidebarHidden: (v) => set({ rightSidebarHidden: v }),
      toggleRightSidebarHidden: () => set((s) => ({ rightSidebarHidden: !s.rightSidebarHidden })),
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
      markPanelRepoHandoff: (panelId) =>
        set((state) => ({
          preservePanelRepoHandoffs: {
            ...state.preservePanelRepoHandoffs,
            [panelId]: true,
          },
        })),
      clearPanelRepoHandoff: (panelId) =>
        set((state) => {
          const nextHandoffs = { ...state.preservePanelRepoHandoffs };
          delete nextHandoffs[panelId];
          return {
            preservePanelRepoHandoffs: nextHandoffs,
          };
        }),
      setActiveTab: (tab) => set({ activeTab: tab }),
      setActiveSubTab: (tab) => set({ activeSubTab: tab }),
      selectedCronJobId: null,
      setSelectedCronJobId: (id) => set({ selectedCronJobId: id }),
      selectedSessionId: null,
      setSelectedSessionId: (id) => set({ selectedSessionId: id }),
      hermesSessionViewMode: 'focused',
      setHermesSessionViewMode: (mode) => set({ hermesSessionViewMode: mode }),
    }),
    {
      name: 'ui-store',
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
        sidebarWidth: state.sidebarWidth,
        terminalHeight: state.terminalHeight,
        hermesTerminalOpen: state.hermesTerminalOpen,
        hermesTerminalHeight: state.hermesTerminalHeight,
        hermesSessionViewMode: state.hermesSessionViewMode,
      }),
    }
  )
);

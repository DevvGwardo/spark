import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AppTab = 'chat' | 'github' | 'analyzer' | 'knowledge';
export type SubTab = 'overview' | 'threads' | 'queue' | 'chats' | 'cron' | 'memories' | 'skills' | 'usage' | 'profiles' | 'images' | 'mcp' | 'kanban' | 'ralph' | 'tasks' | 'rooms' | 'teams' | 'system';
export type SettingsSection = 'providers' | 'messaging' | 'cursor-composer' | 'github' | 'knowledge' | 'general';

export interface PendingPanelPrompt {
  content: string;
  autoSend: boolean;
  repoEditIntentOverride?: boolean;
}

interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  settingsOpen: boolean;
  /** When Settings is opened with a target section, the modal jumps straight to it. */
  settingsSection: SettingsSection | null;
  setupWizardOpen: boolean;
  repoBrowserOpen: boolean;
  terminalOpen: boolean;
  terminalHeight: number;
  hermesTerminalOpen: boolean;
  activeTab: AppTab;
  activeSubTab: SubTab;
  miniBrowserOpen: boolean;
  miniBrowserUrl: string;
  miniBrowserDocked: boolean;
  miniBrowserDockedWidth: number;
  rightSidebarHidden: boolean;
  kanbanFullscreen: boolean;
  mcpStoreFullscreen: boolean;
  tourSeen: boolean;
  /** Mirrors AppLayout's bridge-setup modal visibility so the tour can wait for it to clear. */
  bridgeSetupOpen: boolean;
  /** Bumped to ask AppLayout to open the bridge-setup modal (e.g. from BridgeGate's "Set up"). */
  bridgeSetupRequest: number;
  pendingPanelPrompts: Record<string, PendingPanelPrompt | undefined>;
  preservePanelRepoHandoffs: Record<string, boolean | undefined>;
  setSidebarOpen: (v: boolean) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  setSettingsOpen: (v: boolean, section?: SettingsSection | null) => void;
  setSetupWizardOpen: (v: boolean) => void;
  setRepoBrowserOpen: (v: boolean) => void;
  setTerminalOpen: (v: boolean) => void;
  toggleTerminal: () => void;
  setTerminalHeight: (h: number) => void;
  toggleHermesTerminal: () => void;
  setMiniBrowserOpen: (v: boolean) => void;
  setMiniBrowserUrl: (url: string) => void;
  setMiniBrowserDocked: (v: boolean) => void;
  setMiniBrowserDockedWidth: (w: number) => void;
  setRightSidebarHidden: (v: boolean) => void;
  toggleRightSidebarHidden: () => void;
  setKanbanFullscreen: (v: boolean) => void;
  toggleKanbanFullscreen: () => void;
  setMcpStoreFullscreen: (v: boolean) => void;
  toggleMcpStoreFullscreen: () => void;
  setTourSeen: (v: boolean) => void;
  setBridgeSetupOpen: (v: boolean) => void;
  requestBridgeSetup: () => void;
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
      settingsSection: null,
      setupWizardOpen: false,
      repoBrowserOpen: false,
      terminalOpen: false,
      terminalHeight: 300,
      hermesTerminalOpen: false,
      activeTab: 'chat',
      activeSubTab: 'threads',
      miniBrowserOpen: false,
      miniBrowserUrl: 'about:blank',
      miniBrowserDocked: false,
      miniBrowserDockedWidth: 400,
      rightSidebarHidden: false,
      kanbanFullscreen: false,
      mcpStoreFullscreen: false,
      tourSeen: false,
      bridgeSetupOpen: false,
      bridgeSetupRequest: 0,
      pendingPanelPrompts: {},
      preservePanelRepoHandoffs: {},
      setSidebarOpen: (v) => set({ sidebarOpen: v }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarWidth: (w) => set({ sidebarWidth: Math.max(200, Math.min(480, w)) }),
      setSettingsOpen: (v, section) => set({ settingsOpen: v, settingsSection: v ? section ?? null : null }),
      setSetupWizardOpen: (v) => set({ setupWizardOpen: v }),
      setRepoBrowserOpen: (v) => set({ repoBrowserOpen: v }),
      setTerminalOpen: (v) => set({ terminalOpen: v }),
      toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
      setTerminalHeight: (h) => set({ terminalHeight: Math.max(150, Math.min(600, h)) }),
      toggleHermesTerminal: () => set((s) => ({ hermesTerminalOpen: !s.hermesTerminalOpen })),

      setMiniBrowserOpen: (v) => set({ miniBrowserOpen: v }),
      setMiniBrowserUrl: (url) => set({ miniBrowserUrl: url }),
      setMiniBrowserDocked: (v) => set({ miniBrowserDocked: v }),
      setMiniBrowserDockedWidth: (w) => set({ miniBrowserDockedWidth: Math.max(300, Math.min(600, w)) }),
      setRightSidebarHidden: (v) => set({ rightSidebarHidden: v }),
      toggleRightSidebarHidden: () => set((s) => ({ rightSidebarHidden: !s.rightSidebarHidden })),
      setKanbanFullscreen: (v) => set({ kanbanFullscreen: v }),
      toggleKanbanFullscreen: () => set((s) => ({ kanbanFullscreen: !s.kanbanFullscreen })),
      setMcpStoreFullscreen: (v) => set({ mcpStoreFullscreen: v }),
      toggleMcpStoreFullscreen: () => set((s) => ({ mcpStoreFullscreen: !s.mcpStoreFullscreen })),
      setTourSeen: (v) => set({ tourSeen: v }),
      setBridgeSetupOpen: (v) => set({ bridgeSetupOpen: v }),
      requestBridgeSetup: () => set((s) => ({ bridgeSetupRequest: s.bridgeSetupRequest + 1 })),
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
        hermesSessionViewMode: state.hermesSessionViewMode,
        tourSeen: state.tourSeen,
      }),
    }
  )
);

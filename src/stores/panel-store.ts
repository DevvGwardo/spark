import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const MAX_PANELS = 4;

const DEFAULT_PANEL: Panel = { id: 'default', conversationId: null };

interface Panel {
  id: string;
  conversationId: string | null;
}

interface DockedPanel {
  conversationId: string;
  sourcePanelId: string;
}

interface PanelState {
  panels: Panel[];
  focusedPanelId: string;
  dockedPanel: DockedPanel | null;
  dockedPanelWidth: number;
  openPanel: (conversationId: string | null) => string;
  closePanel: (panelId: string) => void;
  focusPanel: (panelId: string) => void;
  setConversationForPanel: (panelId: string, conversationId: string | null) => void;
  dockPanel: (panelId: string, conversationId: string) => void;
  undockPanel: () => void;
  setDockedPanelWidth: (width: number) => void;
}

let panelCounter = 0;

function generatePanelId(): string {
  panelCounter += 1;
  return `panel-${Date.now()}-${panelCounter}`;
}

export const usePanelStore = create<PanelState>()(
  persist(
    (set, get) => ({
      panels: [DEFAULT_PANEL],
      focusedPanelId: 'default',
      dockedPanel: null,
      dockedPanelWidth: 380,

      openPanel: (conversationId) => {
        const { panels } = get();
        if (conversationId) {
          const existingPanel = panels.find((p) => p.conversationId === conversationId);
          if (existingPanel) {
            set({ focusedPanelId: existingPanel.id });
            return existingPanel.id;
          }
        }
        if (panels.length >= MAX_PANELS) {
          // At cap — focus the last panel and assign the conversation to it
          const lastPanel = panels[panels.length - 1];
          set({
            panels: panels.map((p) =>
              p.id === lastPanel.id ? { ...p, conversationId } : p
            ),
            focusedPanelId: lastPanel.id,
          });
          return lastPanel.id;
        }

        const id = generatePanelId();
        set({
          panels: [...panels, { id, conversationId }],
          focusedPanelId: id,
        });
        return id;
      },

      closePanel: (panelId) => {
        const { panels, focusedPanelId } = get();
        if (panels.length <= 1) return;

        const index = panels.findIndex((p) => p.id === panelId);
        if (index === -1) return;

        const remaining = panels.filter((p) => p.id !== panelId);

        let nextFocusedId = focusedPanelId;
        if (focusedPanelId === panelId) {
          // Focus the adjacent panel: prefer the one at the same index, fall back to previous
          const adjacentIndex = Math.min(index, remaining.length - 1);
          nextFocusedId = remaining[adjacentIndex].id;
        }

        set({ panels: remaining, focusedPanelId: nextFocusedId });
      },

      focusPanel: (panelId) => {
        const { panels } = get();
        if (panels.some((p) => p.id === panelId)) {
          set({ focusedPanelId: panelId });
        }
      },

      setConversationForPanel: (panelId, conversationId) => {
        const { panels } = get();
        // If the target panel doesn't exist, fall back to the first panel
        const targetId = panels.some((p) => p.id === panelId) ? panelId : panels[0]?.id;
        if (!targetId) return;
        set({
          panels: panels.map((p) =>
            p.id === targetId
              ? { ...p, conversationId }
              : conversationId && p.conversationId === conversationId
                ? { ...p, conversationId: null }
                : p
          ),
          focusedPanelId: targetId,
        });
      },

      dockPanel: (panelId, conversationId) => {
        const { panels, focusedPanelId } = get();
        // Don't dock if already docked or no conversation
        if (!conversationId) return;
        // Remove the panel from the panels array (if it's not the only one)
        const remaining = panels.length > 1
          ? panels.filter((p) => p.id !== panelId)
          : [{ id: panelId, conversationId: null }]; // clear the conversation from the only panel

        let nextFocusedId = focusedPanelId;
        if (focusedPanelId === panelId && remaining.length > 0) {
          nextFocusedId = remaining[0].id;
        }

        set({
          panels: remaining,
          focusedPanelId: nextFocusedId,
          dockedPanel: { conversationId, sourcePanelId: panelId },
        });
      },

      undockPanel: () => {
        const { dockedPanel, panels } = get();
        if (!dockedPanel) return;
        // Find a panel to put the conversation back into
        // Prefer a panel with no conversation, or open a new one
        const emptyPanel = panels.find((p) => !p.conversationId);
        if (emptyPanel) {
          set({
            panels: panels.map((p) =>
              p.id === emptyPanel.id ? { ...p, conversationId: dockedPanel.conversationId } : p
            ),
            focusedPanelId: emptyPanel.id,
            dockedPanel: null,
          });
        } else if (panels.length < MAX_PANELS) {
          const id = generatePanelId();
          set({
            panels: [...panels, { id, conversationId: dockedPanel.conversationId }],
            focusedPanelId: id,
            dockedPanel: null,
          });
        } else {
          // Replace last panel
          const lastPanel = panels[panels.length - 1];
          set({
            panels: panels.map((p) =>
              p.id === lastPanel.id ? { ...p, conversationId: dockedPanel.conversationId } : p
            ),
            focusedPanelId: lastPanel.id,
            dockedPanel: null,
          });
        }
      },

      setDockedPanelWidth: (width) => {
        set({ dockedPanelWidth: Math.max(280, Math.min(600, width)) });
      },
    }),
    {
      name: 'cloud-chat-panels',
      onRehydrateStorage: () => (state) => {
        if (!state || !state.panels || state.panels.length === 0) {
          usePanelStore.setState({
            panels: [DEFAULT_PANEL],
            focusedPanelId: 'default',
          });
        } else {
          // Ensure focusedPanelId references an actual panel
          const valid = state.panels.some((p) => p.id === state.focusedPanelId);
          if (!valid) {
            usePanelStore.setState({ focusedPanelId: state.panels[0].id });
          }
        }
      },
    }
  )
);

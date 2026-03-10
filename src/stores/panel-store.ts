import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const MAX_PANELS = 4;

const DEFAULT_PANEL: Panel = { id: 'default', conversationId: null };

interface Panel {
  id: string;
  conversationId: string | null;
}

interface PanelState {
  panels: Panel[];
  focusedPanelId: string;
  openPanel: (conversationId: string | null) => string;
  closePanel: (panelId: string) => void;
  focusPanel: (panelId: string) => void;
  setConversationForPanel: (panelId: string, conversationId: string | null) => void;
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

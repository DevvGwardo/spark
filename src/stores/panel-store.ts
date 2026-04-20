import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Each panel is an isolated session: its own Hermes profile (state.db, skills/,
// working dir). Sessions can stream in parallel because the bridge resolves to
// different hermes_home dirs per profile. The 'default' profile is reserved
// for the original single-session experience.
const DEFAULT_PANEL: Panel = { id: 'default', conversationId: null, profile: 'default' };

interface Panel {
  id: string;
  conversationId: string | null;
  profile: string;
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

// Session profile name: human-sortable timestamp + counter. Kept short so the
// bridge's ~/.hermes/profiles/<name> path stays reasonable.
function generateSessionProfile(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(2, 12);
  return `session-${stamp}-${panelCounter}`;
}

// Fire-and-forget deletion of an auto-created session profile. Keeps
// ~/.hermes/profiles from accumulating one dir per closed panel. Only targets
// names we generated (`session-*`); user-named profiles and 'default' are
// never touched.
function cleanupSessionProfile(profile: string): void {
  if (!profile || profile === 'default' || !profile.startsWith('session-')) return;
  try {
    void fetch('/api/hermes/profiles/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: profile }),
    }).catch(() => { /* best-effort */ });
  } catch {
    /* best-effort */
  }
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

        const id = generatePanelId();
        set({
          panels: [...panels, { id, conversationId, profile: generateSessionProfile() }],
          focusedPanelId: id,
        });
        return id;
      },

      closePanel: (panelId) => {
        const { panels, focusedPanelId } = get();
        if (panels.length <= 1) return;

        const index = panels.findIndex((p) => p.id === panelId);
        if (index === -1) return;

        const closed = panels[index];
        const remaining = panels.filter((p) => p.id !== panelId);

        let nextFocusedId = focusedPanelId;
        if (focusedPanelId === panelId) {
          // Focus the adjacent panel: prefer the one at the same index, fall back to previous
          const adjacentIndex = Math.min(index, remaining.length - 1);
          nextFocusedId = remaining[adjacentIndex].id;
        }

        set({ panels: remaining, focusedPanelId: nextFocusedId });

        // Reap the auto-generated profile dir so ~/.hermes/profiles doesn't
        // grow unbounded. Skipped if another panel still uses the same profile.
        const stillUsed = remaining.some((p) => p.profile === closed.profile);
        if (!stillUsed) cleanupSessionProfile(closed.profile);
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
          : [{ id: panelId, conversationId: null, profile: panels[0]?.profile ?? 'default' }];

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
        } else {
          const id = generatePanelId();
          set({
            panels: [...panels, { id, conversationId: dockedPanel.conversationId, profile: generateSessionProfile() }],
            focusedPanelId: id,
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
          return;
        }
        // Backfill profile on panels persisted before per-session profiles existed.
        // The original 'default' panel keeps 'default'; others get a fresh profile
        // so the old global-profile behavior is preserved for the primary session.
        const needsBackfill = state.panels.some((p) => typeof p.profile !== 'string' || !p.profile);
        if (needsBackfill) {
          usePanelStore.setState({
            panels: state.panels.map((p) => ({
              ...p,
              profile: p.profile && typeof p.profile === 'string'
                ? p.profile
                : p.id === 'default'
                  ? 'default'
                  : generateSessionProfile(),
            })),
          });
        }
        // Ensure focusedPanelId references an actual panel
        const valid = state.panels.some((p) => p.id === state.focusedPanelId);
        if (!valid) {
          usePanelStore.setState({ focusedPanelId: state.panels[0].id });
        }
      },
    }
  )
);

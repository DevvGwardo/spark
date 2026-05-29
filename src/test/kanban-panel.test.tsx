import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanPanel } from '@/components/sidebar/KanbanPanel';
import { useKanbanStore } from '@/stores/kanban-store';
import { usePanelStore } from '@/stores/panel-store';
import { useUIStore } from '@/stores/ui-store';
import { toast } from '@/lib/toast';

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('KanbanPanel', () => {
  beforeEach(() => {
    window.localStorage.clear();

    usePanelStore.setState({
      panels: [{ id: 'default', conversationId: null, profile: 'default' }],
      focusedPanelId: 'default',
      dockedPanel: null,
      dockedPanelWidth: 380,
    });

    useUIStore.setState((state) => ({
      ...state,
      activeTab: 'github',
      sidebarOpen: false,
      pendingPanelPrompts: {},
    }));
  });

  it('dispatches a card to a background agent', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const fetchCards = vi.fn().mockResolvedValue(undefined);
    const createCard = vi.fn().mockResolvedValue(undefined);
    const deleteCard = vi.fn().mockResolvedValue(undefined);
    const updateCard = vi.fn().mockResolvedValue(undefined);

    useKanbanStore.setState({
      cards: [
        {
          id: 'card-1',
          title: 'Ship Hermes rollout',
          spec: 'Audit the remaining local-first blockers and implement the fixes.',
          acceptanceCriteria: ['Hermes route pass is green', 'UI feedback is visible'],
          assignedWorker: 'claude-code',
          reviewer: 'devgwardo',
          status: 'backlog',
          missionId: '',
          reportPath: '',
          createdBy: 'kanban',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      loading: false,
      error: null,
      fetchCards,
      createCard,
      updateCard,
      deleteCard,
      moveCard: vi.fn().mockResolvedValue(undefined),
    });

    render(<KanbanPanel />);

    fireEvent.click(screen.getByTitle('Dispatch as background agent'));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Dispatched "Ship Hermes rollout" to background agent');
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/hermes/orchestrator/dispatch-card/card-1'),
      expect.objectContaining({ method: 'POST' }),
    );

    vi.unstubAllGlobals();
  });

  it('renders the inline store error when kanban requests fail', () => {
    useKanbanStore.setState({
      cards: [],
      loading: false,
      error: 'Failed to create card',
      fetchCards: vi.fn().mockResolvedValue(undefined),
      createCard: vi.fn().mockResolvedValue(undefined),
      updateCard: vi.fn().mockResolvedValue(undefined),
      deleteCard: vi.fn().mockResolvedValue(undefined),
      moveCard: vi.fn().mockResolvedValue(undefined),
    });

    render(<KanbanPanel />);

    expect(screen.getByText('Failed to create card')).toBeInTheDocument();
  });
});

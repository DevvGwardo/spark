import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSidebar } from '@/components/sidebar/ChatSidebar';
import { useActivityStore } from '@/stores/activity-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { useChatStore } from '@/stores/chat-store';
import { usePanelStore } from '@/stores/panel-store';
import { useUIStore } from '@/stores/ui-store';
import type { Conversation } from '@/lib/db';

describe('ChatSidebar archive group', () => {
  beforeEach(() => {
    window.localStorage.clear();

    const active: Conversation = {
      id: 'active-1',
      title: 'Active thread',
      provider: 'openai',
      model: 'gpt-5.2',
      systemPrompt: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const archived: Conversation = {
      id: 'archived-1',
      title: 'Archived thread',
      provider: 'openai',
      model: 'gpt-5.2',
      systemPrompt: '',
      createdAt: '2026-03-01T10:00:00.000Z',
      updatedAt: '2026-03-01T10:00:00.000Z',
      archivedAt: '2026-03-05T10:00:00.000Z',
    };

    useChatStore.setState((state) => ({
      ...state,
      conversations: [active],
      archivedConversations: [archived],
      activeConversationId: null,
      searchQuery: '',
      loadConversations: vi.fn().mockResolvedValue(undefined),
    }));
    useUIStore.setState((state) => ({
      ...state,
      activeTab: 'chat',
      settingsOpen: false,
      setupWizardOpen: false,
      repoBrowserOpen: false,
      pendingPanelPrompts: {},
    }));
    usePanelStore.setState((state) => ({
      ...state,
      panels: [{ id: 'default', conversationId: null, profile: 'default' }],
      focusedPanelId: 'default',
    }));
    useActivityStore.setState({ activities: {} });
    useChangesetStore.setState({ panelChangesets: {} });
  });

  it('shows the Archived group header with count and hides archived rows by default', () => {
    render(<ChatSidebar />);

    expect(screen.getByRole('button', { name: 'Archived (1)' })).toBeInTheDocument();
    expect(screen.getAllByText('Active thread').length).toBeGreaterThan(0);
    // Row is collapsed by default
    expect(screen.queryByText('Archived thread')).not.toBeInTheDocument();
  });
});

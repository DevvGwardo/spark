import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSidebar } from '@/components/sidebar/ChatSidebar';
import { useActivityStore } from '@/stores/activity-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { useChatStore } from '@/stores/chat-store';
import { usePanelStore } from '@/stores/panel-store';
import { useUIStore } from '@/stores/ui-store';
import type { Conversation } from '@/lib/db';

describe('ChatSidebar tags', () => {
  beforeEach(() => {
    window.localStorage.clear();

    const prod: Conversation = {
      id: 'prod-conv',
      title: 'Prod thread',
      provider: 'openai',
      model: 'gpt-5.2',
      systemPrompt: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: ['prod'],
    };
    const scratch: Conversation = {
      id: 'scratch-conv',
      title: 'Scratch thread',
      provider: 'openai',
      model: 'gpt-5.2',
      systemPrompt: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: ['scratch'],
    };

    useChatStore.setState((state) => ({
      ...state,
      conversations: [prod, scratch],
      archivedConversations: [],
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

  it('renders tag chips on rows and a filter bar with both tags', () => {
    render(<ChatSidebar />);

    expect(screen.getAllByText('Prod thread').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Scratch thread').length).toBeGreaterThan(0);

    const filterBar = screen.getByLabelText('Filter by tag');
    expect(within(filterBar).getByText('#prod')).toBeInTheDocument();
    expect(within(filterBar).getByText('#scratch')).toBeInTheDocument();
    expect(within(filterBar).getByText('All')).toBeInTheDocument();
  });

  it('filters the list to only rows carrying the clicked tag', () => {
    render(<ChatSidebar />);

    const filterBar = screen.getByLabelText('Filter by tag');
    fireEvent.click(within(filterBar).getByText('#prod'));

    expect(screen.getAllByText('Prod thread').length).toBeGreaterThan(0);
    expect(screen.queryByText('Scratch thread')).not.toBeInTheDocument();
  });

  it('combines filters when shift-clicking multiple tags (AND)', () => {
    render(<ChatSidebar />);

    const filterBar = screen.getByLabelText('Filter by tag');
    // Regular click selects prod only
    fireEvent.click(within(filterBar).getByText('#prod'));
    expect(screen.queryByText('Scratch thread')).not.toBeInTheDocument();

    // Shift-click scratch → AND filter, no conversation carries both
    fireEvent.click(within(filterBar).getByText('#scratch'), { shiftKey: true });
    expect(screen.queryByText('Prod thread')).not.toBeInTheDocument();
    expect(screen.queryByText('Scratch thread')).not.toBeInTheDocument();
  });
});

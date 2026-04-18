import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSidebar } from '@/components/sidebar/ChatSidebar';
import { useActivityStore } from '@/stores/activity-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { useChatStore } from '@/stores/chat-store';
import { usePanelStore } from '@/stores/panel-store';
import { useUIStore } from '@/stores/ui-store';

describe('ChatSidebar', () => {
  beforeEach(() => {
    window.localStorage.clear();

    useChatStore.setState((state) => ({
      ...state,
      conversations: [],
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
      panels: [{ id: 'default', conversationId: null }],
      focusedPanelId: 'default',
    }));
    useActivityStore.setState({ activities: {} });
    useChangesetStore.setState({ panelChangesets: {} });
  });

  it('shows the attached repo name in the footer without file counts', () => {
    useChangesetStore.getState().switchActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
      permissions: { pull: true, push: true },
    });
    useChangesetStore.getState().setRepoFileTree('default', ['README.md', 'src/App.tsx']);
    useChangesetStore.getState().cacheRepoFile('default', 'README.md', '# CloudChat');

    render(<ChatSidebar />);

    expect(screen.getByText('Can push')).toBeInTheDocument();
    expect(screen.getByText('octo/cloudchat')).toBeInTheDocument();
    expect(screen.queryByText('2 files · 1 cached')).not.toBeInTheDocument();
    expect(screen.queryByText('Repo attached')).not.toBeInTheDocument();
  });

  it('switches to a compact footer layout when the sidebar is narrow', () => {
    useUIStore.setState((state) => ({
      ...state,
      sidebarWidth: 280,
    }));
    useChangesetStore.getState().switchActiveRepo('default', {
      owner: 'octo',
      name: 'cloudchat',
      defaultBranch: 'main',
      fullName: 'octo/cloudchat',
      permissions: { pull: true },
    });
    useChangesetStore.getState().setRepoFileTree('default', ['README.md', 'src/App.tsx']);
    useChangesetStore.getState().cacheRepoFile('default', 'README.md', '# CloudChat');

    render(<ChatSidebar />);

    expect(screen.queryByText('Read-only')).not.toBeInTheDocument();
    expect(screen.getByText('cloudchat')).toBeInTheDocument();
    expect(screen.queryByText('2 files')).not.toBeInTheDocument();
    expect(screen.queryByText('2 files · 1 cached')).not.toBeInTheDocument();
  });

  it('collapses the new thread button to icon-only when the sidebar is very narrow', () => {
    useUIStore.setState((state) => ({
      ...state,
      sidebarWidth: 260,
    }));

    render(<ChatSidebar />);

    expect(screen.getByRole('button', { name: 'New thread' })).toBeInTheDocument();
    expect(screen.queryByText('New thread')).not.toBeInTheDocument();
  });

  it('returns the focused panel to a blank draft without creating a conversation', () => {
    const createConversation = vi.fn().mockResolvedValue('conv-2');

    useChatStore.setState((state) => ({
      ...state,
      createConversation,
    }));
    useUIStore.setState((state) => ({
      ...state,
      activeTab: 'github',
    }));
    usePanelStore.setState((state) => ({
      ...state,
      panels: [{ id: 'default', conversationId: 'conv-1' }],
      focusedPanelId: 'default',
    }));

    render(<ChatSidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'New thread' }));

    expect(useUIStore.getState().activeTab).toBe('chat');
    expect(usePanelStore.getState().panels[0]?.conversationId).toBeNull();
    expect(createConversation).not.toHaveBeenCalled();
  });

});

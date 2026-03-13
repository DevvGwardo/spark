import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangesetStore } from '@/stores/changeset-store';
import { useChatStore } from '@/stores/chat-store';
import { useContextUsageStore } from '@/stores/context-usage-store';
import { usePanelStore } from '@/stores/panel-store';
import { usePreviewStore } from '@/stores/preview-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

const chatLifecycle = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
}));

vi.mock('@/components/chat/ChatPanelContainer', async () => {
  const React = await import('react');

  return {
    ChatPanelContainer: () => {
      React.useEffect(() => {
        chatLifecycle.mounts += 1;
        return () => {
          chatLifecycle.unmounts += 1;
        };
      }, []);

      return React.createElement('div', { 'data-testid': 'chat-panel-container' }, 'Chat panel');
    },
  };
});

vi.mock('@/components/sidebar/ChatSidebar', () => ({
  ChatSidebar: () => <div data-testid="chat-sidebar" />,
}));

vi.mock('@/components/settings/SettingsModal', () => ({
  SettingsModal: () => null,
}));

vi.mock('@/components/settings/SetupWizard', () => ({
  SetupWizard: () => null,
}));

vi.mock('@/components/github', () => ({
  GitHubPanel: () => <div data-testid="github-panel" />,
  GitHubAnalyzer: () => <div data-testid="github-analyzer" />,
}));

vi.mock('@/components/settings/KnowledgePanel', () => ({
  KnowledgePanel: () => <div data-testid="knowledge-panel" />,
}));

vi.mock('@/components/github/CreatePRModal', () => ({
  CreatePRModal: () => null,
}));

vi.mock('@/components/preview/PreviewSidebar', () => ({
  PreviewSidebar: () => <div data-testid="preview-sidebar" />,
}));

vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => undefined,
}));

vi.mock('@/hooks/useGlobalStyles', () => ({
  useGlobalStyles: () => undefined,
}));

import { AppLayout } from '@/components/layout/AppLayout';

describe('AppLayout tab switching', () => {
  beforeEach(() => {
    window.localStorage.clear();
    chatLifecycle.mounts = 0;
    chatLifecycle.unmounts = 0;

    useUIStore.setState({
      sidebarOpen: false,
      sidebarWidth: 256,
      settingsOpen: false,
      setupWizardOpen: false,
      repoBrowserOpen: false,
      activeTab: 'chat',
      pendingPanelPrompts: {},
    });

    useSettingsStore.setState((state) => ({
      ...state,
      isSetupComplete: true,
      activeProvider: 'openai',
    }));

    useChatStore.setState({
      conversations: [],
      activeConversationId: null,
      searchQuery: '',
    });

    usePanelStore.setState({
      panels: [{ id: 'default', conversationId: null }],
      focusedPanelId: 'default',
    });

    useChangesetStore.setState({
      panelChangesets: {},
    });

    usePreviewStore.setState({
      panelPreviews: {},
    });

    useContextUsageStore.setState({
      panelUsage: {},
    });
  });

it('keeps the chat panel mounted and snaps unsupported tabs back to chat', () => {
  render(<AppLayout />);

  expect(screen.getByTestId('chat-panel-container')).toBeInTheDocument();
  expect(chatLifecycle.mounts).toBe(1);
  expect(chatLifecycle.unmounts).toBe(0);

  act(() => {
    useUIStore.getState().setActiveTab('github');
  });

  expect(screen.getByTestId('chat-panel-container')).toBeInTheDocument();
  expect(useUIStore.getState().activeTab).toBe('chat');
  expect(screen.queryByTestId('github-panel')).not.toBeInTheDocument();
  expect(chatLifecycle.mounts).toBe(1);
  expect(chatLifecycle.unmounts).toBe(0);
});

  it('shows repo attachment status without implying edits are already approved', () => {
    useChangesetStore.setState({
      panelChangesets: {
        default: {
          activeRepo: {
            owner: 'octo',
            name: 'cloudchat',
            defaultBranch: 'main',
            fullName: 'octo/cloudchat',
          },
          isRepoMode: true,
          changes: {},
          repoFileCache: { 'src/App.tsx': 'export default function App() {}' },
          repoFileTree: ['src/App.tsx', 'src/components/chat/ChatArea.tsx'],
          selectedRepoFilePath: null,
          repoFileTreeStatus: 'ready',
          repoFileTreeError: null,
        },
      },
    });

    render(<AppLayout />);

    expect(screen.getByText('Default permissions')).toBeInTheDocument();
    expect(screen.getByText('Repo attached')).toBeInTheDocument();
    expect(screen.queryByText('Editing')).not.toBeInTheDocument();
    expect(screen.getByText('octo/cloudchat')).toBeInTheDocument();
    expect(screen.getByText('2 indexed · 1 cached')).toBeInTheDocument();
  });
});

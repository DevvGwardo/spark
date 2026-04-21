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

vi.mock('@/components/terminal/TerminalPanel', () => ({
  TerminalPanel: () => null,
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
      sidebarWidth: 320,
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
      loadConversations: async () => {},
    });

    usePanelStore.setState({
      panels: [{ id: 'default', conversationId: null, profile: 'default' }],
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
            permissions: { pull: true, push: true },
          },
          isRepoMode: true,
          pullRequest: null,
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

    expect(screen.getByText('Can push')).toBeInTheDocument();
    // Repo attachment status is now shown in sidebar footer, not title bar
    expect(screen.queryByText('Repo attached')).not.toBeInTheDocument();
  });

  it('keeps a created pull request visible in the thread chrome after staged changes are cleared', () => {
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
          pullRequest: {
            number: 42,
            url: 'https://github.com/octo/cloudchat/pull/42',
            title: 'feat: persist pr state',
            body: '',
            state: 'open',
            draft: false,
            headBranch: 'ai/chat-changes-42',
            baseBranch: 'main',
          },
          changes: {},
          repoFileCache: {},
          repoFileTree: [],
          selectedRepoFilePath: null,
          repoFileTreeStatus: 'idle',
          repoFileTreeError: null,
        },
      },
    });

    render(<AppLayout />);

    expect(screen.getByRole('button', { name: /pr #42/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^commit$/i })).not.toBeInTheDocument();
  });
});

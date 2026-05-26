
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatArea } from '@/components/chat/ChatArea';
import { PanelProvider } from '@/contexts/PanelContext';
import { useChangesetStore } from '@/stores/changeset-store';
import { useUIStore } from '@/stores/ui-store';

vi.mock('@/components/chat/MessageBubble', () => ({
  MessageBubble: ({ message }: { message: { content: string } }) => <div>{message.content}</div>,
}));

vi.mock('@/components/chat/ChatInput', () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}));

vi.mock('@/components/chat/ActivityIndicator', () => ({
  ActivityIndicator: () => <div data-testid="activity-indicator" />,
}));

vi.mock('@/components/chat/WelcomeScreen', () => ({
  WelcomeScreen: () => <div data-testid="welcome-screen" />,
}));

vi.mock('@/components/chat/ApiKeyModal', () => ({
  ApiKeyModal: () => null,
}));

vi.mock('@/components/chat/ChangeApprovalModal', () => ({
  ChangeApprovalModal: () => null,
}));

vi.mock('@/components/chat/ChatErrorBanner', () => ({
  ChatErrorBanner: () => null,
}));

vi.mock('@/lib/providers', () => ({
  getProviderLabel: (provider: string) => provider,
}));

vi.mock('@/lib/proposed-changes', () => ({
  getProposalDigest: () => '',
  findPendingProposal: () => null,
  hasRepoContinuationAfterProposal: () => false,
}));

vi.mock('@/lib/tokens', () => ({
  getContextUsage: () => ({ used: 0, total: 1, percentage: 0 }),
}));

function renderExplainedIssueChat() {
  return render(
    <PanelProvider value="panel-1">
      <ChatArea
        conversationId="conv-1"
        messages={[
          {
            id: 'user-1',
            role: 'user',
            content: [
              'Explain GitHub issue #45471 in openclaw/openclaw.',
              'Issue title: Chat input hidden behind warning overlay',
              'The user wants an explanation only, not a fix or implementation plan.',
            ].join('\n'),
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'The overlay warning is positioned above the composer because the container creates a new stacking context.',
          },
        ]}
        input=""
        setInput={() => {}}
        handleSend={() => {}}
        handleStop={() => {}}
        handleRegenerate={() => {}}
        isStreaming={false}
        error={null}
        apiKeyModalOpen={false}
        setApiKeyModalOpen={() => {}}
        activeProvider="openai"
        activeModel="gpt-5.2"
      />
    </PanelProvider>,
  );
}

describe('ChatArea issue fix CTA', () => {
  beforeEach(() => {
    useChangesetStore.setState({ panelChangesets: {} });
    useUIStore.setState({
      sidebarOpen: false,
      sidebarWidth: 320,
      settingsOpen: false,
      setupWizardOpen: false,
      repoBrowserOpen: false,
      activeTab: 'chat',
      pendingPanelPrompts: {},
    });
  });

  it('shows update and fix CTAs after an explain-only issue response', () => {
    useChangesetStore.getState().switchActiveRepo('panel-1', {
      owner: 'devgwardo',
      name: 'openclaw',
      defaultBranch: 'main',
      fullName: 'devgwardo/openclaw',
      baseFullName: 'openclaw/openclaw',
      issue: {
        number: 45471,
        title: 'Chat input hidden behind warning overlay',
        body: 'After an update, the chat tab shows a warning triangle over the composer.',
        url: 'https://github.com/openclaw/openclaw/issues/45471',
        state: 'open',
        labels: ['bug'],
        updatedAt: '2026-03-12T00:00:00Z',
      },
    });
    useChangesetStore.getState().setRepoFileTree('panel-1', ['src/components/chat/ChatArea.tsx']);

    renderExplainedIssueChat();

    expect(screen.getByRole('button', { name: 'Draft issue update' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fix issue in chat' })).toBeInTheDocument();
  });

  it('queues a read-only issue-update follow-up from the explain CTA', () => {
    useChangesetStore.getState().switchActiveRepo('panel-1', {
      owner: 'devgwardo',
      name: 'openclaw',
      defaultBranch: 'main',
      fullName: 'devgwardo/openclaw',
      baseFullName: 'openclaw/openclaw',
      issue: {
        number: 45471,
        title: 'Chat input hidden behind warning overlay',
        body: 'After an update, the chat tab shows a warning triangle over the composer.',
        url: 'https://github.com/openclaw/openclaw/issues/45471',
        state: 'open',
        labels: ['bug'],
        updatedAt: '2026-03-12T00:00:00Z',
      },
    });
    useChangesetStore.getState().setRepoFileTree('panel-1', ['src/components/chat/ChatArea.tsx']);

    renderExplainedIssueChat();

    fireEvent.click(screen.getByRole('button', { name: 'Draft issue update' }));

    expect(useUIStore.getState().pendingPanelPrompts['panel-1']).toMatchObject({
      autoSend: true,
      repoEditIntentOverride: false,
    });
    expect(useUIStore.getState().pendingPanelPrompts['panel-1']?.content).toContain(
      'draft an update for the GitHub issue',
    );
  });

  it('queues an editable follow-up when fixing from the explain CTA', () => {
    useChangesetStore.getState().switchActiveRepo('panel-1', {
      owner: 'devgwardo',
      name: 'openclaw',
      defaultBranch: 'main',
      fullName: 'devgwardo/openclaw',
      baseFullName: 'openclaw/openclaw',
      issue: {
        number: 45471,
        title: 'Chat input hidden behind warning overlay',
        body: 'After an update, the chat tab shows a warning triangle over the composer.',
        url: 'https://github.com/openclaw/openclaw/issues/45471',
        state: 'open',
        labels: ['bug'],
        updatedAt: '2026-03-12T00:00:00Z',
      },
    });
    useChangesetStore.getState().setRepoFileTree('panel-1', ['src/components/chat/ChatArea.tsx']);

    renderExplainedIssueChat();

    fireEvent.click(screen.getByRole('button', { name: 'Fix issue in chat' }));

    expect(useUIStore.getState().pendingPanelPrompts['panel-1']).toMatchObject({
      autoSend: true,
      repoEditIntentOverride: true,
    });
    expect(useUIStore.getState().pendingPanelPrompts['panel-1']?.content).toContain(
      'Continue from your explanation of GitHub issue #45471 in openclaw/openclaw.',
    );
  });

  it('does not show the CTA for non-explain repo turns', () => {
    useChangesetStore.getState().switchActiveRepo('panel-1', {
      owner: 'devgwardo',
      name: 'openclaw',
      defaultBranch: 'main',
      fullName: 'devgwardo/openclaw',
      issue: {
        number: 45471,
        title: 'Chat input hidden behind warning overlay',
        body: 'After an update, the chat tab shows a warning triangle over the composer.',
        url: 'https://github.com/openclaw/openclaw/issues/45471',
        state: 'open',
        labels: ['bug'],
        updatedAt: '2026-03-12T00:00:00Z',
      },
    });
    useChangesetStore.getState().setRepoFileTree('panel-1', ['src/components/chat/ChatArea.tsx']);

    render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={[
            {
              id: 'user-1',
              role: 'user',
              content: 'What does this repository do?',
            },
            {
              id: 'assistant-1',
              role: 'assistant',
              content: 'It is a chat application with repo-aware workflows.',
            },
          ]}
          input=""
          setInput={() => {}}
          handleSend={() => {}}
          handleStop={() => {}}
          handleRegenerate={() => {}}
          isStreaming={false}
          error={null}
          apiKeyModalOpen={false}
          setApiKeyModalOpen={() => {}}
          activeProvider="openai"
          activeModel="gpt-5.2"
        />
      </PanelProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Fix issue in chat' })).not.toBeInTheDocument();
  });
});


import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatArea } from '@/components/chat/ChatArea';
import { PanelProvider } from '@/contexts/PanelContext';
import { useChangesetStore } from '@/stores/changeset-store';

vi.mock('@/components/chat/MessageBubble', () => ({
  MessageBubble: ({ message }: { message: { content: string } }) => <div>{message.content}</div>,
}));

vi.mock('@/components/chat/ChatInput', () => ({
  ChatInput: ({ disabled, disabledPlaceholder }: { disabled?: boolean; disabledPlaceholder?: string }) => (
    <div
      data-testid="chat-input"
      data-disabled={disabled ? 'true' : 'false'}
      data-placeholder={disabledPlaceholder || ''}
    />
  ),
}));

vi.mock('@/components/chat/ActivityIndicator', () => ({
  ActivityIndicator: () => <div data-testid="activity-indicator" />,
}));

vi.mock('@/components/chat/WelcomeScreen', () => ({
  WelcomeScreen: ({ disableRepoActions }: { disableRepoActions?: boolean }) => (
    <div data-testid="welcome-screen" data-disabled={disableRepoActions ? 'true' : 'false'} />
  ),
}));

vi.mock('@/components/chat/ApiKeyModal', () => ({
  ApiKeyModal: () => null,
}));

vi.mock('@/components/chat/ChangeApprovalModal', () => ({
  ChangeApprovalModal: () => null,
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

describe('ChatArea repo input lock', () => {
  beforeEach(() => {
    useChangesetStore.setState({ panelChangesets: {} });
  });

  it('disables the composer and welcome actions while the selected repo tree is loading', () => {
    useChangesetStore.getState().switchActiveRepo('panel-1', {
      owner: 'octo',
      name: 'repo',
      defaultBranch: 'main',
      fullName: 'octo/repo',
    });
    useChangesetStore.getState().setRepoFileTreeStatus('panel-1', 'loading');

    render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId={null}
          messages={[]}
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

    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-placeholder', 'Loading octo/repo files...');
    expect(screen.getByTestId('welcome-screen')).toHaveAttribute('data-disabled', 'true');
  });

  it('leaves the composer enabled once the repo tree is ready', () => {
    useChangesetStore.getState().switchActiveRepo('panel-1', {
      owner: 'octo',
      name: 'repo',
      defaultBranch: 'main',
      fullName: 'octo/repo',
    });
    useChangesetStore.getState().setRepoFileTree('panel-1', ['src/app.ts']);

    render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId={null}
          messages={[]}
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

    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-disabled', 'false');
    expect(screen.getByTestId('welcome-screen')).toHaveAttribute('data-disabled', 'false');
  });
});

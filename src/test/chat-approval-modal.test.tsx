
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatArea } from '@/components/chat/ChatArea';
import { PanelProvider } from '@/contexts/PanelContext';
import { useSettingsStore } from '@/stores/settings-store';

const { changeApprovalModalSpy } = vi.hoisted(() => ({
  changeApprovalModalSpy: vi.fn(({ proposal }: { proposal: { summary?: string | null; excerpt?: string | null } }) => (
    <div data-testid="change-approval-modal">
      {proposal.summary || proposal.excerpt || 'pending proposal'}
    </div>
  )),
}));

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
  ChangeApprovalModal: changeApprovalModalSpy,
}));

vi.mock('@/lib/providers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/providers')>('@/lib/providers');
  return {
    ...actual,
    getProviderLabel: (provider: string) => provider,
  };
});

vi.mock('@/lib/tokens', () => ({
  getContextUsage: () => ({ used: 0, total: 1, percentage: 0 }),
}));

const baseSettingsState = useSettingsStore.getState();

describe('ChatArea approval modal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.electronAPI = undefined;
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      autoApproveRepoChanges: false,
    });
  });

  afterEach(() => {
    window.electronAPI = undefined;
    useSettingsStore.setState(baseSettingsState, true);
  });

  it('renders the approval modal when Hermes mutates the latest proposal message in place', () => {
    const messages: Array<{ id: string; role: string; content: string; toolInvocations?: Array<{ toolName: string; state?: string; args?: Record<string, unknown> }> }> = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: "To update the UI, I'll need to examine the current state of the repository.",
      },
    ];

    const { rerender } = render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={messages}
          input=""
          setInput={() => {}}
          handleSend={() => {}}
          handleQuickSend={() => {}}
          handleStop={() => {}}
          handleRegenerate={() => {}}
          isStreaming={false}
          error={null}
          apiKeyModalOpen={false}
          setApiKeyModalOpen={() => {}}
          activeProvider="hermes"
          activeModel="meta-llama/llama-4-maverick"
        />
      </PanelProvider>,
    );

    expect(screen.queryByTestId('change-approval-modal')).not.toBeInTheDocument();

    messages[0].content = `To update the UI, I'll need to examine the current state of the repository and identify the relevant files.

Here's a proposed plan to update the UI.`;
    messages[0].toolInvocations = [
      {
        toolName: 'propose_changes',
        state: 'result',
        args: {},
      },
    ];

    rerender(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={messages}
          input=""
          setInput={() => {}}
          handleSend={() => {}}
          handleQuickSend={() => {}}
          handleStop={() => {}}
          handleRegenerate={() => {}}
          isStreaming={false}
          error={null}
          apiKeyModalOpen={false}
          setApiKeyModalOpen={() => {}}
          activeProvider="hermes"
          activeModel="meta-llama/llama-4-maverick"
        />
      </PanelProvider>,
    );

    expect(screen.getByTestId('change-approval-modal')).toBeInTheDocument();
    expect(changeApprovalModalSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        proposal: expect.objectContaining({
          messageId: 'assistant-1',
        }),
      }),
      expect.anything(),
    );
  });

  it('still renders the approval modal when auto-approve is enabled but Hermes stalls on the proposal', async () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      autoApproveRepoChanges: true,
    });

    await act(async () => {
      render(
        <PanelProvider value="panel-1">
          <ChatArea
            conversationId="conv-1"
            messages={[
              {
                id: 'assistant-1',
                role: 'assistant',
                content: '',
                parts: [
                  {
                    type: 'text',
                    text: `Let's assume you're looking for a general UI update.

Here's a proposal to update the UI.`,
                  },
                  {
                    type: 'tool-invocation',
                    toolInvocation: {
                      toolName: 'propose_changes',
                      state: 'result',
                      args: {},
                    },
                  },
                ],
              },
            ]}
            input=""
            setInput={() => {}}
            handleSend={() => {}}
            handleQuickSend={() => {}}
            handleStop={() => {}}
            handleRegenerate={() => {}}
            isStreaming={false}
            error={null}
            apiKeyModalOpen={false}
            setApiKeyModalOpen={() => {}}
            activeProvider="hermes"
            activeModel="meta-llama/llama-4-maverick"
          />
        </PanelProvider>,
      );
    });

    expect(await screen.findByTestId('change-approval-modal')).toBeInTheDocument();
  });

  it('suppresses the approval modal when conversation-level Allow all is active', () => {
    render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={[
            {
              id: 'assistant-1',
              role: 'assistant',
              content: '## Proposed Changes\n\nRefresh the navigation shell.\n\nUse the accept button below to apply these changes.',
              toolInvocations: [
                {
                  toolName: 'propose_changes',
                  state: 'result',
                  args: {
                    summary: 'Refresh the navigation shell',
                    plan: [
                      {
                        path: 'src/App.tsx',
                        action: 'edit',
                        description: 'Update the layout shell',
                      },
                    ],
                  },
                },
              ],
            },
          ]}
          input=""
          setInput={() => {}}
          handleSend={() => {}}
          handleQuickSend={() => {}}
          handleStop={() => {}}
          handleRegenerate={() => {}}
          isStreaming={false}
          error={null}
          apiKeyModalOpen={false}
          setApiKeyModalOpen={() => {}}
          activeProvider="hermes"
          activeModel="meta-llama/llama-4-maverick"
          conversationAutoApproveEnabled
        />
      </PanelProvider>,
    );

    expect(screen.queryByTestId('change-approval-modal')).not.toBeInTheDocument();
  });

  it('notifies Electron once when a new approval is waiting', () => {
    const notifyAttentionRequest = vi.fn().mockResolvedValue(undefined);
    const clearAttentionRequest = vi.fn().mockResolvedValue(undefined);
    window.electronAPI = {
      apiPort: 3555,
      platform: 'darwin',
      homeDir: '/tmp',
      versions: {
        electron: '1',
        node: '1',
        chrome: '1',
      },
      notifyAttentionRequest,
      clearAttentionRequest,
    };

    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: "Here's a proposed plan to update the UI.",
        toolInvocations: [
          {
            toolName: 'propose_changes',
            state: 'result',
            args: {
              summary: 'Update the repository UI shell',
            },
          },
        ],
      },
    ];

    const { rerender } = render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={messages}
          input=""
          setInput={() => {}}
          handleSend={() => {}}
          handleQuickSend={() => {}}
          handleStop={() => {}}
          handleRegenerate={() => {}}
          isStreaming={false}
          error={null}
          apiKeyModalOpen={false}
          setApiKeyModalOpen={() => {}}
          activeProvider="hermes"
          activeModel="meta-llama/llama-4-maverick"
        />
      </PanelProvider>,
    );

    expect(notifyAttentionRequest).toHaveBeenCalledTimes(1);
    expect(notifyAttentionRequest).toHaveBeenCalledWith({
      title: 'CloudChat approval needed',
      body: 'Update the repository UI shell',
    });

    rerender(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={messages}
          input=""
          setInput={() => {}}
          handleSend={() => {}}
          handleQuickSend={() => {}}
          handleStop={() => {}}
          handleRegenerate={() => {}}
          isStreaming={false}
          error={null}
          apiKeyModalOpen={false}
          setApiKeyModalOpen={() => {}}
          activeProvider="hermes"
          activeModel="meta-llama/llama-4-maverick"
        />
      </PanelProvider>,
    );

    expect(notifyAttentionRequest).toHaveBeenCalledTimes(1);
  });

  it('clears Electron attention when the approval is no longer pending', () => {
    const notifyAttentionRequest = vi.fn().mockResolvedValue(undefined);
    const clearAttentionRequest = vi.fn().mockResolvedValue(undefined);
    window.electronAPI = {
      apiPort: 3555,
      platform: 'darwin',
      homeDir: '/tmp',
      versions: {
        electron: '1',
        node: '1',
        chrome: '1',
      },
      notifyAttentionRequest,
      clearAttentionRequest,
    };

    const { rerender } = render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={[
            {
              id: 'assistant-1',
              role: 'assistant',
              content: "Here's a proposed plan to update the UI.",
              toolInvocations: [
                {
                  toolName: 'propose_changes',
                  state: 'result',
                  args: {},
                },
              ],
            },
          ]}
          input=""
          setInput={() => {}}
          handleSend={() => {}}
          handleQuickSend={() => {}}
          handleStop={() => {}}
          handleRegenerate={() => {}}
          isStreaming={false}
          error={null}
          apiKeyModalOpen={false}
          setApiKeyModalOpen={() => {}}
          activeProvider="hermes"
          activeModel="meta-llama/llama-4-maverick"
        />
      </PanelProvider>,
    );

    clearAttentionRequest.mockClear();

    rerender(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={[
            {
              id: 'assistant-1',
              role: 'assistant',
              content: "Here's a proposed plan to update the UI.",
              toolInvocations: [
                {
                  toolName: 'propose_changes',
                  state: 'result',
                  args: {},
                },
                {
                  toolName: 'read_repo_file',
                  state: 'result',
                  args: { path: 'src/App.tsx' },
                },
              ],
            },
          ]}
          input=""
          setInput={() => {}}
          handleSend={() => {}}
          handleQuickSend={() => {}}
          handleStop={() => {}}
          handleRegenerate={() => {}}
          isStreaming={false}
          error={null}
          apiKeyModalOpen={false}
          setApiKeyModalOpen={() => {}}
          activeProvider="hermes"
          activeModel="meta-llama/llama-4-maverick"
        />
      </PanelProvider>,
    );

    expect(clearAttentionRequest).toHaveBeenCalledTimes(1);
  });

  it('does not render the approval modal after an auto-approved proposal continues into repo tools', async () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      autoApproveRepoChanges: true,
    });

    await act(async () => {
      render(
        <PanelProvider value="panel-1">
          <ChatArea
            conversationId="conv-1"
            messages={[
              {
                id: 'assistant-1',
                role: 'assistant',
                content: '',
                toolInvocations: [
                  {
                    toolName: 'propose_changes',
                    state: 'result',
                    args: {},
                  },
                  {
                    toolName: 'read_repo_file',
                    state: 'result',
                    args: { path: 'src/App.tsx' },
                  },
                ],
              },
            ]}
            input=""
            setInput={() => {}}
            handleSend={() => {}}
            handleQuickSend={() => {}}
            handleStop={() => {}}
            handleRegenerate={() => {}}
            isStreaming={false}
            error={null}
            apiKeyModalOpen={false}
            setApiKeyModalOpen={() => {}}
            activeProvider="hermes"
            activeModel="meta-llama/llama-4-maverick"
          />
        </PanelProvider>,
      );
    });

    await waitFor(() => {
      expect(screen.queryByTestId('change-approval-modal')).not.toBeInTheDocument();
    });
  });

  it('does not render the approval modal when proposal transcript exists but no conversation is selected', () => {
    render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId={null}
          messages={[
            {
              id: 'assistant-1',
              role: 'assistant',
              content: '## Proposed Changes\n\nRefresh the navigation shell.\n\nUse the accept button below to apply these changes.',
              toolInvocations: [
                {
                  toolName: 'propose_changes',
                  state: 'result',
                  args: {
                    summary: 'Refresh the navigation shell',
                    plan: [
                      {
                        path: 'src/App.tsx',
                        action: 'edit',
                        description: 'Update the layout shell',
                      },
                    ],
                  },
                },
              ],
            },
          ]}
          input=""
          setInput={() => {}}
          handleSend={() => {}}
          handleQuickSend={() => {}}
          handleStop={() => {}}
          handleRegenerate={() => {}}
          isStreaming={false}
          error={null}
          apiKeyModalOpen={false}
          setApiKeyModalOpen={() => {}}
          activeProvider="hermes"
          activeModel="meta-llama/llama-4-maverick"
        />
      </PanelProvider>,
    );

    expect(screen.queryByTestId('change-approval-modal')).not.toBeInTheDocument();
  });
});

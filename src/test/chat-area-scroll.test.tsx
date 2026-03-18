import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatArea } from '@/components/chat/ChatArea';
import { PanelProvider } from '@/contexts/PanelContext';

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
  ChangeApprovalModal: ({ open }: { open: boolean }) => (
    open ? <div data-testid="change-approval-banner">Approval required</div> : null
  ),
}));

vi.mock('@/lib/providers', () => ({
  getProviderLabel: (provider: string) => provider,
}));

vi.mock('@/lib/proposed-changes', () => ({
  getProposalDigest: (messages: Array<{ id: string; toolInvocations?: Array<{ toolName?: string }> }>) =>
    JSON.stringify(messages.map((message) => ({
      id: message.id,
      toolNames: message.toolInvocations?.map((tool) => tool.toolName) ?? [],
    }))),
  findPendingProposal: (
    messages: Array<{ id: string; toolInvocations?: Array<{ toolName?: string }> }>,
  ) => {
    const proposalMessage = [...messages]
      .reverse()
      .find((message) => message.toolInvocations?.some((tool) => tool.toolName === 'propose_changes'));

    if (!proposalMessage) return null;

    return {
      messageId: proposalMessage.id,
      summary: 'Refresh the approval banner layout',
      excerpt: 'Keep the approval request in the transcript flow.',
      plan: [
        {
          path: 'src/components/chat/ChatArea.tsx',
          action: 'edit',
          description: 'Adjust transcript auto-scroll behavior.',
        },
      ],
    };
  },
  hasRepoContinuationAfterProposal: () => false,
}));

vi.mock('@/lib/tokens', () => ({
  getContextUsage: () => ({ used: 0, total: 1, percentage: 0 }),
}));

describe('ChatArea auto-scroll', () => {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;

  beforeEach(() => {
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = (() => undefined) as typeof window.cancelAnimationFrame;
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it('keeps auto-scroll working when the last message mutates in place during streaming', async () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello',
      },
    ];

    const { container, rerender } = render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={messages}
          input=""
          setInput={() => {}}
          handleSend={() => {}}
          handleStop={() => {}}
          handleRegenerate={() => {}}
          isStreaming
          error={null}
          apiKeyModalOpen={false}
          setApiKeyModalOpen={() => {}}
          activeProvider="hermes"
          activeModel="meta-llama/llama-4-maverick"
        />
      </PanelProvider>,
    );

    const scrollEl = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    expect(scrollEl).toBeTruthy();

    Object.defineProperty(scrollEl, 'scrollHeight', {
      configurable: true,
      get: () => 480,
    });
    Object.defineProperty(scrollEl, 'clientHeight', {
      configurable: true,
      get: () => 120,
    });

    scrollEl.scrollTop = 0;

    act(() => {
      messages[0].content = 'hello from Hermes streaming';
      rerender(
        <PanelProvider value="panel-1">
          <ChatArea
            conversationId="conv-1"
            messages={messages}
            input=""
            setInput={() => {}}
            handleSend={() => {}}
            handleStop={() => {}}
            handleRegenerate={() => {}}
            isStreaming
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
      expect(scrollEl.scrollTop).toBe(480);
    });
  });

  it('does not force-scroll after the user scrolls away from the bottom', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello',
      },
    ];

    const { container, rerender } = render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={messages}
          input=""
          setInput={() => {}}
          handleSend={() => {}}
          handleStop={() => {}}
          handleRegenerate={() => {}}
          isStreaming
          error={null}
          apiKeyModalOpen={false}
          setApiKeyModalOpen={() => {}}
          activeProvider="hermes"
          activeModel="meta-llama/llama-4-maverick"
        />
      </PanelProvider>,
    );

    const scrollEl = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    expect(scrollEl).toBeTruthy();

    Object.defineProperty(scrollEl, 'scrollHeight', {
      configurable: true,
      get: () => 480,
    });
    Object.defineProperty(scrollEl, 'clientHeight', {
      configurable: true,
      get: () => 120,
    });

    scrollEl.scrollTop = 0;
    fireEvent.scroll(scrollEl);

    act(() => {
      messages[0].content = 'hello from Hermes streaming';
      rerender(
        <PanelProvider value="panel-1">
          <ChatArea
            conversationId="conv-1"
            messages={messages}
            input=""
            setInput={() => {}}
            handleSend={() => {}}
            handleStop={() => {}}
            handleRegenerate={() => {}}
            isStreaming
            error={null}
            apiKeyModalOpen={false}
            setApiKeyModalOpen={() => {}}
            activeProvider="hermes"
            activeModel="meta-llama/llama-4-maverick"
          />
        </PanelProvider>,
      );
    });

    expect(scrollEl.scrollTop).toBe(0);
  });

  it('stops auto-scroll immediately when the user wheels upward during streaming', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello',
      },
    ];

    const { container, rerender } = render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={messages}
          input=""
          setInput={() => {}}
          handleSend={() => {}}
          handleStop={() => {}}
          handleRegenerate={() => {}}
          isStreaming
          error={null}
          apiKeyModalOpen={false}
          setApiKeyModalOpen={() => {}}
          activeProvider="hermes"
          activeModel="meta-llama/llama-4-maverick"
        />
      </PanelProvider>,
    );

    const scrollEl = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    expect(scrollEl).toBeTruthy();

    Object.defineProperty(scrollEl, 'scrollHeight', {
      configurable: true,
      get: () => 480,
    });
    Object.defineProperty(scrollEl, 'clientHeight', {
      configurable: true,
      get: () => 120,
    });

    scrollEl.scrollTop = 320;
    fireEvent.wheel(scrollEl, { deltaY: -40 });

    act(() => {
      messages[0].content = 'hello from Hermes streaming';
      rerender(
        <PanelProvider value="panel-1">
          <ChatArea
            conversationId="conv-1"
            messages={messages}
            input=""
            setInput={() => {}}
            handleSend={() => {}}
            handleStop={() => {}}
            handleRegenerate={() => {}}
            isStreaming
            error={null}
            apiKeyModalOpen={false}
            setApiKeyModalOpen={() => {}}
            activeProvider="hermes"
            activeModel="meta-llama/llama-4-maverick"
          />
        </PanelProvider>,
      );
    });

    expect(scrollEl.scrollTop).toBe(320);
  });

  it('auto-scrolls when the approval banner opens inside the transcript', async () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Starting analysis',
      },
    ];

    const { container, rerender } = render(
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

    const scrollEl = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    expect(scrollEl).toBeTruthy();

    Object.defineProperty(scrollEl, 'scrollHeight', {
      configurable: true,
      get: () => screen.queryByTestId('change-approval-banner') ? 560 : 480,
    });
    Object.defineProperty(scrollEl, 'clientHeight', {
      configurable: true,
      get: () => 120,
    });

    scrollEl.scrollTop = 0;

    act(() => {
      messages[0].content = 'I have a proposed plan.';
      messages[0].toolInvocations = [
        {
          toolName: 'propose_changes',
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
    });

    await waitFor(() => {
      expect(screen.getByTestId('change-approval-banner')).toBeInTheDocument();
      expect(scrollEl.scrollTop).toBe(560);
    });
  });

  it('waits until streaming stops before showing the approval banner', async () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'I have a proposed plan.',
        toolInvocations: [
          {
            toolName: 'propose_changes',
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
          isStreaming
          error={null}
          apiKeyModalOpen={false}
          setApiKeyModalOpen={() => {}}
          activeProvider="hermes"
          activeModel="meta-llama/llama-4-maverick"
        />
      </PanelProvider>,
    );

    expect(screen.queryByTestId('change-approval-banner')).not.toBeInTheDocument();

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

    expect(await screen.findByTestId('change-approval-banner')).toBeInTheDocument();
  });
});

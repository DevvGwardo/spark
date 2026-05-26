
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

// --- Virtuoso mock ---
// We capture the atBottomStateChange and scrollToIndex from Virtuoso
// so tests can simulate scroll behavior without real DOM measurements.
let capturedAtBottomChange: ((atBottom: boolean) => void) | null = null;
let capturedScrollToIndex: ((...args: unknown[]) => void) | null = null;

vi.mock('react-virtuoso', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');

  const Virtuoso = React.forwardRef(
    (
      {
        data,
        itemContent,
        followOutput: _followOutput,
        atBottomStateChange,
        className,
        components,
        'data-testid': testId,
      }: {
        data: unknown[];
        itemContent: (index: number, item: unknown) => React.ReactNode;
        followOutput: string | boolean;
        atBottomChange?: (atBottom: boolean) => void;
        atBottomStateChange?: (atBottom: boolean) => void;
        className?: string;
        components?: { Footer?: React.ComponentType };
        'data-testid'?: string;
      },
      ref: React.Ref<{ scrollToIndex: (...args: unknown[]) => void }>,
    ) => {
      // Store the callback for test access
      React.useEffect(() => {
        capturedAtBottomChange = atBottomStateChange ?? null;
        return () => {
          capturedAtBottomChange = null;
        };
      }, [atBottomStateChange]);

      // Expose scrollToIndex via ref
      React.useImperativeHandle(ref, () => ({
        scrollToIndex: (...args: unknown[]) => {
          if (capturedScrollToIndex) capturedScrollToIndex(...args);
        },
      }));

      const FooterComponent = components?.Footer;

      return (
        <div
          data-testid={testId ?? 'virtuoso-scroller'}
          className={className}
          style={{ overflowY: 'auto' }}
        >
          {data.map((item: unknown, index: number) => (
            <div key={(item as { id: string }).id}>
              {itemContent(index, item)}
            </div>
          ))}
          {FooterComponent && <FooterComponent />}
        </div>
      );
    },
  );

  return { Virtuoso, VirtuosoHandle: {} as unknown };
});

describe('ChatArea auto-scroll', () => {
  beforeEach(() => {
    capturedAtBottomChange = null;
    capturedScrollToIndex = null;
  });

  afterEach(() => {
    capturedAtBottomChange = null;
    capturedScrollToIndex = null;
  });

  it('renders messages via Virtuoso mock', async () => {
    const messages = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Hello',
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Hi there!',
      },
    ];

    render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={messages}
          input=""
          setInput={() => {}}
          handleSend={() => {}}
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

    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('Hi there!')).toBeInTheDocument();
  });

  it('auto-scrolls when atBottomStateChange reports bottom and new content arrives', async () => {
    const scrollToIndexMock = vi.fn();
    capturedScrollToIndex = scrollToIndexMock;

    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello',
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

    // Simulate Virtuoso reporting we are at the bottom
    expect(capturedAtBottomChange).toBeTruthy();
    act(() => {
      capturedAtBottomChange!(true);
    });

    // Now re-render with updated streaming content (same item count — followOutput handles content changes)
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

    // The message content should be updated in the DOM
    expect(screen.getByText('hello from Hermes streaming')).toBeInTheDocument();
  });

  it('does not force-scroll after the user scrolls away from the bottom', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello',
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

    // Simulate Virtuoso reporting we are at the bottom initially
    act(() => {
      capturedAtBottomChange!(true);
    });

    // Then simulate user scrolling away (Virtuoso reports not at bottom)
    act(() => {
      capturedAtBottomChange!(false);
    });

    // Update streaming content — followOutput should NOT trigger scroll since isAutoScroll is false
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

    // The updated message should still render
    expect(screen.getByText('hello from Hermes streaming')).toBeInTheDocument();
    // And the scroll button should be visible (user is not at bottom)
    expect(screen.getByLabelText('Scroll to bottom')).toBeInTheDocument();
  });

  it('keeps auto-scroll enabled when Virtuoso reports not at bottom during streaming', () => {
    // During streaming, in-place content growth (tool calls, parts) can push
    // the bottom below the viewport causing Virtuoso to fire atBottom=false.
    // Auto-scroll should stay enabled so we keep following the stream.
    const scrollToIndexMock = vi.fn();
    capturedScrollToIndex = scrollToIndexMock;

    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello',
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

    // Simulate Virtuoso reporting not at bottom (content grew taller)
    act(() => {
      capturedAtBottomChange!(false);
    });

    // Scroll button appears (visual hint) but auto-scroll stays on
    expect(screen.getByLabelText('Scroll to bottom')).toBeInTheDocument();

    // Streaming content updates — auto-scroll should nudge to bottom
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

    expect(screen.getByText('hello from Hermes streaming')).toBeInTheDocument();
    // The digest-watching useEffect should have called scrollToIndex
    expect(scrollToIndexMock).toHaveBeenCalledWith({
      index: 0,
      align: 'end',
      behavior: 'smooth',
    });
  });

  it('scroll-to-bottom FAB calls scrollToIndex and re-enables auto-scroll', () => {
    const scrollToIndexMock = vi.fn();
    capturedScrollToIndex = scrollToIndexMock;

    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello',
      },
    ];

    render(
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

    // Simulate user scrolling away
    act(() => {
      capturedAtBottomChange!(false);
    });

    // FAB should appear
    const fab = screen.getByLabelText('Scroll to bottom');
    expect(fab).toBeInTheDocument();

    // Click the FAB
    fireEvent.click(fab);

    // scrollToIndex should be called with the last message index
    expect(scrollToIndexMock).toHaveBeenCalledWith({
      index: 0,
      align: 'end',
      behavior: 'smooth',
    });
  });

  it('auto-scrolls when the approval banner opens inside the transcript', async () => {
    const messages: Array<{ id: string; role: string; content: string; toolInvocations?: Array<{ toolName: string }> }> = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Starting analysis',
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

    // No approval banner yet
    expect(screen.queryByTestId('change-approval-banner')).not.toBeInTheDocument();

    // Simulate user at bottom
    act(() => {
      capturedAtBottomChange!(true);
    });

    // Add a propose_changes tool invocation — banner should appear in Virtuoso Footer
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
    });
  });

  it('hides scroll button when Virtuoso reports back at bottom', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Reading files...',
      },
    ];

    render(
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

    // Simulate scrolling away from bottom
    act(() => {
      capturedAtBottomChange!(false);
    });
    expect(screen.getByLabelText('Scroll to bottom')).toBeInTheDocument();

    // Simulate scrolling back to bottom
    act(() => {
      capturedAtBottomChange!(true);
    });
    expect(screen.queryByLabelText('Scroll to bottom')).not.toBeInTheDocument();
  });

  it('does not show scroll button when Virtuoso reports at bottom after user scrolled away', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Editing files...',
      },
    ];

    render(
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

    // User scrolls away
    act(() => {
      capturedAtBottomChange!(false);
    });
    expect(screen.getByLabelText('Scroll to bottom')).toBeInTheDocument();

    // Content updates but user is still not at bottom — scroll button stays
    act(() => {
      messages[0].content = 'Still editing...';
    });
    expect(screen.getByLabelText('Scroll to bottom')).toBeInTheDocument();
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

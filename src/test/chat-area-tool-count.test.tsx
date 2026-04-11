import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatArea } from '@/components/chat/ChatArea';
import { PanelProvider } from '@/contexts/PanelContext';

vi.mock('@/components/chat/MessageBubble', () => ({
  MessageBubble: ({ message }: { message: { content: string } }) => <div>{message.content}</div>,
}));

vi.mock('@/components/chat/ChatInput', () => ({
  ChatInput: ({ toolCallCount, agentStatusLabel }: { toolCallCount?: number; agentStatusLabel?: string }) => (
    <div
      data-testid="chat-input"
      data-tool-count={toolCallCount ?? 0}
      data-agent-status={agentStatusLabel ?? ''}
    />
  ),
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

describe('ChatArea streaming tool count', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('counts visible Hermes tool activity rows while the assistant is streaming', () => {
    render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={[
            {
              id: 'assistant-1',
              role: 'assistant',
              content: '\n\n> **Reading file** — `src/app.ts`\n\n',
            },
          ]}
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
          toolActivityMap={{
            current: [
              {
                tool: 'read_repo_file',
                status: 'running',
                input: '{"path":"src/app.ts"}',
                output: null,
              },
            ],
          }}
        />
      </PanelProvider>,
    );

    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-tool-count', '1');
  });

  it('counts live Hermes tool activity before the first assistant message exists', () => {
    render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={[]}
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
          toolActivityMap={{
            current: [
              {
                tool: 'read_repo_file',
                status: 'running',
                input: '{"path":"src/app.ts"}',
                output: null,
              },
              {
                tool: 'read_repo_file',
                status: 'completed',
                input: '{"path":"src/app.ts"}',
                output: 'export const app = true;',
              },
            ],
          }}
        />
      </PanelProvider>,
    );

    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-tool-count', '2');
  });

  it('prefers current Hermes tool activity over stale prior assistant messages', () => {
    render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={[
            {
              id: 'assistant-old',
              role: 'assistant',
              content: '',
              toolInvocations: [
                {
                  toolName: 'read_repo_file',
                  state: 'result',
                  args: { path: 'src/old.ts' },
                },
              ],
            },
            {
              id: 'user-new',
              role: 'user',
              content: 'inspect the current files',
            },
          ]}
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
          toolActivityMap={{
            current: [
              {
                tool: 'read_repo_file',
                status: 'running',
                input: '{"path":"src/app.ts"}',
                output: null,
              },
              {
                tool: 'read_repo_file',
                status: 'running',
                input: '{"path":"src/lib.ts"}',
                output: null,
              },
            ],
          }}
        />
      </PanelProvider>,
    );

    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-tool-count', '2');
  });

  it('counts synthesized repo tool rows from assistant text when Hermes skips structured tool events', () => {
    render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={[
            {
              id: 'user-edit',
              role: 'user',
              content: 'Update src/app.ts and apply the changes.',
            },
            {
              id: 'assistant-2',
              role: 'assistant',
              content: `Here are the updated files:

\`src/app.ts\`
\`\`\`ts
export const updated = true;
\`\`\``,
            },
          ]}
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
          toolActivityMap={{}}
        />
      </PanelProvider>,
    );

    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-tool-count', '1');
  });

  it('does not count synthesized repo write rows for read-only analysis turns', () => {
    render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={[
            {
              id: 'user-1',
              role: 'user',
              content: 'Analyze the codebase for bugs and suggest fixes.',
            },
            {
              id: 'assistant-2b',
              role: 'assistant',
              content: `Here is an example patch:

\`src/app.ts\`
\`\`\`ts
export const updated = true;
\`\`\``,
            },
          ]}
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
          toolActivityMap={{}}
        />
      </PanelProvider>,
    );

    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-tool-count', '0');
  });

  it('passes the current Hermes status label to the composer status bar', () => {
    render(
      <PanelProvider value="panel-1">
        <ChatArea
          conversationId="conv-1"
          messages={[]}
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
          toolActivityMap={{}}
          agentStatus={{ label: 'Analyzing repository context...', phase: 'thinking', iteration: 1 }}
        />
      </PanelProvider>,
    );

    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-agent-status', 'Analyzing repository context...');
  });
});

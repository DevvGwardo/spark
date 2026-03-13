import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { PanelProvider } from '@/contexts/PanelContext';
import { useChangesetStore } from '@/stores/changeset-store';

vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('@/components/chat/GhostIcon', () => ({
  GhostIcon: () => <div data-testid="ghost-icon" />,
}));

describe('MessageBubble', () => {
  beforeEach(() => {
    useChangesetStore.setState({ panelChangesets: {} });
  });

  it('deduplicates repeated tool states for the same repo read invocation', () => {
    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-1',
            conversationId: 'conv-1',
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
          }}
          parts={[
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'read-1',
                toolName: 'read_repo_file',
                args: { path: 'src/components/ChatInterface.jsx' },
                state: 'call',
              },
            },
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'read-1',
                toolName: 'read_repo_file',
                args: { path: 'src/components/ChatInterface.jsx' },
                state: 'result',
                result: 'file contents',
              },
            },
          ]}
        />
      </PanelProvider>,
    );

    expect(screen.getAllByText('Reading file')).toHaveLength(1);
    expect(screen.getAllByText('src/components/ChatInterface.jsx')).toHaveLength(1);
  });

  it('shows read_repo_file failures instead of hiding them behind a successful read state', () => {
    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-2',
            conversationId: 'conv-1',
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
          }}
          parts={[
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'read-2',
                toolName: 'read_repo_file',
                args: { path: 'main.py' },
                state: 'result',
                result: 'Error: `main.py` is not present in the selected repository. Possible matches:\n- src/App.tsx',
              },
            },
          ]}
        />
      </PanelProvider>,
    );

    expect(screen.getByText('Reading file')).toBeInTheDocument();
    expect(screen.getByText(/not present in the selected repository/i)).toBeInTheDocument();
    expect(screen.getByText(/src\/App\.tsx/)).toBeInTheDocument();
  });

  it('shows live line counts and ranges for in-flight file edits', () => {
    useChangesetStore.getState().cacheRepoFile('panel-1', 'src/app.ts', ['one', 'two', 'three', 'four'].join('\n'));

    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-3',
            conversationId: 'conv-1',
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
          }}
          parts={[
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'edit-1',
                toolName: 'edit_repo_file',
                args: {
                  path: 'src/app.ts',
                  content: ['one', 'updated two', 'updated three', 'four'].join('\n'),
                },
                state: 'call',
              },
            },
          ]}
        />
      </PanelProvider>,
    );

    expect(screen.getByText('Editing file')).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getByText('2 lines')).toBeInTheDocument();
    expect(screen.getByText('L2-L3')).toBeInTheDocument();
  });

  it('renders completed file edit previews with the shared editor shell header', () => {
    useChangesetStore.getState().cacheRepoFile('panel-1', 'src/app.ts', ['one', 'two'].join('\n'));
    useChangesetStore.getState().addChange('panel-1', {
      path: 'src/app.ts',
      action: 'edit',
      content: ['one', 'updated two'].join('\n'),
      originalContent: ['one', 'two'].join('\n'),
      staged: true,
    });

    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-7',
            conversationId: 'conv-1',
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
          }}
          parts={[
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'edit-2',
                toolName: 'edit_repo_file',
                args: {
                  path: 'src/app.ts',
                  content: ['one', 'updated two'].join('\n'),
                },
                state: 'result',
                result: 'Staged edit to src/app.ts',
              },
            },
          ]}
        />
      </PanelProvider>,
    );

    expect(screen.getAllByText('src/app.ts').length).toBeGreaterThan(0);
    expect(screen.getByText('Modified')).toBeInTheDocument();
    expect(screen.getByText('2 lines')).toBeInTheDocument();
  });

  it('shows added and removed counts for same-length staged edits', () => {
    useChangesetStore.getState().cacheRepoFile('panel-1', 'src/app.ts', ['one', 'two'].join('\n'));
    useChangesetStore.getState().addChange('panel-1', {
      path: 'src/app.ts',
      action: 'edit',
      content: ['one updated', 'two updated'].join('\n'),
      originalContent: ['one', 'two'].join('\n'),
      staged: true,
    });

    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-7b',
            conversationId: 'conv-1',
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
          }}
          parts={[
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'edit-2b',
                toolName: 'edit_repo_file',
                args: {
                  path: 'src/app.ts',
                  content: ['one updated', 'two updated'].join('\n'),
                },
                state: 'result',
                result: 'Staged edit to src/app.ts',
              },
            },
          ]}
        />
      </PanelProvider>,
    );

    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText('-2')).toBeInTheDocument();
  });

  it('shows explicit progress feedback for in-flight file reads', () => {
    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-read-live',
            conversationId: 'conv-1',
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
          }}
          parts={[
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'read-live-1',
                toolName: 'read_repo_file',
                args: { path: 'src/components/chat/ChatArea.tsx' },
                state: 'call',
              },
            },
          ]}
        />
      </PanelProvider>,
    );

    expect(screen.getByText('Reading file')).toBeInTheDocument();
    expect(screen.getByText('src/components/chat/ChatArea.tsx')).toBeInTheDocument();
    expect(screen.getByText('Reading...')).toBeInTheDocument();
  });

  it('renders Hermes tool activity through inline tool rows instead of a separate agent activity card', () => {
    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-4',
            conversationId: 'conv-1',
            role: 'assistant',
            content: '\n\n> **Reading file** — `src/app.ts`\n\n> *Done — read 123 chars*\n\nSummary complete.',
            timestamp: new Date().toISOString(),
          }}
          toolActivity={[
            {
              tool: 'read_repo_file',
              status: 'completed',
              input: '{"path":"src/app.ts"}',
              output: 'export const value = 1;',
            },
          ]}
        />
      </PanelProvider>,
    );

    expect(screen.getByText('Reading file')).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getByText('Summary complete.')).toBeInTheDocument();
    expect(screen.queryByText('Agent Activity')).not.toBeInTheDocument();
    expect(screen.queryByText(/Done — read 123 chars/i)).not.toBeInTheDocument();
  });

  it('shows a multi-file edit summary when Hermes activity does not include per-file inputs', () => {
    useChangesetStore.getState().addChange('panel-1', {
      path: 'client/src/components/KanbanBoard.tsx',
      action: 'edit',
      content: 'new board',
      originalContent: 'old board',
      staged: true,
    });
    useChangesetStore.getState().addChange('panel-1', {
      path: 'client/src/components/BoardCard.tsx',
      action: 'edit',
      content: 'new card',
      originalContent: 'old card',
      staged: true,
    });

    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-multi-edit',
            conversationId: 'conv-1',
            role: 'assistant',
            content: 'I updated the board UI while keeping the existing behavior intact.',
            timestamp: new Date().toISOString(),
          }}
          toolActivity={[
            {
              tool: 'edit_repo_file',
              status: 'completed',
              input: '',
              output: null,
            },
          ]}
        />
      </PanelProvider>,
    );

    expect(screen.getByText('Editing 2 files')).toBeInTheDocument();
    expect(screen.getAllByText('client/src/components/KanbanBoard.tsx').length).toBeGreaterThan(0);
    expect(screen.getAllByText('client/src/components/BoardCard.tsx').length).toBeGreaterThan(0);
  });

  it('strips leaked Hermes blockquote status lines while keeping the real assistant summary', () => {
    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-activity-leak',
            conversationId: 'conv-1',
            role: 'assistant',
            content: [
              '> “Reading file”',
              '',
              '> “Done — read 58 chars”',
              '',
              '> “Thinking...”',
              '',
              'I found the relevant layout shell and I am ready to apply the simplification.',
            ].join('\n'),
            timestamp: new Date().toISOString(),
          }}
        />
      </PanelProvider>,
    );

    expect(screen.queryByText(/^Reading file$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Done — read 58 chars/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Thinking/i)).not.toBeInTheDocument();
    expect(screen.getByText(/I found the relevant layout shell/i)).toBeInTheDocument();
  });

  it('strips leaked malformed repo payload blobs from assistant text parts', () => {
    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-part-payload-leak',
            conversationId: 'conv-1',
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
          }}
          parts={[
            {
              type: 'text',
              text: [
                '> “Thinking...”',
                '',
                '> “Reading file”',
                '',
                `I can't help with that.`,
                '',
                '<p>[',
                '{',
                `"parameters":  from 'recharts';\\n\\nconst MetricsDashboard = () => {\\n  return (\\n    &lt;div className="metrics-dashboard"&gt;\\n      &lt;h2&gt;Metrics Dashboard&lt;/h2&gt;\\n    &lt;/div&gt;\\n  );\\n};\\n\\nexport default MetricsDashboard;",`,
                `"description": "Update metrics dashboard to use modern charts and layout"`,
                '}',
                ']</p>',
              ].join('\n'),
            },
          ]}
        />
      </PanelProvider>,
    );

    expect(screen.queryByText(/^Thinking/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Reading file$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/MetricsDashboard/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Update metrics dashboard to use modern charts/i)).not.toBeInTheDocument();
    expect(screen.getByText(`I can't help with that.`)).toBeInTheDocument();
  });

  it('renders a shimmering in-progress shell for active repo tool rows', () => {
    const { container } = render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-read-glimmer',
            conversationId: 'conv-1',
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
          }}
          parts={[
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'read-glimmer-1',
                toolName: 'read_repo_file',
                args: { path: 'src/components/chat/ChatArea.tsx' },
                state: 'call',
              },
            },
          ]}
        />
      </PanelProvider>,
    );

    expect(container.querySelector('.chat-tool-glimmer')).not.toBeNull();
    expect(screen.getByText('Reading...')).toBeInTheDocument();
  });

  it('renders pseudo repo tool rows from assistant text parts when message content is empty', () => {
    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-5',
            conversationId: 'conv-1',
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
          }}
          parts={[
            {
              type: 'text',
              text: `Applying the approved changes now.

[edit_repo_file(path="src/app.ts", content="export const updated = true;")]

The changes are staged for review.`,
            },
          ]}
        />
      </PanelProvider>,
    );

    expect(screen.getByText('Editing file')).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getByText(/Applying the approved changes now\./)).toBeInTheDocument();
    expect(screen.getByText(/The changes are staged for review\./)).toBeInTheDocument();
    expect(screen.queryByText(/edit_repo_file/)).not.toBeInTheDocument();
  });

  it('renders synthesized repo edit rows from plain text file dumps even when local file tools were used', () => {
    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-6',
            conversationId: 'conv-1',
            role: 'assistant',
            content: `Here are the updated files:

\`index.html\`
\`\`\`html
<main>Updated</main>
\`\`\``,
            timestamp: new Date().toISOString(),
          }}
          toolInvocations={[
            {
              toolCallId: 'read-local-1',
              toolName: 'read_file',
              args: { path: 'index.html' },
              state: 'result',
              result: '<main>Old</main>',
            },
          ]}
        />
      </PanelProvider>,
    );

    expect(screen.getByText('Editing file')).toBeInTheDocument();
    expect(screen.getAllByText('index.html').length).toBeGreaterThan(0);
    expect(screen.getByText(/Here are the updated files:/i)).toBeInTheDocument();
  });
});

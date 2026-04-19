import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('interleaves tools with text via Hermes markers for hydrated messages that have parts + flat toolInvocations', () => {
    // Regression: hydrated Hermes conversations were stored as
    //   parts: [{ type: 'text', text: '…markers…summary' }]
    //   toolInvocations: [tool1, tool2]
    // ChatArea merges toolInvocations into parts at the end, so parts became
    // [text, tool1, tool2] and MessageBubble rendered all tools at the bottom.
    // With marker-based interleaving running first, each tool lands next to
    // its corresponding marker and the final summary stays at the end.
    const rawContent = [
      'Here is what I found.',
      '',
      '> **Reading file** — `src/a.ts`',
      '',
      '> *Done — read 10 chars*',
      '',
      'Now checking b.',
      '',
      '> **Reading file** — `src/b.ts`',
      '',
      '> *Done — read 20 chars*',
      '',
      'Both files look correct.',
    ].join('\n');

    const { container } = render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-hermes-hydrated',
            conversationId: 'conv-1',
            role: 'assistant',
            content: rawContent,
            timestamp: new Date().toISOString(),
          }}
          parts={[
            { type: 'text', text: rawContent },
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'activity-0',
                toolName: 'read_repo_file',
                args: { path: 'src/a.ts' },
                state: 'result',
                result: { output: 'aaa' },
              },
            },
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'activity-1',
                toolName: 'read_repo_file',
                args: { path: 'src/b.ts' },
                state: 'result',
                result: { output: 'bbbbbbbbbb' },
              },
            },
          ]}
          toolInvocations={[
            {
              toolCallId: 'activity-0',
              toolName: 'read_repo_file',
              args: { path: 'src/a.ts' },
              state: 'result',
              result: { output: 'aaa' },
            },
            {
              toolCallId: 'activity-1',
              toolName: 'read_repo_file',
              args: { path: 'src/b.ts' },
              state: 'result',
              result: { output: 'bbbbbbbbbb' },
            },
          ]}
        />
      </PanelProvider>,
    );

    // Both tool rows render
    expect(screen.getAllByText('Reading file')).toHaveLength(2);
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();

    // Summary text stays intact
    expect(screen.getByText(/Both files look correct\./)).toBeInTheDocument();

    // Order check: first tool appears before the "Now checking b." text,
    // which appears before the second tool, which appears before the final
    // summary.  If tools were coagulating at the bottom, tool A and B would
    // both sit after "Both files look correct." in DOM order.
    const text = container.textContent ?? '';
    const idxA = text.indexOf('src/a.ts');
    const idxMid = text.indexOf('Now checking b.');
    const idxB = text.indexOf('src/b.ts');
    const idxEnd = text.indexOf('Both files look correct.');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxMid).toBeGreaterThan(idxA);
    expect(idxB).toBeGreaterThan(idxMid);
    expect(idxEnd).toBeGreaterThan(idxB);
  });

  it('interleaves tools using textOffset for hydrated messages without marker text', () => {
    // Content WITHOUT marker text — simulates a case where markers were
    // stripped or never present, but textOffset is available from persistence.
    const rawContent = 'Here is what I found.\n\nNow checking b.\n\nBoth files look correct.';

    // textOffsets: tool A was emitted right after "Here is what I found.\n\n" (offset 23)
    // tool B was emitted right after "Now checking b.\n\n" (offset 40)
    const { container } = render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-offset-hydrated',
            conversationId: 'conv-1',
            role: 'assistant',
            content: rawContent,
            timestamp: new Date().toISOString(),
          }}
          parts={[
            { type: 'text', text: rawContent },
          ]}
          toolInvocations={[
            {
              toolCallId: 'activity-0',
              toolName: 'read_repo_file',
              args: { path: 'src/a.ts' },
              state: 'result',
              result: { output: 'aaa' },
              textOffset: 23,
            },
            {
              toolCallId: 'activity-1',
              toolName: 'read_repo_file',
              args: { path: 'src/b.ts' },
              state: 'result',
              result: { output: 'bbbbbbbbbb' },
              textOffset: 40,
            },
          ]}
        />
      </PanelProvider>,
    );

    // Both tool rows render
    expect(screen.getAllByText('Reading file')).toHaveLength(2);
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();

    // Order check: tool A before "Now checking b.", tool B before "Both files look correct."
    const text = container.textContent ?? '';
    const idxA = text.indexOf('src/a.ts');
    const idxMid = text.indexOf('Now checking b.');
    const idxB = text.indexOf('src/b.ts');
    const idxEnd = text.indexOf('Both files look correct.');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxMid).toBeGreaterThan(idxA);
    expect(idxB).toBeGreaterThan(idxMid);
    expect(idxEnd).toBeGreaterThan(idxB);
  });

  it('renders execution output when tool activity stores it under result.output', () => {
    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-command-output',
            conversationId: 'conv-1',
            role: 'assistant',
            content: 'Build complete.',
            timestamp: new Date().toISOString(),
          }}
          toolActivity={[
            {
              tool: 'run_command',
              status: 'completed',
              input: '{"command":"npm run lint"}',
              output: 'Lint passed',
            },
          ]}
        />
      </PanelProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Output' }));

    expect(screen.getByText('Running command')).toBeInTheDocument();
    expect(screen.getByText('Lint passed')).toBeInTheDocument();
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

  it('focuses the first file with a glimmer row while a Hermes batch edit is still running', () => {
    useChangesetStore.getState().cacheRepoFile('panel-1', 'client/src/components/KanbanBoard.tsx', ['old board line 1', 'old board line 2'].join('\n'));

    const { container } = render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-batch-edit-running',
            conversationId: 'conv-1',
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
          }}
          parts={[
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'batch-edit-1',
                toolName: 'batch_edit_repo_files',
                args: {
                  changes: [
                    {
                      path: 'client/src/components/KanbanBoard.tsx',
                      action: 'edit',
                      content: ['new board line 1', 'new board line 2'].join('\n'),
                    },
                    {
                      path: 'client/src/components/BoardCard.tsx',
                      action: 'edit',
                      content: 'new card',
                    },
                  ],
                },
                state: 'call',
              },
            },
          ]}
        />
      </PanelProvider>,
    );

    expect(container.querySelector('.chat-tool-glimmer')).not.toBeNull();
    expect(screen.getByText('Editing file')).toBeInTheDocument();
    expect(screen.getByText('client/src/components/KanbanBoard.tsx')).toBeInTheDocument();
    expect(screen.getByText('+1 more queued')).toBeInTheDocument();
    expect(screen.getByText('2 lines')).toBeInTheDocument();
    expect(screen.queryByText('Editing 2 files')).not.toBeInTheDocument();
    expect(screen.queryByText('client/src/components/BoardCard.tsx')).not.toBeInTheDocument();
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
              '> “Editing files” — `src/chat.tsx`, `src/MessageBubble.tsx`',
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
    expect(screen.queryByText(/^Editing files$/i)).not.toBeInTheDocument();
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

  it('suppresses pseudo repo write rows when the surrounding turn is read-only', () => {
    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-read-only-pseudo-edit',
            conversationId: 'conv-1',
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
          }}
          parts={[
            {
              type: 'text',
              text: `Here is an example patch you could apply:

[edit_repo_file(path="src/app.ts", content="export const updated = true;")]

I did not change the repository.`,
            },
          ]}
          allowPseudoRepoWrites={false}
        />
      </PanelProvider>,
    );

    expect(screen.queryByText('Editing file')).not.toBeInTheDocument();
    expect(screen.queryByText('src/app.ts')).not.toBeInTheDocument();
    expect(screen.getByText(/Here is an example patch you could apply:/i)).toBeInTheDocument();
    expect(screen.getByText(/I did not change the repository\./i)).toBeInTheDocument();
  });

  it('renders wrapped JSON repo payload leaks as tool rows instead of raw arrays', () => {
    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-json-wrapper-leak',
            conversationId: 'conv-1',
            role: 'assistant',
            content: `The changes have been successfully applied to the repository.

The optimized code for \`KanbanBoard.tsx\`, \`cards.ts\`, and \`gateway-client.ts\` has been updated.

[ { "parameters": { "path": "client/src/components/KanbanBoard.tsx" } }, { "parameters": { "path": "server/src/routes/cards.ts" } }, { "parameters": { "path": "server/src/services/gateway-client.ts" } } ]

[ { "parameters": { "changes": [ { "path": "client/src/components/KanbanBoard.tsx", "action": "edit", "content": "import { useState } from 'react';", "description": "Optimized KanbanBoard.tsx for better performance" }, { "path": "server/src/routes/cards.ts", "action": "edit", "content": "import { Router } from 'express';", "description": "Optimized cards.ts for better error handling" }, { "path": "server/src/services/gateway-client.ts", "action": "edit", "content": "import WebSocket from 'ws';", "description": "Optimized gateway-client.ts for better WebSocket connection management" } ] } } ]`,
            timestamp: new Date().toISOString(),
          }}
        />
      </PanelProvider>,
    );

    expect(screen.getByText(/The changes have been successfully applied to the repository\./)).toBeInTheDocument();
    expect(screen.getAllByText('Reading file').length).toBeGreaterThan(0);
    expect(screen.getAllByText('client/src/components/KanbanBoard.tsx').length).toBeGreaterThan(0);
    expect(screen.getAllByText('server/src/routes/cards.ts').length).toBeGreaterThan(0);
    expect(screen.getAllByText('server/src/services/gateway-client.ts').length).toBeGreaterThan(0);
    expect(screen.getByText('Editing 3 files')).toBeInTheDocument();
    expect(screen.queryByText(/"parameters"/)).not.toBeInTheDocument();
  });

  it('renders direct tool invocations even when the message only has step marker parts', () => {
    render(
      <PanelProvider value="panel-1">
        <MessageBubble
          message={{
            id: 'assistant-step-only-tools',
            conversationId: 'conv-1',
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
          }}
          parts={[
            {
              type: 'step-start',
            },
          ]}
          toolInvocations={[
            {
              toolCallId: 'server-read-1',
              toolName: 'read_repo_file',
              args: { path: 'src/components/chat/ChatArea.tsx' },
              state: 'result',
              result: 'export function ChatArea() {}',
            },
          ]}
        />
      </PanelProvider>,
    );

    expect(screen.getByText('Reading file')).toBeInTheDocument();
    expect(screen.getByText('src/components/chat/ChatArea.tsx')).toBeInTheDocument();
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

import { describe, expect, it } from 'vitest';
import {
  findPendingProposal,
  getProposalDigest,
  hasRepoContinuationAfterProposal,
} from '@/lib/proposed-changes';

describe('findPendingProposal', () => {
  it('detects a pending proposal from tool invocation data', () => {
    const proposal = findPendingProposal([
      { id: 'user-1', role: 'user', content: 'Update the UI' },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '## Proposed Changes',
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              toolName: 'propose_changes',
              state: 'result',
              args: {
                summary: 'Refresh the UI shell',
                plan: [
                  {
                    path: 'src/App.tsx',
                    action: 'edit',
                    description: 'Update the layout and spacing',
                  },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(proposal?.summary).toBe('Refresh the UI shell');
    expect(proposal?.plan).toHaveLength(1);
    expect(proposal?.plan[0].path).toBe('src/App.tsx');
  });

  it('ignores proposals once a user has already replied', () => {
    const proposal = findPendingProposal([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '## Proposed Changes\n\nUse the accept button below to apply these changes.',
      },
      { id: 'user-1', role: 'user', content: 'go ahead' },
    ]);

    expect(proposal).toBeNull();
  });

  it('falls back to persisted content when tool parts are unavailable', () => {
    const proposal = findPendingProposal([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '## Proposed Changes\n\nRefresh the navigation shell.\n\nUse the accept button below to apply these changes, or tell me what to adjust.',
      },
    ]);

    expect(proposal?.messageId).toBe('assistant-1');
    expect(proposal?.excerpt).toContain('Refresh the navigation shell');
  });

  it('detects a pending proposal from Hermes proposal copy without structured tool data', () => {
    const proposal = findPendingProposal([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: `To update the UI, I'll review the repo first.

Here's a proposal to update the UI:

Refresh the navigation shell and tighten the composer spacing.`,
      },
    ]);

    expect(proposal?.messageId).toBe('assistant-1');
    expect(proposal?.excerpt).toContain('To update the UI');
  });

  it('reads proposal copy from assistant text parts when message content is empty', () => {
    const proposal = findPendingProposal([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'text',
            text: `To update the UI, I'll inspect the current layout first.

Here's a proposal to update the UI:

Refresh the navigation shell and tighten the composer spacing.`,
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
    ]);

    expect(proposal?.messageId).toBe('assistant-1');
    expect(proposal?.summary).toContain("I'll inspect the current layout first");
  });

  it('detects a pending proposal from Hermes pseudo tool syntax', () => {
    const proposal = findPendingProposal([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: `Here is the proposed change plan:

[propose_changes(summary="Refresh the navigation shell", plan=[{"path":"src/App.tsx","action":"edit","description":"Update the layout shell"}])]

Use the accept button below to apply these changes.`,
      },
    ]);

    expect(proposal?.summary).toBe('Refresh the navigation shell');
    expect(proposal?.plan).toHaveLength(1);
    expect(proposal?.plan[0].path).toBe('src/App.tsx');
  });

  it('detects a pending proposal from a Hermes tool invocation with missing args', () => {
    const proposal = findPendingProposal([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: `To update the UI, I'll need to examine the repository first.

Here's a proposed plan to move the interface forward.`,
        toolInvocations: [
          {
            toolName: 'propose_changes',
            state: 'result',
            args: {},
          },
        ],
      },
    ]);

    expect(proposal?.messageId).toBe('assistant-1');
    expect(proposal?.summary).toContain("I'll need to examine the repository first");
    expect(proposal?.plan).toEqual([]);
  });

  it('changes the proposal digest when assistant text parts mutate in place', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        parts: [
          { type: 'text', text: 'Need more UI details first.' },
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
    ];

    const before = getProposalDigest(messages);
    messages[0].parts![0].text = `Let's assume you're looking for a general UI refresh.

Here's a proposal to update the UI.`;
    const after = getProposalDigest(messages);

    expect(after).not.toBe(before);
  });

  it('reports repo continuation after a proposal when repo tools run later', () => {
    const messages = [
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
    ];

    expect(hasRepoContinuationAfterProposal(messages, 'assistant-1')).toBe(true);
  });

  it('ignores proposals that were auto-approved in the assistant response', () => {
    const proposal = findPendingProposal([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '## Proposed Changes\n\nRefresh the navigation shell.\n\nAuto-approved. Proceeding with the requested changes now.',
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              toolName: 'propose_changes',
              state: 'result',
              args: {
                summary: 'Refresh the UI shell',
                plan: [
                  {
                    path: 'src/App.tsx',
                    action: 'edit',
                    description: 'Update the layout and spacing',
                  },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(proposal).toBeNull();
  });
});

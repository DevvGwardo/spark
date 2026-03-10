import { describe, expect, it } from 'vitest';
import { findPendingProposal } from '@/lib/proposed-changes';

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

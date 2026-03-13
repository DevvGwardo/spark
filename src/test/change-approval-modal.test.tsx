import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChangeApprovalModal } from '@/components/chat/ChangeApprovalModal';

describe('ChangeApprovalModal', () => {
  it('renders a compact approval banner with actions', () => {
    render(
      <ChangeApprovalModal
        open
        onOpenChange={() => {}}
        proposal={{
          messageId: 'assistant-1',
          summary: 'Refresh the navigation shell',
          excerpt: 'Tighten the layout and update the header treatment.',
          plan: [
            {
              path: 'src/App.tsx',
              action: 'edit',
              description: 'Update the chat layout shell.',
            },
          ],
        }}
        onAccept={vi.fn()}
        onAcceptAlways={vi.fn()}
      />,
    );

    expect(screen.getByTestId('change-approval-banner')).toBeInTheDocument();
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Allow all')).toBeInTheDocument();
    expect(screen.getByText('src/App.tsx')).toBeInTheDocument();
  });
});

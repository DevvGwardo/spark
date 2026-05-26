
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChangeApprovalModal } from '@/components/chat/ChangeApprovalModal';

const baseProposal = {
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
};

describe('ChangeApprovalModal', () => {
  it('renders a compact approval banner with actions', () => {
    render(
      <ChangeApprovalModal
        open
        onOpenChange={() => {}}
        proposal={baseProposal}
        onApproveOnce={vi.fn()}
        onApproveSession={vi.fn()}
        onApproveAlways={vi.fn()}
      />,
    );

    expect(screen.getByTestId('change-approval-banner')).toBeInTheDocument();
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Approve for session')).toBeInTheDocument();
    expect(screen.getByText('Allow all')).toBeInTheDocument();
    expect(screen.getByText('src/App.tsx')).toBeInTheDocument();
  });

  it('fires the matching handler for each approval scope', () => {
    const onApproveOnce = vi.fn();
    const onApproveSession = vi.fn();
    const onApproveAlways = vi.fn();

    render(
      <ChangeApprovalModal
        open
        onOpenChange={() => {}}
        proposal={baseProposal}
        onApproveOnce={onApproveOnce}
        onApproveSession={onApproveSession}
        onApproveAlways={onApproveAlways}
      />,
    );

    fireEvent.click(screen.getByText('Approve'));
    expect(onApproveOnce).toHaveBeenCalledTimes(1);
    expect(onApproveSession).not.toHaveBeenCalled();
    expect(onApproveAlways).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Approve for session'));
    expect(onApproveSession).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Allow all'));
    expect(onApproveAlways).toHaveBeenCalledTimes(1);

    expect(onApproveOnce).toHaveBeenCalledTimes(1);
    expect(onApproveSession).toHaveBeenCalledTimes(1);
  });
});

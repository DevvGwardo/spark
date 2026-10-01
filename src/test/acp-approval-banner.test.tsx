import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpApprovalBanner } from '@/components/chat/AcpApprovalBanner';
import { useHermesStore } from '@/stores/hermes-store';
import type { AcpApprovalRequest } from '@/lib/hermes-api';

vi.mock('@/lib/hermes-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hermes-api')>();
  return {
    ...actual,
    postServerApproval: vi.fn(async () => ({ ok: true })),
    postAcpApproval: vi.fn(async () => ({ ok: true })),
  };
});

import { postAcpApproval, postServerApproval } from '@/lib/hermes-api';

const legacyPayload = (overrides: Partial<AcpApprovalRequest> = {}): AcpApprovalRequest => ({
  approval_id: 'acp-1',
  session_id: 'sess-1',
  tool: 'edit_file',
  kind: 'file_edit',
  summary: 'Edit src/App.tsx',
  ...overrides,
});

function seedApproval(approval: AcpApprovalRequest) {
  useHermesStore.setState((state) => ({
    pendingAcpApprovals: { ...state.pendingAcpApprovals, [approval.approval_id]: approval },
  }));
}

describe('AcpApprovalBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useHermesStore.setState({ pendingAcpApprovals: {}, requestChatAction: vi.fn() });
  });

  it('renders nothing without a pending approval', () => {
    const { container } = render(<AcpApprovalBanner />);
    expect(container.querySelector('[data-testid="acp-approval-banner"]')).toBeNull();
  });

  it('clamps legacy ACP payloads to once/deny — no session or always buttons', () => {
    // Legacy payloads carry no available_decisions, and hermes-agent only
    // accepts allow_once/deny; offering session/always caused silent denials.
    seedApproval(legacyPayload({ command: 'git push origin main' }));
    render(<AcpApprovalBanner />);

    expect(screen.getByTestId('acp-approval-banner')).toBeInTheDocument();
    expect(screen.getByText('Approve once')).toBeInTheDocument();
    expect(screen.getByText('Deny')).toBeInTheDocument();
    expect(screen.queryByText('Approve for session')).toBeNull();
    expect(screen.queryByText('Always for prefix')).toBeNull();
  });

  it('sends allow_once for a legacy approve and deny for a legacy deny', async () => {
    seedApproval(legacyPayload());
    render(<AcpApprovalBanner />);

    fireEvent.click(screen.getByText('Approve once'));
    await waitFor(() => expect(postAcpApproval).toHaveBeenCalledWith('acp-1', 'allow_once'));
    await waitFor(() =>
      expect(useHermesStore.getState().pendingAcpApprovals['acp-1']).toBeUndefined(),
    );

    seedApproval(legacyPayload({ approval_id: 'acp-2' }));
    fireEvent.click(await screen.findByText('Deny'));
    await waitFor(() => expect(postAcpApproval).toHaveBeenCalledWith('acp-2', 'deny'));
  });

  it('resolves through the single server route — server errors surface, no direct-bridge fallback', async () => {
    // The merged /api/hermes/approvals/:id handles acp-* ids itself, so a
    // rejection is terminal: the banner shows the error and keeps the
    // approval pending instead of retrying against the bridge directly.
    seedApproval(legacyPayload());
    const { HermesApiError } = await import('@/lib/hermes-api');
    vi.mocked(postAcpApproval).mockRejectedValueOnce(new HermesApiError('unknown approval', 404));
    render(<AcpApprovalBanner />);

    fireEvent.click(screen.getByText('Approve once'));
    await waitFor(() => expect(screen.getByText('unknown approval')).toBeInTheDocument());
    expect(useHermesStore.getState().pendingAcpApprovals['acp-1']).toBeDefined();
  });

  it('sends unified ladder decisions through postServerApproval', async () => {
    seedApproval(
      legacyPayload({
        approval_id: 'acp-u2',
        available_decisions: ['approved', 'approved_for_session', 'denied'] as never,
      }),
    );
    render(<AcpApprovalBanner />);

    fireEvent.click(screen.getByText('Approve for session'));
    await waitFor(() =>
      expect(postServerApproval).toHaveBeenCalledWith('acp-u2', 'approved_for_session', undefined),
    );
    await waitFor(() =>
      expect(useHermesStore.getState().pendingAcpApprovals['acp-u2']).toBeUndefined(),
    );
  });

  it('queues concurrent approvals instead of clobbering the first', async () => {
    seedApproval(legacyPayload({ approval_id: 'acp-a', summary: 'First edit' }));
    seedApproval(legacyPayload({ approval_id: 'acp-b', summary: 'Second edit' }));
    render(<AcpApprovalBanner />);

    // Oldest first, keyed insert order preserved for string keys.
    expect(screen.getByText('First edit')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Approve once'));
    await waitFor(() => expect(screen.getByText('Second edit')).toBeInTheDocument());
    expect(screen.queryByText('First edit')).toBeNull();

    fireEvent.click(screen.getByText('Approve once'));
    await waitFor(() => expect(postAcpApproval).toHaveBeenNthCalledWith(2, 'acp-b', 'allow_once'));
    await waitFor(() => expect(screen.queryByTestId('acp-approval-banner')).toBeNull());
  });

  it('shows the unified ladder buttons when available_decisions is present', () => {
    seedApproval(
      legacyPayload({
        approval_id: 'acp-u',
        available_decisions: ['approved', 'approved_for_session', 'denied'] as never,
      }),
    );
    render(<AcpApprovalBanner />);

    expect(screen.getByText('Approve once')).toBeInTheDocument();
    expect(screen.getByText('Approve for session')).toBeInTheDocument();
  });
});

describe('AcpApprovalBanner accessibility (spec 6.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useHermesStore.setState({ pendingAcpApprovals: {}, requestChatAction: vi.fn() });
  });

  it('exposes a labelled region with an assertive alert and a labelled decision group', () => {
    seedApproval(legacyPayload({ command: 'git push origin main' }));
    render(<AcpApprovalBanner />);

    const region = screen.getByRole('region', { name: 'Approval required' });
    expect(region).toHaveAccessibleDescription('Edit src/App.tsx');

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert).toHaveAttribute('aria-atomic', 'true');
    expect(alert).toHaveTextContent('Approval required');
    expect(alert).toHaveTextContent('Edit src/App.tsx');

    const group = screen.getByRole('group', { name: 'Approval decision' });
    expect(group).toContainElement(screen.getByRole('button', { name: 'Approve once: edit_file' }));
    expect(group).toContainElement(screen.getByRole('button', { name: 'Deny: edit_file' }));
  });

  it('gives every ladder button an accessible name that starts with its visible label', () => {
    seedApproval(
      legacyPayload({
        approval_id: 'acp-u',
        tool: 'terminal',
        command: 'npm run build --watch',
        available_decisions: ['approved', 'approved_for_session', 'denied'] as never,
      }),
    );
    render(<AcpApprovalBanner />);

    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Approve once: terminal',
      'Approve for session: terminal',
      'Always for prefix npm run',
      'Deny: terminal',
    ]);
    for (const button of buttons) {
      // WCAG 2.5.3: the accessible name contains the visible label.
      expect(button.getAttribute('aria-label')!.startsWith(button.textContent!)).toBe(true);
      expect(button.className).toContain('focus-visible:ring-2');
    }
    // The decorative icon is hidden from assistive tech.
    expect(screen.getByTestId('acp-approval-banner').querySelector('svg')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('focuses the first action when a request appears, once per request', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    seedApproval(legacyPayload());
    const { rerender } = render(<AcpApprovalBanner />);
    expect(screen.getByRole('button', { name: 'Approve once: edit_file' })).toHaveFocus();

    // The user moves to Deny; re-renders for the same request must not pull
    // focus back to the first action.
    const deny = screen.getByRole('button', { name: 'Deny: edit_file' });
    deny.focus();
    rerender(<AcpApprovalBanner />);
    act(() => {
      useHermesStore.setState((state) => ({ pendingAcpApprovals: { ...state.pendingAcpApprovals } }));
    });
    expect(deny).toHaveFocus();
    trigger.remove();
  });

  it('does not steal focus from the composer while the user is typing', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    seedApproval(legacyPayload());
    render(<AcpApprovalBanner />);

    // Still announced, but a stray Space/Enter cannot approve the tool call.
    expect(screen.getByRole('alert')).toHaveTextContent('Edit src/App.tsx');
    expect(textarea).toHaveFocus();
    textarea.remove();
  });

  it('moves focus to the next queued request and restores focus when the queue drains', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    seedApproval(legacyPayload({ approval_id: 'acp-a', summary: 'First edit' }));
    seedApproval(legacyPayload({ approval_id: 'acp-b', summary: 'Second edit' }));
    render(<AcpApprovalBanner />);
    expect(screen.getByRole('button', { name: 'Approve once: edit_file' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Approve once: edit_file' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Second edit'));
    expect(screen.getByRole('button', { name: 'Approve once: edit_file' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Approve once: edit_file' }));
    await waitFor(() => expect(screen.queryByTestId('acp-approval-banner')).toBeNull());
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('keeps focus on the pressed button while a decision is in flight and ignores repeat presses', async () => {
    let resolve!: () => void;
    vi.mocked(postAcpApproval).mockImplementationOnce(
      () => new Promise((r) => { resolve = () => r({ ok: true } as never); }),
    );
    seedApproval(legacyPayload());
    render(<AcpApprovalBanner />);

    const approve = screen.getByRole('button', { name: 'Approve once: edit_file' });
    fireEvent.click(approve);
    await waitFor(() => expect(approve).toHaveAttribute('aria-disabled', 'true'));
    expect(approve).not.toBeDisabled();
    expect(approve).toHaveFocus();
    expect(screen.getByTestId('acp-approval-banner')).toHaveAttribute('aria-busy', 'true');

    fireEvent.click(approve);
    fireEvent.click(screen.getByRole('button', { name: 'Deny: edit_file' }));
    expect(postAcpApproval).toHaveBeenCalledTimes(1);

    await act(async () => resolve());
    await waitFor(() => expect(screen.queryByTestId('acp-approval-banner')).toBeNull());
  });

  it('announces a failed decision as an alert', async () => {
    vi.mocked(postAcpApproval).mockRejectedValueOnce(new Error('bridge offline'));
    seedApproval(legacyPayload());
    render(<AcpApprovalBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve once: edit_file' }));
    await waitFor(() =>
      expect(screen.getAllByRole('alert').some((el) => el.textContent === 'bridge offline')).toBe(true),
    );
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    postBridgeAcpApprovalDirect: vi.fn(async () => true),
  };
});

import { postAcpApproval, postBridgeAcpApprovalDirect } from '@/lib/hermes-api';

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

  it('falls back to the direct bridge path when the server route rejects', async () => {
    seedApproval(legacyPayload());
    const { HermesApiError } = await import('@/lib/hermes-api');
    vi.mocked(postAcpApproval).mockRejectedValueOnce(new HermesApiError('unknown approval', 404));
    render(<AcpApprovalBanner />);

    fireEvent.click(screen.getByText('Approve once'));
    await waitFor(() => expect(postBridgeAcpApprovalDirect).toHaveBeenCalledWith('acp-1', 'approved'));
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

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpApprovalBanner } from '@/components/chat/AcpApprovalBanner';
import { ChatInput } from '@/components/chat/ChatInput';
import {
  formatHermesTransportStatus,
  parseHermesTransportCapabilities,
  parseHermesTransportStatusDelta,
} from '@/hooks/chat-utils';
import { useHermesStore, type HermesTransportCapabilities } from '@/stores/hermes-store';
import type { AcpApprovalRequest } from '@/lib/hermes-api';

/**
 * Hardening spec 4.8: the bridge's transport_status carries the serving
 * transport's capability row, and the chat UI only offers what that transport
 * can honor.
 */

const ALL: HermesTransportCapabilities = {
  approvals: true,
  cancel: true,
  stopsOnClientDisconnect: true,
  usageInStream: true,
  sessionResume: true,
};

const wireRow = {
  approvals: true,
  cancel: false,
  stops_on_client_disconnect: true,
  usage_in_stream: true,
  session_resume: false,
};

function setCaps(caps: HermesTransportCapabilities | null) {
  useHermesStore.getState().setTransportCapabilities('default', caps);
}

beforeEach(() => {
  useHermesStore.setState({ transportCapabilitiesByPanel: {}, pendingAcpApprovals: {} });
});

afterEach(() => {
  cleanup();
  useHermesStore.setState({ transportCapabilitiesByPanel: {}, pendingAcpApprovals: {} });
});

describe('transport_status parsing', () => {
  it('accepts ACP and reads the capability row', () => {
    const parsed = parseHermesTransportStatusDelta({ requested: 'acp', actual: 'acp', capabilities: wireRow });
    expect(parsed).toEqual({
      requested: 'acp',
      actual: 'acp',
      capabilities: {
        approvals: true,
        cancel: false,
        stopsOnClientDisconnect: true,
        usageInStream: true,
        sessionResume: false,
      },
    });
    expect(formatHermesTransportStatus(parsed!)).toBe('Using Hermes agent (ACP).');
  });

  it('keeps the status but drops a malformed capability row (older/foreign bridges)', () => {
    const parsed = parseHermesTransportStatusDelta({
      requested: 'runs',
      actual: 'agent-loop',
      reason: 'parity',
      capabilities: { cancel: 'yes' },
    });
    expect(parsed).toEqual({ requested: 'runs', actual: 'agent-loop', reason: 'parity' });
    expect(formatHermesTransportStatus(parsed!)).toContain('Requested gateway /v1/runs; using agent loop.');
    expect(parseHermesTransportCapabilities(null)).toBeNull();
  });

  it('rejects unknown transports', () => {
    expect(parseHermesTransportStatusDelta({ requested: 'swarm', actual: 'swarm' })).toBeNull();
  });
});

describe('Stop affordance', () => {
  function renderStreaming(onStop = vi.fn()) {
    render(<ChatInput value="" onChange={() => {}} onSend={() => {}} isStreaming onStop={onStop} />);
    return onStop;
  }

  it('is offered when the transport can cancel, or when nothing is known', () => {
    renderStreaming();
    for (const button of screen.getAllByRole('button', { name: 'Stop generating' })) {
      expect(button).toBeEnabled();
    }
    cleanup();
    setCaps(ALL);
    renderStreaming();
    for (const button of screen.getAllByRole('button', { name: 'Stop generating' })) {
      expect(button).toBeEnabled();
    }
  });

  it('is disabled, with the reason, when the transport cannot cancel', () => {
    setCaps({ ...ALL, cancel: false });
    renderStreaming();
    expect(screen.queryAllByRole('button', { name: 'Stop generating' })).toHaveLength(0);
    const buttons = screen.getAllByRole('button', { name: 'Stop unavailable for this transport' });
    for (const button of buttons) {
      expect(button).toBeDisabled();
      expect(button.getAttribute('title')).toContain("can't stop");
    }
  });
});

describe('approval affordance', () => {
  const approval = (id: string): AcpApprovalRequest => ({
    approval_id: id,
    session_id: 's',
    tool: 'terminal',
    kind: 'execute',
    summary: 'Run rm -rf build',
  });

  function seed(id: string) {
    useHermesStore.setState({ pendingAcpApprovals: { [id]: approval(id) } });
  }

  it('hides a bridge prompt the serving transport says it cannot honor', () => {
    setCaps({ ...ALL, approvals: false });
    seed('bridge-1');
    const { container } = render(<AcpApprovalBanner />);
    expect(container.querySelector('[data-testid="acp-approval-banner"]')).toBeNull();
  });

  it('still shows bridge prompts on an approvals-capable transport', () => {
    setCaps(ALL);
    seed('bridge-2');
    render(<AcpApprovalBanner />);
    expect(screen.getByTestId('acp-approval-banner')).toBeInTheDocument();
  });

  it('never hides engine-local (server) approvals', () => {
    setCaps({ ...ALL, approvals: false });
    seed('local-approval-1');
    render(<AcpApprovalBanner />);
    expect(screen.getByTestId('acp-approval-banner')).toBeInTheDocument();
  });
});
